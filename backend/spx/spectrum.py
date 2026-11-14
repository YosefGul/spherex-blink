"""Spectrum of one sky position from the individual exposures.

Each exposure sees the position through a different part of the linear variable filter,
so each exposure gives one point: (wavelength of that pixel, brightness there). Collecting
every exposure of all six detectors gives a 0.75-5 micrometre spectrum, with the date of
each point known, so spectra of different epochs can be compared.
AI-assisted code (Claude Code).
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .index import Frame, query_frames
from .s3fits import read_cutout
from .stack import NATIVE_PIX, split_epochs
from .tanwcs import clipped_median, mad_std
from .wave import wavelength

APERTURE_PIX = 2.0            # default aperture radius, native pixels (12.3 arcsec)
ANNULUS_PIX = (4.0, 7.0)      # background annulus, native pixels
SUB = 5                       # sub-pixel sampling used for the aperture edge


def cutout_half(fov_arcsec: float) -> int:
    """Half-size of the cutouts in native pixels. Must match stack.build so the cache is shared."""
    return int(np.ceil(fov_arcsec / NATIVE_PIX / 2 * 1.45)) + 3


def aperture_flux(data: np.ndarray, px: float, py: float,
                  radius: float = APERTURE_PIX) -> tuple[float, float] | None:
    """Background-subtracted aperture sum and its 1-sigma noise, in image units x pixels.
    None if the aperture is cut by the edge, contains bad pixels, or there is no usable sky."""
    ny, nx = data.shape
    r_out = ANNULUS_PIX[1]
    if not (radius + 1 <= px < nx - radius - 1 and radius + 1 <= py < ny - radius - 1):
        return None
    x0, x1 = max(0, int(px - r_out)), min(nx, int(px + r_out) + 2)
    y0, y1 = max(0, int(py - r_out)), min(ny, int(py + r_out) + 2)
    box = data[y0:y1, x0:x1]
    yy, xx = np.mgrid[y0:y1, x0:x1]
    dist = np.hypot(xx - px, yy - py)

    sky = box[(dist >= ANNULUS_PIX[0]) & (dist <= r_out) & np.isfinite(box)]
    if sky.size < 30:
        return None
    background = clipped_median(sky)

    # fraction of each pixel that lies inside the aperture
    offs = (np.arange(SUB) + 0.5) / SUB - 0.5
    weight = np.zeros(box.shape)
    for dy in offs:
        for dx in offs:
            weight += np.hypot(xx + dx - px, yy + dy - py) <= radius
    weight /= SUB * SUB
    inside = weight > 0
    if not np.all(np.isfinite(box[inside])):
        return None                       # saturated or flagged pixel in the aperture
    flux = float(np.sum(weight[inside] * (box[inside] - background)))
    noise = float(mad_std(sky) * np.sqrt(np.sum(weight[inside] ** 2)))
    return flux, noise


def spectrum(view_ra: float, view_dec: float, fov_arcsec: float, ra: float, dec: float,
             cache_dir: Path, workers: int = 16, stats: dict | None = None,
             aperture_pix: float = APERTURE_PIX) -> dict:
    """One point per exposure at (ra, dec), using the cutouts of the view centred on
    (view_ra, view_dec). Fluxes in mJy; no aperture correction is applied, so a smaller
    aperture keeps neighbours out but loses more of the target's own light."""
    groups = split_epochs(query_frames(view_ra, view_dec, cache_dir))
    epoch_of = {f: i for i, g in enumerate(groups) for f in g}
    half = cutout_half(fov_arcsec)
    failed: list[str] = []

    def measure(f: Frame):
        try:
            cut = read_cutout(f.s3_url, view_ra, view_dec, half, cache_dir)
        except Exception as exc:
            print(f"skip {f.exposure_id}: {exc}")
            failed.append(f.exposure_id)
            return None
        if cut is None:
            return None
        wcs = cut.wcs
        fx, fy = (float(v) for v in wcs.world2pix(ra, dec))          # full-detector pixel
        res = aperture_flux(cut.data, fx - cut.x0, fy - cut.y0, aperture_pix)
        if res is None or not (0 <= fx <= 2039 and 0 <= fy <= 2039):
            return None
        lam, width = wavelength(f.detector, fx, fy)
        # MJy/sr x pixel solid angle -> mJy
        to_mjy = abs(np.linalg.det(wcs.cd)) * (np.pi / 180) ** 2 * 1e9
        return {"wavelength": round(lam, 5), "bandwidth": round(width, 5),
                "flux": round(res[0] * to_mjy, 5), "error": round(res[1] * to_mjy, 5),
                "mjd": round(f.mjd, 4), "det": f.detector, "epoch": epoch_of[f]}

    frames = [f for g in groups for f in g]
    with ThreadPoolExecutor(workers) as pool:
        points = [p for p in pool.map(measure, frames) if p is not None]
    points.sort(key=lambda p: p["wavelength"])
    if stats is not None:
        stats["failed"] = len(failed)
    return {
        "ra": ra, "dec": dec, "exposures": len(frames), "points": points,
        "aperture_arcsec": aperture_pix * NATIVE_PIX,
        "annulus_arcsec": [ANNULUS_PIX[0] * NATIVE_PIX, ANNULUS_PIX[1] * NATIVE_PIX],
    }
