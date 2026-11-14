"""Wavelength of every detector pixel.

SPHEREx has no grating: a linear variable filter sits on each detector, so the wavelength
a pixel sees depends on where the pixel is. Every Level 2 file carries that map in its last
extension, WCS-WAVE: a coarse grid of control points with (central wavelength, bandwidth)
in micrometres. The grid comes from a calibration file and is the same in every exposure of
a detector, so it is stored once in wave_grids.json (regenerate with backend/make_wave_grids.py).
AI-assisted code (Claude Code).
"""
from __future__ import annotations

import io
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits

GRID_FILE = Path(__file__).with_name("wave_grids.json")
BLOCK = 2880


def fetch_grid(url: str) -> dict:
    """Read the WCS-WAVE table from the end of one Level 2 file."""
    r = requests.get(url, headers={"Range": f"bytes=-{10 * BLOCK}"}, timeout=60)
    r.raise_for_status()
    buf = r.content
    starts = [o for o in range(len(buf) % BLOCK, len(buf), BLOCK) if buf[o:o + 8] == b"XTENSION"]
    primary = fits.PrimaryHDU().header.tostring().encode()
    primary += b" " * (-len(primary) % BLOCK)
    with fits.open(io.BytesIO(primary + buf[starts[-1]:])) as hdul:
        hdu = hdul[1]
        if hdu.header.get("EXTNAME") != "WCS-WAVE":
            raise ValueError(f"last extension is {hdu.header.get('EXTNAME')}, not WCS-WAVE")
        values = np.array(hdu.data["VALUES"][0], dtype=float)          # (ny, nx, 2)
        source = [str(h) for h in hdu.header.get("HISTORY", []) if "Calibration source" in str(h)]
        return {
            "x": np.array(hdu.data["X"][0], dtype=float).tolist(),     # 1-based pixel columns
            "y": np.array(hdu.data["Y"][0], dtype=float).tolist(),     # 1-based pixel rows
            "wavelength": values[..., 0].tolist(),
            "bandwidth": values[..., 1].tolist(),
            "source": source[0].split(":")[-1].strip() if source else "",
        }


@lru_cache(maxsize=1)
def _grids() -> dict[int, dict]:
    raw = json.loads(GRID_FILE.read_text())
    return {int(d): {k: (np.array(v) if k != "source" else v) for k, v in g.items()} for d, g in raw.items()}


def _bilinear(gx, gy, table, x, y) -> float:
    i = int(np.clip(np.searchsorted(gx, x) - 1, 0, len(gx) - 2))
    j = int(np.clip(np.searchsorted(gy, y) - 1, 0, len(gy) - 2))
    tx = (x - gx[i]) / (gx[i + 1] - gx[i])
    ty = (y - gy[j]) / (gy[j + 1] - gy[j])
    return float((1 - ty) * ((1 - tx) * table[j, i] + tx * table[j, i + 1])
                 + ty * ((1 - tx) * table[j + 1, i] + tx * table[j + 1, i + 1]))


def wavelength(det: int, x: float, y: float) -> tuple[float, float]:
    """(central wavelength, bandwidth) in micrometres at 0-based detector pixel (x, y)."""
    g = _grids()[det]
    return (_bilinear(g["x"], g["y"], g["wavelength"], x + 1, y + 1),
            _bilinear(g["x"], g["y"], g["bandwidth"], x + 1, y + 1))
