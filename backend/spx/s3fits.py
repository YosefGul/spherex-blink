"""Read small cutouts of SPHEREx spectral images straight from S3 with HTTP range requests.

The IMAGE extension is uncompressed float32, so a block of rows is one contiguous byte
range: no need to download the 67 MB file or wait for the IRSA cutout service.
AI-assisted code (Claude Code).
"""
from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits

from .tanwcs import TanWCS

BLOCK = 2880
HEADER_GUESS = 16 * BLOCK   # primary (1 block) + IMAGE header (8 blocks in DR1) with margin
NPIX = 2040

_local = threading.local()


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def _range(url: str, start: int, end: int) -> tuple[bytes, int]:
    """Bytes [start, end] inclusive, plus the total file size. A dropped connection is tried again."""
    for attempt in range(3):
        try:
            r = _session().get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=60)
            if r.status_code >= 500 and attempt < 2:
                continue
            break
        except (requests.ConnectionError, requests.Timeout):
            if attempt == 2:
                raise
    r.raise_for_status()
    total = int(r.headers["Content-Range"].rsplit("/", 1)[1])
    return r.content, total


def _header_end(buf: bytes, start: int) -> int | None:
    """Offset just past the header that begins at `start`, or None if END is not in buf."""
    pos = start
    while pos + BLOCK <= len(buf):
        block = buf[pos:pos + BLOCK]
        for i in range(0, BLOCK, 80):
            if block[i:i + 8] == b"END     ":
                return pos + BLOCK
        pos += BLOCK
    return None


@dataclass
class Cutout:
    data: np.ndarray        # (ny, nx) float32, MJy/sr, rows y0.. and columns x0..
    header: fits.Header     # IMAGE extension header of the full frame
    x0: int
    y0: int
    xc: float               # target position in full-frame 0-based pixels
    yc: float
    url: str

    @property
    def wcs(self) -> TanWCS:
        return TanWCS.from_header(self.header)

    def world_to_cutout_pix(self, ra, dec):
        x, y = self.wcs.world2pix(ra, dec)
        return x - self.x0, y - self.y0


def read_image_header(url: str) -> tuple[fits.Header, int, int]:
    """IMAGE header, byte offset of its data, and file size."""
    buf, total = _range(url, 0, HEADER_GUESS - 1)
    while True:
        p_end = _header_end(buf, 0)
        i_end = _header_end(buf, p_end) if p_end is not None else None
        if i_end is not None:
            break
        more, _ = _range(url, len(buf), len(buf) + HEADER_GUESS - 1)
        buf += more
    header = fits.Header.fromstring(buf[p_end:i_end].decode("ascii", "replace"))
    return header, i_end, total


def read_cutout(url: str, ra: float, dec: float, half: int, cache_dir: Path | None = None) -> Cutout | None:
    """Square cutout of side 2*half+1 native pixels around (ra, dec); None if off the detector."""
    key = hashlib.sha1(f"{url}|{ra:.6f}|{dec:.6f}|{half}".encode()).hexdigest()
    path = cache_dir / "cutouts" / key[:2] / f"{key}.npz" if cache_dir else None
    if path is not None and path.exists():
        z = np.load(path, allow_pickle=False)
        if z["data"].size == 0:
            return None
        return Cutout(z["data"], fits.Header.fromstring(str(z["header"])), int(z["x0"]), int(z["y0"]),
                      float(z["xc"]), float(z["yc"]), url)

    header, data_start, _ = read_image_header(url)
    xc, yc = (float(v) for v in TanWCS.from_header(header).world2pix(ra, dec))
    x0, x1 = max(0, int(round(xc)) - half), min(NPIX, int(round(xc)) + half + 1)
    y0, y1 = max(0, int(round(yc)) - half), min(NPIX, int(round(yc)) + half + 1)

    cut = None
    if x1 - x0 >= 5 and y1 - y0 >= 5:
        raw, _ = _range(url, data_start + y0 * NPIX * 4, data_start + y1 * NPIX * 4 - 1)
        rows = np.frombuffer(raw, dtype=">f4").reshape(y1 - y0, NPIX)
        cut = Cutout(rows[:, x0:x1].astype(np.float32), header, x0, y0, xc, yc, url)

    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if cut is None:
            np.savez(path, data=np.zeros(0, np.float32), header="", x0=0, y0=0, xc=0.0, yc=0.0)
        else:
            np.savez(path, data=cut.data, header=header.tostring(), x0=x0, y0=y0, xc=xc, yc=yc)
    return cut
