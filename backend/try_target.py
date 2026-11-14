"""Build epoch x detector stacks for one position and save a contact sheet.

Usage: python try_target.py NAME RA DEC [--fov ARCSEC] [--det 5 6] [--mark RA DEC LABEL ...]
AI-assisted code (Claude Code).
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from spx.stack import build
from spx.tanwcs import mad_std

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("ra", type=float)
    ap.add_argument("dec", type=float)
    ap.add_argument("--fov", type=float, default=240.0)
    ap.add_argument("--det", type=int, nargs="+", default=[5, 6])
    ap.add_argument("--mark", nargs=3, action="append", default=[], metavar=("RA", "DEC", "LABEL"))
    args = ap.parse_args()

    t0 = time.time()
    epochs, grid, _ = build(args.ra, args.dec, args.fov, ROOT / "data" / "cache", tuple(args.det))
    print(f"{len(epochs)} epochs in {time.time() - t0:.1f}s")
    for ep in epochs:
        print(f"  {ep.label}: " + ", ".join(f"D{d}={c}" for d, c in ep.counts.items()))

    marks = [(float(r), float(d), lab) for r, d, lab in args.mark]
    ncol, nrow = len(epochs) + 1, len(args.det)
    fig, axes = plt.subplots(nrow, ncol, figsize=(3.2 * ncol, 3.3 * nrow), squeeze=False)
    for i, det in enumerate(args.det):
        have = [ep.stacks[det] for ep in epochs if det in ep.stacks]
        sig = np.nanmedian([mad_std(s) for s in have]) if have else 1.0
        for j, ep in enumerate(epochs):
            ax = axes[i][j]
            ax.set_xticks([]); ax.set_yticks([])
            if det not in ep.stacks:
                ax.set_title(f"{ep.label} · D{det} · no data", fontsize=9)
                continue
            img = ep.stacks[det]
            ax.imshow(img, origin="lower", cmap="gray", vmin=-2 * sig, vmax=8 * sig)
            ax.set_title(f"{ep.label} · D{det} · {ep.counts[det]} frames", fontsize=9)
            for r, d, lab in marks:
                x, y = grid.world2pix(r, d)
                ax.plot(x, y, "o", ms=14, mfc="none", mec="tab:orange", mew=1)
                snr = np.nanmax(img[int(y) - 2:int(y) + 3, int(x) - 2:int(x) + 3]) / mad_std(img)
                print(f"  D{det} {ep.label} at '{lab}': peak S/N = {snr:.1f}")
        ax = axes[i][-1]
        ax.set_xticks([]); ax.set_yticks([])
        if len(have) >= 2 and det in epochs[0].stacks and det in epochs[-1].stacks:
            diff = epochs[-1].stacks[det] - epochs[0].stacks[det]
            ax.imshow(diff, origin="lower", cmap="RdBu_r", vmin=-6 * sig, vmax=6 * sig)
            ax.set_title(f"{epochs[-1].label} − {epochs[0].label} · D{det}", fontsize=9)
    fig.tight_layout()
    out = ROOT / "out" / f"{args.name}.png"
    out.parent.mkdir(exist_ok=True)
    fig.savefig(out, dpi=110)
    print("saved", out)


if __name__ == "__main__":
    main()
