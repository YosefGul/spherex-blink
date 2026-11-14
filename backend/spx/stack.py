"""Group exposures into epochs and stack them per detector on a common sky grid.

Consecutive SPHEREx exposures of one sky position are taken at different wavelengths,
so single frames cannot be compared in time. Stacking all frames of one detector within
one epoch gives a deeper broad-band image that can be blinked or differenced.
AI-assisted code (Claude Code).
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from astropy.time import Time
from scipy.ndimage import map_coordinates

from .index import Frame, query_frames
from .s3fits import Cutout, read_cutout
from .tanwcs import TanWCS, clipped_mean_stack, clipped_median, sky_grid

NATIVE_PIX = 6.15  # arcsec
FINE_FOV = 600.0   # up to this field of view the grid is twice as fine as the detector pixels


def grid_pixscale(fov_arcsec: float) -> float:
    """Pixel size of the common sky grid, arcsec. Wide fields keep the detector's own pixel size:
    a finer grid would only make the images four times larger."""
    return NATIVE_PIX / 2 if fov_arcsec <= FINE_FOV else NATIVE_PIX


def cutout_half(fov_arcsec: float) -> int:
    """Half-size of the cutouts in native pixels, with a margin for field rotation.
    Stacks, spectra and quality data all use it, so they share the cutout cache."""
    return int(np.ceil(fov_arcsec / NATIVE_PIX / 2 * 1.45)) + 3


@dataclass
class Epoch:
    frames: list[Frame]
    stacks: dict[int, np.ndarray] = field(default_factory=dict)   # detector -> image
    counts: dict[int, int] = field(default_factory=dict)          # detector -> frames used

    @property
    def mjd(self) -> float:
        return float(np.mean([f.mjd for f in self.frames]))

    @property
    def label(self) -> str:
        return Time(self.mjd, format="mjd").strftime("%b %Y")


def split_epochs(frames: list[Frame], gap_days: float = 30.0, max_span_days: float = 60.0) -> list[list[Frame]]:
    """Group frames into visits. A visit ends at a gap, or after max_span_days where coverage
    is continuous (near the ecliptic poles), so that there is always something to blink."""
    groups: list[list[Frame]] = []
    for f in sorted(frames, key=lambda f: f.mjd):
        if groups and f.mjd - groups[-1][-1].mjd <= gap_days and f.mjd - groups[-1][0].mjd <= max_span_days:
            groups[-1].append(f)
        else:
            groups.append([f])
    return groups


def resample(cut: Cutout, grid: TanWCS, n: int) -> np.ndarray:
    """Background-subtracted cutout interpolated onto the common grid (NaN outside)."""
    med = clipped_median(cut.data)
    yy, xx = np.mgrid[0:n, 0:n]
    ra, dec = grid.pix2world(xx, yy)
    px, py = cut.world_to_cutout_pix(ra, dec)
    return map_coordinates(cut.data - med, [py, px], order=1, mode="constant", cval=np.nan)


def build(ra: float, dec: float, fov_arcsec: float, cache_dir: Path,
          detectors: tuple[int, ...] = (1, 2, 3, 4, 5, 6), workers: int = 16,
          gap_days: float = 30.0, stats: dict | None = None) -> tuple[list[Epoch], TanWCS, int]:
    """Epoch stacks for the requested detectors. Epochs are defined by all detectors
    together so every detector shares the same epoch list. If `stats` is given, the number
    of exposures that could not be read is stored in stats["failed"]."""
    failed: list[str] = []
    groups = split_epochs(query_frames(ra, dec, cache_dir), gap_days)
    wanted = [f for g in groups for f in g if f.detector in detectors]
    grid, n = sky_grid(ra, dec, fov_arcsec, grid_pixscale(fov_arcsec))
    half = cutout_half(fov_arcsec)

    def load(f: Frame):
        try:
            cut = read_cutout(f.s3_url, ra, dec, half, cache_dir)
        except Exception as exc:  # one bad file must not sink the whole request
            print(f"skip {f.exposure_id}: {exc}")
            failed.append(f.exposure_id)
            return None
        return None if cut is None else resample(cut, grid, n)

    with ThreadPoolExecutor(workers) as pool:
        images = dict(zip(wanted, pool.map(load, wanted)))

    epochs = []
    for group in groups:
        ep = Epoch(group)
        for det in detectors:
            imgs = [images[f] for f in group if f.detector == det and images.get(f) is not None]
            if not imgs:
                continue
            ep.stacks[det] = clipped_mean_stack(np.array(imgs))
            ep.counts[det] = len(imgs)
        epochs.append(ep)
    if stats is not None:
        stats["failed"] = len(failed)
    return epochs, grid, n
