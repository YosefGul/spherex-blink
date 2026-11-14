"""Quality data that SPHEREx ships next to each image: the pixel flags and the zodiacal-light model.

Each level-2 file holds, after the IMAGE extension, a FLAGS extension (a bit mask per pixel,
Rice-compressed one image row per table row), a VARIANCE extension and a ZODI extension (the
modelled zodiacal light, uncompressed). Only the rows around the target are read, with HTTP
range requests, as for the image itself. AI-assisted code (Claude Code).
"""
from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from astropy.io import fits
from scipy.ndimage import map_coordinates

try:                                        # the Rice codec is an internal part of astropy; its place has moved
    from astropy.io.fits.hdu.compressed._codecs import Rice1
except ImportError:                         # astropy 5.3 to 6
    from astropy.io.fits._tiled_compression.codecs import Rice1

from .index import Frame, query_frames
from .s3fits import BLOCK, NPIX, Cutout, _header_end, _range, read_cutout, read_image_header
from .stack import cutout_half, grid_pixscale, split_epochs
from .tanwcs import clipped_median, sky_grid

IMG_BYTES = NPIX * NPIX * 4                 # one uncompressed float32 plane; a whole number of FITS blocks
TABLE_BYTES = NPIX * 8                      # FLAGS table: one (length, offset) pair per image row
# Flags that describe a pixel without calling it bad: these are left out of the "flagged" map.
INFO_FLAGS = {"FULLSAMPLE", "SOURCE"}


def _pad(nbytes: int) -> int:
    return (nbytes + BLOCK - 1) // BLOCK * BLOCK


def _header_at(url: str, start: int, need_after: int = 0) -> tuple[fits.Header, int, bytes]:
    """Header that begins at byte `start`: (header, its length, bytes read from `start`).
    At least `need_after` bytes after the header are included in the returned buffer."""
    buf, _ = _range(url, start, start + 8 * BLOCK + need_after - 1)
    end = _header_end(buf, 0)
    while end is None or len(buf) < end + need_after:
        more, _ = _range(url, start + len(buf), start + len(buf) + 8 * BLOCK - 1)
        buf += more
        end = _header_end(buf, 0)
    return fits.Header.fromstring(buf[:end].decode("ascii", "replace")), end, buf


def read_quality(cut: Cutout, cache_dir: Path | None = None) -> dict:
    """Flags and zodiacal model for the pixels of a cutout.

    Returns {"flags": int32 (ny, nx), "names": {bit: name}, "zodi": (a, b, c)} where the zodiacal
    light in MJy/sr at cutout pixel (x, y) is a + b*x + c*y: a plane fitted to three rows of the model.
    """
    ny, nx = cut.data.shape
    key = hashlib.sha1(f"{cut.url}|{cut.x0}|{cut.y0}|{nx}|{ny}".encode()).hexdigest()
    path = cache_dir / "quality_cut" / key[:2] / f"{key}.npz" if cache_dir else None
    if path is not None and path.exists():
        z = np.load(path, allow_pickle=False)
        return {"flags": z["flags"], "names": dict(zip(z["bits"].tolist(), z["names"].tolist())), "zodi": tuple(z["zodi"])}

    url = cut.url
    start = BLOCK + len(cut.header.tostring()) + IMG_BYTES        # primary header is one block
    try:
        h, hend, buf = _header_at(url, start, TABLE_BYTES)
        ok = h.get("EXTNAME") == "FLAGS"
    except Exception:
        ok = False
    if not ok:                                                    # header lengths differ: measure them
        _, i_end, _ = read_image_header(url)
        start = i_end + IMG_BYTES
        h, hend, buf = _header_at(url, start, TABLE_BYTES)
    if h.get("EXTNAME") != "FLAGS" or h.get("ZCMPTYPE") != "RICE_1" or h.get("ZTILE2", 1) != 1:
        raise RuntimeError("unexpected FLAGS extension layout")

    table = np.frombuffer(buf[hend:hend + TABLE_BYTES], dtype=">i4").reshape(NPIX, 2)
    count, offset = table[:, 0].astype(np.int64), table[:, 1].astype(np.int64)
    heap = start + hend + int(h.get("THEAP", TABLE_BYTES))
    y0, y1 = cut.y0, cut.y0 + ny
    raw, _ = _range(url, heap + int(offset[y0:y1].min()), heap + int((offset[y0:y1] + count[y0:y1]).max()) - 1)
    base = int(offset[y0:y1].min())
    codec = Rice1(blocksize=int(h.get("ZVAL1", 32)), bytepix=int(h.get("ZVAL2", 4)), tilesize=NPIX)
    flags = np.empty((ny, nx), dtype=np.int32)
    for j, y in enumerate(range(y0, y1)):
        a = int(offset[y]) - base
        row = np.asarray(codec.decode(np.frombuffer(raw[a:a + int(count[y])], np.uint8)))
        flags[j] = row[cut.x0:cut.x0 + nx]
    names = {int(c.keyword[4:]): str(c.value).strip() for c in h.cards if c.keyword.startswith("MSKN")}

    # ZODI comes after VARIANCE. Both are plain images; VARIANCE's header is four blocks in the files seen so far.
    var_start = start + hend + _pad(TABLE_BYTES + int(h["PCOUNT"]))
    zodi_start = var_start + 4 * BLOCK + IMG_BYTES
    zh, zend, _ = _header_at(url, zodi_start)
    if zh.get("EXTNAME") != "ZODI":
        _, vend, _ = _header_at(url, var_start)
        zodi_start = var_start + vend + IMG_BYTES
        zh, zend, _ = _header_at(url, zodi_start)
        if zh.get("EXTNAME") != "ZODI":
            raise RuntimeError("ZODI extension not found")
    xs, ys, zs = [], [], []
    for y in sorted({y0, y0 + ny // 2, y1 - 1}):                  # the model is smooth: three rows fix a plane
        first = zodi_start + zend + (y * NPIX + cut.x0) * 4
        seg, _ = _range(url, first, first + nx * 4 - 1)
        vals = np.frombuffer(seg, dtype=">f4").astype(float)
        good = np.isfinite(vals)
        xs.append(np.arange(nx)[good]); ys.append(np.full(good.sum(), y - y0)); zs.append(vals[good])
    x, y, z = np.concatenate(xs), np.concatenate(ys), np.concatenate(zs)
    if z.size < 6:
        raise RuntimeError("no usable ZODI values")
    plane = np.linalg.lstsq(np.column_stack([np.ones_like(x, dtype=float), x, y]), z, rcond=None)[0]

    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        bits = sorted(names)
        np.savez_compressed(path, flags=flags, bits=np.array(bits), names=np.array([names[b] for b in bits]), zodi=plane)
    return {"flags": flags, "names": names, "zodi": tuple(plane)}


def build(ra: float, dec: float, fov_arcsec: float, det: int, cache_dir: Path,
          workers: int = 16, stats: dict | None = None) -> dict:
    """Per epoch, for one detector, on the same sky grid as the stacks:
    - "flag": for every pixel the share of exposures in which it carries a flag (0..255), or None;
    - "names": which flags occur in the field, with the share of pixel-exposures they touch;
    - "zodi": mean zodiacal-light model at the centre, MJy/sr;
    - "corr": 3x3 values over the field of (background that the stack removed - zodiacal model).
      Adding them to the stack gives the image with only the zodiacal model removed.
    """
    groups = split_epochs(query_frames(ra, dec, cache_dir))
    grid, n = sky_grid(ra, dec, fov_arcsec, grid_pixscale(fov_arcsec))
    half = cutout_half(fov_arcsec)
    yy, xx = np.mgrid[0:n, 0:n]
    gra, gdec = grid.pix2world(xx, yy)
    k = np.array([0.0, (n - 1) / 2, n - 1])
    cra, cdec = grid.pix2world(*np.meshgrid(k, k))                # 3x3 points over the field, row 0 south
    failed: list[str] = []

    def load(f: Frame):
        try:
            cut = read_cutout(f.s3_url, ra, dec, half, cache_dir)
            if cut is None:
                return None
            q = read_quality(cut, cache_dir)
        except Exception as exc:
            print(f"skip quality of {f.exposure_id}: {exc}")
            failed.append(f.exposure_id)
            return None
        bad_bits = sum(1 << b for b, name in q["names"].items() if name not in INFO_FLAGS)
        px, py = cut.world_to_cutout_pix(gra, gdec)
        inside = (px > -0.5) & (px < cut.data.shape[1] - 0.5) & (py > -0.5) & (py < cut.data.shape[0] - 0.5)
        bad = map_coordinates(((q["flags"] & bad_bits) != 0).astype(np.float32), [py, px], order=0, mode="nearest")
        bad[~inside] = np.nan
        # which flags, counted on the cutout pixels that the field covers
        r = int(np.ceil(fov_arcsec / 6.15 / 2))
        cx, cy = int(round(cut.xc)) - cut.x0, int(round(cut.yc)) - cut.y0
        box = q["flags"][max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
        share = {name: float(np.count_nonzero(box & (1 << b))) / max(1, box.size) for b, name in q["names"].items()}
        a, b, c = q["zodi"]
        zx, zy = cut.world_to_cutout_pix(cra, cdec)
        zodi = a + b * zx + c * zy
        return bad, share, clipped_median(cut.data) - zodi, float(zodi[1, 1])

    wanted = [f for g in groups for f in g if f.detector == det]
    with ThreadPoolExecutor(workers) as pool:
        got = dict(zip(wanted, pool.map(load, wanted)))

    epochs = []
    for g in groups:
        rows = [got[f] for f in g if f.detector == det and got.get(f) is not None]
        if not rows:
            epochs.append(None)
            continue
        with np.errstate(invalid="ignore"), __import__("warnings").catch_warnings():
            __import__("warnings").simplefilter("ignore", RuntimeWarning)
            frac = np.nanmean(np.array([r[0] for r in rows]), axis=0)
        names: dict[str, float] = {}
        for r in rows:
            for name, v in r[1].items():
                names[name] = names.get(name, 0.0) + v / len(rows)
        epochs.append({
            "flag": np.nan_to_num(frac * 255).round().astype(np.uint8),
            "names": {k_: round(v, 5) for k_, v in sorted(names.items(), key=lambda kv: -kv[1]) if v > 0},
            "corr": np.mean([r[2] for r in rows], axis=0).round(5),
            "zodi": float(np.mean([r[3] for r in rows])),
            "used": len(rows),
        })
    if stats is not None:
        stats["failed"] = len(failed)
    return {"n": n, "epochs": epochs}
