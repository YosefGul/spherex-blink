"""Pre-compute the stacks for the challenge's test targets into data/seed/.

The seed is committed with the code, so the public site answers these targets at once
even on a host that starts with an empty disk. Re-run after a new SPHEREx data release
(the archive grows every week; a weekly cron job with this line keeps the seed current):

    python backend/make_seed.py --refresh

The running server needs no such job for other positions: it asks the archive again by itself
when its list of exposures for a position is more than a week old.

Keep TARGETS in step with TARGETS in frontend/site.js. AI-assisted code (Claude Code).
"""
from __future__ import annotations

import argparse
import shutil
import time

from app import CACHE, SEED, get_catalog, get_quality, get_spectrum, get_stack
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
    ap.add_argument("--only", choices=("stacks", "quality", "spectra", "catalog"), action="append",
                    help="build only this part (may be given more than once); default: everything")
    args = ap.parse_args()
    want = set(args.only or ("stacks", "quality", "spectra", "catalog"))
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
        for det in range(1, 7) if "stacks" in want else ():
            try:
                s = get_stack(ra, dec, FOV, det, save_to=SEED)
                print(f"{name:15s} D{det}: {int(sum(s['used'])):4d} frames in {int(sum(s['has']))} epochs")
            except Exception as exc:
                print(f"{name:15s} D{det}: FAILED, {exc}")
        for det in range(1, 7) if "quality" in want else ():     # flag maps and zodiacal model, for the two layers
            try:
                q = get_quality(ra, dec, FOV, det, save_to=SEED)
                print(f"{name:15s} D{det}: quality data for {int(sum(q['has']))} epochs")
            except Exception as exc:
                print(f"{name:15s} D{det}: quality FAILED, {exc}")
        try:   # spectrum at the centre of the view, shown as soon as the target opens
            if "spectra" in want:
                sp = get_spectrum(ra, dec, FOV, ra, dec, save_to=SEED)
                print(f"{name:15s} spectrum: {len(sp['points'])} points")
        except Exception as exc:
            print(f"{name:15s} spectrum: FAILED, {exc}")
        for cat in ("gaia", "catwise") if "catalog" in want else ():
            try:
                c = get_catalog(cat, ra, dec, FOV, save_to=SEED)
                print(f"{name:15s} {cat}: {len(c['sources'])} sources")
            except Exception as exc:
                print(f"{name:15s} {cat}: FAILED, {exc}")
        print(f"{name}: {len(frames)} exposures, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
