"""Validate TanWCS and the S3 range reader against the IRSA cutout service.

The IRSA service computes the cutout centre with its own WCS code, so agreement means
our pure-numpy projection and byte offsets are right. AI-assisted code (Claude Code).
"""
import io

import numpy as np
import requests
from astropy.io import fits

from spx.s3fits import read_cutout, read_image_header
from spx.tanwcs import TanWCS

URI = "dr1/level2/2026W20_1A/l2b-v27-2026-246/5/level2_2026W20_1A_1166_1D5_spx_l2b-v27-2026-246.fits"
S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/" + URI
IRSA = "https://irsa.ipac.caltech.edu/ibe/data/spherex/" + URI
RA, DEC = 133.7598, -7.2422

header, data_start, total = read_image_header(S3)
w = TanWCS.from_header(header)
xc, yc = w.world2pix(RA, DEC)
print(f"data_start={data_start} size={total} SIP terms A={len(w.a)} B={len(w.b)}")
print(f"ours : target at x={float(xc):.2f} y={float(yc):.2f}")

ra2, dec2 = w.pix2world(xc, yc)
print(f"round trip error: {abs(float(ra2) - RA) * 3600:.2e} / {abs(float(dec2) - DEC) * 3600:.2e} arcsec")
xs, ys = np.meshgrid(np.linspace(0, 2039, 9), np.linspace(0, 2039, 9))
bx, by = w.world2pix(*w.pix2world(xs, ys))
print(f"round trip over detector: max {np.max(np.hypot(bx - xs, by - ys)):.2e} px")

r = requests.get(IRSA, params={"center": f"{RA},{DEC}d", "size": "0.02"}, timeout=120)
r.raise_for_status()
with fits.open(io.BytesIO(r.content)) as hdul:
    ch, cdata = hdul[1].header, hdul[1].data.astype(np.float32)
ix0 = int(round(header["CRPIX1"] - ch["CRPIX1"]))
iy0 = int(round(header["CRPIX2"] - ch["CRPIX2"]))
ny, nx = cdata.shape
print(f"IRSA : cutout {nx}x{ny} from x0={ix0} y0={iy0}; centre x={ix0 + (nx - 1) / 2:.2f} y={iy0 + (ny - 1) / 2:.2f}")

half = 20
cut = read_cutout(S3, RA, DEC, half)
sub = cut.data[iy0 - cut.y0:iy0 - cut.y0 + ny, ix0 - cut.x0:ix0 - cut.x0 + nx]
same = np.array_equal(np.nan_to_num(sub, nan=-999), np.nan_to_num(cdata, nan=-999))
print(f"pixel values identical to IRSA cutout: {same} (overlap {sub.shape})")
