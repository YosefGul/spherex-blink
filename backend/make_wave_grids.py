"""Write backend/spx/wave_grids.json: the wavelength map of each detector.

Reads the WCS-WAVE extension of one exposure per detector. Run again if a new SPHEREx
data release changes the spectral calibration (the "source" field names the calibration file).
AI-assisted code (Claude Code).
"""
from __future__ import annotations

import json

from app import SEED
from spx.index import Frame
from spx.wave import GRID_FILE, fetch_grid


def main() -> None:
    rows = json.loads(next((SEED / "index").glob("*.json")).read_text())
    frames = [Frame(**r) for r in rows]
    grids = {}
    for det in range(1, 7):
        newest = [f for f in frames if f.detector == det][-1]
        grids[det] = fetch_grid(newest.s3_url)
        g = grids[det]
        lam = [v for row in g["wavelength"] for v in row]
        print(f"D{det}: {len(g['y'])} x {len(g['x'])} points, {min(lam):.3f}-{max(lam):.3f} um, {g['source']}")
    GRID_FILE.write_text(json.dumps(grids))


if __name__ == "__main__":
    main()
