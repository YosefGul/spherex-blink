"""HTTP API and static file server for the SPHEREx blink viewer.

Run from the project root:  python -m uvicorn app:app --app-dir backend --port 8000
AI-assisted code (Claude Code).

Environment:
  SPX_CACHE_DIR   where downloaded cutouts, index answers and finished stacks are kept
                  (default: data/cache). May be lost at any time; it is only a cache.
  SPX_MAX_BUILDS  how many positions may be built from the archive at once (default 2)
  SPX_WORKERS     parallel archive reads per build (default 16)
"""
from __future__ import annotations

import base64
import os
import shutil
import threading
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import json

from spx import catalog, quality
from spx.index import age_days, query_frames, refresh_if_old
from spx.spectrum import spectrum as measure_spectrum
from spx.stack import Epoch, build, grid_pixscale, split_epochs

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("SPX_CACHE_DIR") or ROOT / "data" / "cache")
SEED = ROOT / "data" / "seed"      # shipped with the code: results for the challenge's test targets
WORKERS = int(os.environ.get("SPX_WORKERS", "16"))
STACK_VERSION = 1                  # bump when stacking changes, so old cached results are ignored
SPECTRUM_VERSION = 1               # same, for the photometry
QUALITY_VERSION = 1                # same, for the flag maps and the zodiacal model
MAX_FOV = 3600.0                   # arcsec: one degree

BANDS = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00)}

_BUILD_SLOTS = threading.BoundedSemaphore(int(os.environ.get("SPX_MAX_BUILDS", "2")))
_KEY_LOCKS: dict[str, threading.Lock] = {}
_KEY_LOCKS_GUARD = threading.Lock()

app = FastAPI(title="SPHEREx blink viewer")


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make browsers check for a newer page, script and style sheet after each deploy."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _seed_index() -> None:
    """Copy the shipped index answers into the cache so test targets skip the slow IRSA query."""
    src = SEED / "index"
    if not src.is_dir():
        return
    dst = CACHE / "index"
    dst.mkdir(parents=True, exist_ok=True)
    for f in src.glob("*.json"):
        if not (dst / f.name).exists():
            shutil.copy(f, dst / f.name)


_seed_index()


def stack_key(ra: float, dec: float, fov: float, det: int) -> str:
    return f"v{STACK_VERSION}_{ra:.4f}_{dec:+.4f}_{fov:g}_d{det}.npz"


def _load_stack(key: str, total_frames: int) -> dict | None:
    """A finished stack from the cache or the shipped seed, if it matches the current index."""
    for base in (CACHE, SEED):
        path = base / "stacks" / key
        if not path.exists():
            continue
        try:
            with np.load(path, allow_pickle=False) as z:
                if int(z["total_frames"]) != total_frames:
                    continue          # the archive has new exposures here: rebuild
                return {k: z[k] for k in ("n", "labels", "mjd", "used", "has", "cube")}
        except Exception as exc:      # a damaged cache file must not break the request
            print(f"ignoring {path}: {exc}")
    return None


def _save_stack(base: Path, key: str, total_frames: int, eps: list[Epoch], det: int, n: int) -> dict:
    imgs = [ep.stacks.get(det) for ep in eps]
    out = {
        "n": np.int32(n),
        "labels": np.array([ep.label for ep in eps]),
        "mjd": np.array([ep.mjd for ep in eps], dtype="f8"),
        "used": np.array([ep.counts.get(det, 0) for ep in eps], dtype="i4"),
        "has": np.array([im is not None for im in imgs]),
        "cube": np.array([im for im in imgs if im is not None], dtype="<f4").reshape(-1, n, n),
    }
    path = base / "stacks" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.stem}.{threading.get_ident()}.tmp.npz")
    np.savez_compressed(tmp, total_frames=np.int64(total_frames), **out)
    os.replace(tmp, path)
    return out


def get_stack(ra: float, dec: float, fov: float, det: int, save_to: Path | None = None) -> dict:
    """Stacked epochs for one detector: from cache or seed if possible, else built from the archive."""
    total = len(query_frames(ra, dec, CACHE))
    key = stack_key(ra, dec, fov, det)
    hit = _load_stack(key, total)
    if hit is not None and save_to is None:
        return hit
    with _KEY_LOCKS_GUARD:
        lock = _KEY_LOCKS.setdefault(key, threading.Lock())
    with lock:                         # identical requests wait for the first one instead of rebuilding
        hit = _load_stack(key, total)
        if hit is not None and save_to is None:
            return hit
        with _BUILD_SLOTS:
            stats: dict = {}
            eps, _, n = build(ra, dec, fov, CACHE, (det,), workers=WORKERS, stats=stats)
        if stats["failed"]:            # incomplete result: serve it, but never keep it
            print(f"{key}: {stats['failed']} exposures could not be read; result not cached")
            if save_to is not None:
                raise RuntimeError(f"{stats['failed']} exposures could not be read")
            imgs = [ep.stacks.get(det) for ep in eps]
            return {
                "n": n, "labels": [ep.label for ep in eps], "mjd": [ep.mjd for ep in eps],
                "used": [ep.counts.get(det, 0) for ep in eps], "has": [im is not None for im in imgs],
                "cube": [im for im in imgs if im is not None],
            }
        return _save_stack(save_to or CACHE, key, total, eps, det, n)


def _load_quality(key: str, total_frames: int) -> dict | None:
    for base in (CACHE, SEED):
        path = base / "quality" / key
        if not path.exists():
            continue
        try:
            with np.load(path, allow_pickle=False) as z:
                if int(z["total_frames"]) != total_frames:
                    continue
                return {k: z[k] for k in ("n", "has", "used", "zodi", "corr", "flag", "names")}
        except Exception as exc:
            print(f"ignoring {path}: {exc}")
    return None


def get_quality(ra: float, dec: float, fov: float, det: int, save_to: Path | None = None) -> dict:
    """Flag maps and zodiacal-light numbers per epoch for one detector: cached, shipped, or read from the archive."""
    total = len(query_frames(ra, dec, CACHE))
    key = f"q{QUALITY_VERSION}_{ra:.4f}_{dec:+.4f}_{fov:g}_d{det}.npz"
    hit = _load_quality(key, total)
    if hit is not None and save_to is None:
        return hit
    with _KEY_LOCKS_GUARD:
        lock = _KEY_LOCKS.setdefault(key, threading.Lock())
    with lock:
        hit = _load_quality(key, total)
        if hit is not None and save_to is None:
            return hit
        with _BUILD_SLOTS:
            stats: dict = {}
            q = quality.build(ra, dec, fov, det, CACHE, workers=WORKERS, stats=stats)
        eps = [e for e in q["epochs"] if e is not None]
        n = q["n"]
        out = {
            "n": np.int32(n),
            "has": np.array([e is not None for e in q["epochs"]]),
            "used": np.array([e["used"] for e in eps], dtype="i4"),
            "zodi": np.array([e["zodi"] for e in eps], dtype="f8"),
            "corr": np.array([e["corr"] for e in eps], dtype="f8").reshape(-1, 3, 3),
            "flag": np.array([e["flag"] for e in eps], dtype="u1").reshape(-1, n, n),
            "names": np.array([json.dumps(e["names"]) for e in eps]),
        }
        if stats["failed"]:
            if save_to is not None:
                raise RuntimeError(f"{stats['failed']} exposures could not be read")
            print(f"{key}: {stats['failed']} exposures could not be read; quality data not cached")
            return out
        path = (save_to or CACHE) / "quality" / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.stem}.{threading.get_ident()}.tmp.npz")
        np.savez_compressed(tmp, total_frames=np.int64(total), **out)
        os.replace(tmp, path)
        return out


def spectrum_key(ra: float, dec: float, fov: float, pra: float, pdec: float, aper: float = 2.0) -> str:
    size = "" if aper == 2.0 else f"_a{aper:g}"      # the default aperture keeps the original file names
    return f"v{SPECTRUM_VERSION}_{ra:.4f}_{dec:+.4f}_{fov:g}_{pra:.5f}_{pdec:+.5f}{size}.json"


def get_spectrum(ra: float, dec: float, fov: float, pra: float, pdec: float,
                 cached_only: bool = False, save_to: Path | None = None, aper: float = 2.0) -> dict | None:
    """Spectrum at (pra, pdec) inside the view centred on (ra, dec): cached, shipped, or measured."""
    total = len(query_frames(ra, dec, CACHE))
    key = spectrum_key(ra, dec, fov, pra, pdec, aper)
    if save_to is None:
        for base in (CACHE, SEED):
            path = base / "spectra" / key
            if path.exists():
                try:
                    hit = json.loads(path.read_text())
                    if hit["exposures"] == total:
                        return hit
                except Exception as exc:
                    print(f"ignoring {path}: {exc}")
    if cached_only:
        return None
    with _BUILD_SLOTS:
        stats: dict = {}
        out = measure_spectrum(ra, dec, fov, pra, pdec, CACHE, workers=WORKERS, stats=stats, aperture_pix=aper)
    if stats["failed"]:
        if save_to is not None:
            raise RuntimeError(f"{stats['failed']} exposures could not be read")
        print(f"{key}: {stats['failed']} exposures could not be read; spectrum not cached")
        return out
    path = (save_to or CACHE) / "spectra" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.stem}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    os.replace(tmp, path)
    return out


def get_catalog(name: str, ra: float, dec: float, fov: float, save_to: Path | None = None) -> dict:
    """Catalogue sources for a view: cached, shipped, or asked from the catalogue service."""
    key = f"v2_{name}_{ra:.4f}_{dec:+.4f}_{fov:g}.json"
    if save_to is None:
        for base in (CACHE, SEED):
            path = base / "catalog" / key
            if path.exists():
                try:
                    return json.loads(path.read_text())
                except Exception as exc:
                    print(f"ignoring {path}: {exc}")
    out = catalog.query(name, ra, dec, fov)
    path = (save_to or CACHE) / "catalog" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.stem}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    os.replace(tmp, path)
    return out


def _epoch_meta(ep: Epoch) -> dict:
    mjds = [f.mjd for f in ep.frames]
    counts = {d: sum(f.detector == d for f in ep.frames) for d in BANDS}
    return {"label": ep.label, "mjd": ep.mjd, "mjd_min": min(mjds), "mjd_max": max(mjds), "frames": counts}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/epochs")
def epochs(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90)):
    """Epochs of SPHEREx coverage at a position. Slow (20-30 s) the first time, then cached."""
    try:
        frames = query_frames(ra, dec, CACHE)
    except Exception as exc:
        raise HTTPException(502, f"IRSA metadata query failed: {exc}") from exc
    age = age_days(CACHE, ra, dec)
    refreshing = refresh_if_old(ra, dec, CACHE)     # a list older than a week is fetched again in the background
    groups = split_epochs(frames)
    return {
        "ra": ra, "dec": dec, "total_frames": len(frames),
        "index_age_days": None if age is None else round(age, 2), "refreshing": refreshing,
        "bands": {d: {"min_um": lo, "max_um": hi} for d, (lo, hi) in BANDS.items()},
        "epochs": [_epoch_meta(Epoch(g)) for g in groups],
    }


@app.get("/api/stack")
def stack(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90),
          fov: float = Query(240, ge=30, le=MAX_FOV), det: int = Query(ge=1, le=6)):
    """One stacked image per epoch for one detector, as base64 little-endian float32 (MJy/sr).
    Fields up to 10 arcmin are on a 3.075 arcsec grid, wider ones on the native 6.15 arcsec."""
    try:
        s = get_stack(ra, dec, fov, det)
    except Exception as exc:
        raise HTTPException(502, f"could not build stacks: {exc}") from exc
    out, k = [], 0
    for label, mjd, used, has in zip(s["labels"], s["mjd"], s["used"], s["has"]):
        data = None
        if has:
            data = base64.b64encode(np.asarray(s["cube"][k], dtype="<f4").tobytes()).decode()
            k += 1
        out.append({"label": str(label), "mjd": float(mjd), "used": int(used), "data": data})
    return {"ra": ra, "dec": dec, "fov": fov, "det": det, "n": int(s["n"]), "pixscale": grid_pixscale(fov), "epochs": out}


@app.get("/api/quality")
def quality_api(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90),
                fov: float = Query(240, ge=30, le=MAX_FOV), det: int = Query(ge=1, le=6)):
    """Per epoch, on the same grid as /api/stack: "flag" is a base64 uint8 map, the share of
    exposures (0-255) in which a pixel carries a quality flag; "names" gives the share of the
    field each flag touches; "zodi" is the modelled zodiacal light in MJy/sr; "corr" is a 3x3
    grid (south to north, east to west as in the image) to add to the stack so that only the
    zodiacal model is removed instead of the whole background."""
    try:
        q = get_quality(ra, dec, fov, det)
    except Exception as exc:
        raise HTTPException(502, f"could not read the quality data: {exc}") from exc
    out, k = [], 0
    for has in q["has"]:
        if not has:
            out.append(None)
            continue
        out.append({"used": int(q["used"][k]), "zodi": round(float(q["zodi"][k]), 5),
                    "corr": np.asarray(q["corr"][k]).round(5).tolist(),
                    "names": json.loads(str(q["names"][k])),
                    "flag": base64.b64encode(np.asarray(q["flag"][k], dtype="u1").tobytes()).decode()})
        k += 1
    return {"ra": ra, "dec": dec, "fov": fov, "det": det, "n": int(q["n"]), "epochs": out}


@app.get("/api/spectrum")
def spectrum(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90),
             fov: float = Query(240, ge=30, le=MAX_FOV),
             pra: float = Query(ge=0, lt=360), pdec: float = Query(ge=-90, le=90),
             cached_only: bool = False, aper: float = Query(2.0, ge=1.0, le=3.0)):
    """One spectrum point per exposure at (pra, pdec), a spot inside the view (ra, dec, fov).
    Aperture photometry in mJy; aper is the aperture radius in native pixels of 6.15 arcsec.
    With cached_only, answers {"points": null} instead of measuring."""
    aper = round(aper * 2) / 2                      # steps of half a pixel
    sep = np.hypot((pra - ra + 180) % 360 - 180, pdec - dec) * 3600   # generous box test, arcsec
    if sep > fov and abs(dec) < 89:
        raise HTTPException(422, "the spot is outside the view")
    try:
        out = get_spectrum(ra, dec, fov, pra, pdec, cached_only, aper=aper)
    except Exception as exc:
        raise HTTPException(502, f"could not measure the spectrum: {exc}") from exc
    return out or {"ra": pra, "dec": pdec, "points": None}


@app.get("/api/catalog")
def catalog_api(name: str = Query(pattern="^(gaia|catwise)$"),
                ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90),
                fov: float = Query(240, ge=30, le=MAX_FOV)):
    """Gaia DR3 or CatWISE2020 sources in the view, each with position at the catalogue's
    reference epoch (decimal year) and proper motion in mas/yr."""
    try:
        return get_catalog(name, ra, dec, fov)
    except Exception as exc:
        raise HTTPException(502, f"the {catalog.CATALOGS[name]['label']} service did not answer: {exc}") from exc


FRONTEND = ROOT / "frontend"
PAGES = {"explore": "explore.html", "targets": "targets.html", "method": "method.html",
         "api-docs": "api.html", "about": "about.html"}


def _page(name: str):
    def serve():
        return FileResponse(FRONTEND / name)
    return serve


for _path, _file in PAGES.items():      # pages without the .html in their address
    app.add_api_route(f"/{_path}", _page(_file), methods=["GET"], include_in_schema=False)

# "/" is index.html (the home page); unknown addresses get 404.html.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
