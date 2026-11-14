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
from fastapi.staticfiles import StaticFiles

import json

from spx.index import query_frames
from spx.spectrum import spectrum as measure_spectrum
from spx.stack import NATIVE_PIX, Epoch, build, split_epochs

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("SPX_CACHE_DIR") or ROOT / "data" / "cache")
SEED = ROOT / "data" / "seed"      # shipped with the code: results for the challenge's test targets
WORKERS = int(os.environ.get("SPX_WORKERS", "16"))
STACK_VERSION = 1                  # bump when stacking changes, so old cached results are ignored
SPECTRUM_VERSION = 1               # same, for the photometry

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


def spectrum_key(ra: float, dec: float, fov: float, pra: float, pdec: float) -> str:
    return f"v{SPECTRUM_VERSION}_{ra:.4f}_{dec:+.4f}_{fov:g}_{pra:.5f}_{pdec:+.5f}.json"


def get_spectrum(ra: float, dec: float, fov: float, pra: float, pdec: float,
                 cached_only: bool = False, save_to: Path | None = None) -> dict | None:
    """Spectrum at (pra, pdec) inside the view centred on (ra, dec): cached, shipped, or measured."""
    total = len(query_frames(ra, dec, CACHE))
    key = spectrum_key(ra, dec, fov, pra, pdec)
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
        out = measure_spectrum(ra, dec, fov, pra, pdec, CACHE, workers=WORKERS, stats=stats)
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
    groups = split_epochs(frames)
    return {
        "ra": ra, "dec": dec, "total_frames": len(frames),
        "bands": {d: {"min_um": lo, "max_um": hi} for d, (lo, hi) in BANDS.items()},
        "epochs": [_epoch_meta(Epoch(g)) for g in groups],
    }


@app.get("/api/stack")
def stack(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90),
          fov: float = Query(240, ge=30, le=600), det: int = Query(ge=1, le=6)):
    """One stacked image per epoch for one detector, as base64 little-endian float32 (MJy/sr)."""
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
    return {"ra": ra, "dec": dec, "fov": fov, "det": det, "n": int(s["n"]), "pixscale": NATIVE_PIX / 2, "epochs": out}


@app.get("/api/spectrum")
def spectrum(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90),
             fov: float = Query(240, ge=30, le=600),
             pra: float = Query(ge=0, lt=360), pdec: float = Query(ge=-90, le=90),
             cached_only: bool = False):
    """One spectrum point per exposure at (pra, pdec), a spot inside the view (ra, dec, fov).
    Aperture photometry in mJy. With cached_only, answers {"points": null} instead of measuring."""
    sep = np.hypot((pra - ra + 180) % 360 - 180, pdec - dec) * 3600   # generous box test, arcsec
    if sep > fov and abs(dec) < 89:
        raise HTTPException(422, "the spot is outside the view")
    try:
        out = get_spectrum(ra, dec, fov, pra, pdec, cached_only)
    except Exception as exc:
        raise HTTPException(502, f"could not measure the spectrum: {exc}") from exc
    return out or {"ra": pra, "dec": pdec, "points": None}


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
