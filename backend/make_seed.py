"""Pre-compute the stacks for the challenge's test targets into data/seed/.

The seed is committed with the code, so the public site answers these targets at once
even on a host that starts with an empty disk. Re-run after a new SPHEREx data release:

    python backend/make_seed.py --refresh

Keep TARGETS in step with TARGETS in frontend/app.js. AI-assisted code (Claude Code).
"""
from __future__ import annotations

import argparse
import shutil
import time

from app import CACHE, SEED, get_stack
from spx.index import _cache_file, query_frames

TARGETS = {
    "Barnard's Star": (269.4463, 4.7680),
    "Eps Indi B": (331.0960, -56.8010),
    "WISE 0855": (133.7598, -7.2422),
    "RW Aur": (76.9563, 30.4014),
    "R Dra": (248.1675, 66.7550),
}
FOV = 240.0   # the viewer's default field of view


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="ask IRSA again for the list of exposures")
    args = ap.parse_args()
    (SEED / "index").mkdir(parents=True, exist_ok=True)
    for name, (ra, dec) in TARGETS.items():
        t0 = time.time()
        try:
            frames = query_frames(ra, dec, CACHE, refresh=args.refresh)
        except Exception as exc:
            print(f"{name}: SKIPPED, the IRSA query failed ({type(exc).__name__})")
            continue
        src = _cache_file(CACHE, ra, dec)
        shutil.copy(src, SEED / "index" / src.name)
        for det in range(1, 7):
            try:
                s = get_stack(ra, dec, FOV, det, save_to=SEED)
                print(f"{name:15s} D{det}: {int(sum(s['used'])):4d} frames in {int(sum(s['has']))} epochs")
            except Exception as exc:
                print(f"{name:15s} D{det}: FAILED, {exc}")
        print(f"{name}: {len(frames)} exposures, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
