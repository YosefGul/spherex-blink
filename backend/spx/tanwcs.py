"""Minimal TAN / TAN-SIP world coordinate system in pure numpy.

Covers what SPHEREx spectral images need (gnomonic projection, CD or PC matrix, SIP
distortion) without compiled dependencies, so it runs where astropy.wcs cannot be loaded
and can be ported to the browser. Pixel coordinates are 0-based.
AI-assisted code (Claude Code).
"""
from __future__ import annotations

import numpy as np

D2R = np.pi / 180.0


def mad_std(a) -> float:
    a = np.asarray(a, dtype=float)
    med = np.nanmedian(a)
    return float(1.4826 * np.nanmedian(np.abs(a - med)))


def clipped_median(a, sigma: float = 3.0, iters: int = 3) -> float:
    a = np.asarray(a, dtype=float)
    a = a[np.isfinite(a)]
    for _ in range(iters):
        med, sd = np.median(a), mad_std(a)
        if sd == 0:
            break
        a = a[np.abs(a - med) < sigma * sd]
    return float(np.median(a))


def clipped_mean_stack(cube: np.ndarray, sigma: float = 3.0, iters: int = 2) -> np.ndarray:
    """Per-pixel sigma-clipped mean along axis 0, ignoring NaN."""
    cube = np.array(cube, dtype=float)
    for _ in range(iters):
        med = np.nanmedian(cube, axis=0)
        sd = 1.4826 * np.nanmedian(np.abs(cube - med), axis=0)
        sd[sd == 0] = np.inf
        cube[np.abs(cube - med) > sigma * sd] = np.nan
    return np.nanmean(cube, axis=0)


class TanWCS:
    def __init__(self, crval, crpix, cd, a=None, b=None):
        self.ra0, self.dec0 = float(crval[0]) * D2R, float(crval[1]) * D2R
        self.crpix = np.asarray(crpix, dtype=float)          # FITS 1-based
        self.cd = np.asarray(cd, dtype=float)                # deg / pixel
        self.cdi = np.linalg.inv(self.cd)
        self.a = a or {}                                     # {(p, q): coeff}
        self.b = b or {}

    @classmethod
    def from_header(cls, h) -> "TanWCS":
        if not (str(h["CTYPE1"]).startswith("RA---TAN") and str(h["CTYPE2"]).startswith("DEC--TAN")):
            raise ValueError(f"unsupported projection {h['CTYPE1']} / {h['CTYPE2']}")
        if abs(float(h.get("LONPOLE", 180.0)) - 180.0) > 1e-9:
            raise ValueError("LONPOLE != 180 is not supported")
        if "CD1_1" in h:
            cd = [[h["CD1_1"], h.get("CD1_2", 0.0)], [h.get("CD2_1", 0.0), h["CD2_2"]]]
        else:
            pc = np.array([[h.get("PC1_1", 1.0), h.get("PC1_2", 0.0)], [h.get("PC2_1", 0.0), h.get("PC2_2", 1.0)]])
            cd = np.diag([h["CDELT1"], h["CDELT2"]]) @ pc
        sip = {"A": {}, "B": {}}
        for k in sip:
            order = int(h.get(f"{k}_ORDER", 0))
            for p in range(order + 1):
                for q in range(order + 1 - p):
                    v = h.get(f"{k}_{p}_{q}")
                    if v:
                        sip[k][(p, q)] = float(v)
        return cls((h["CRVAL1"], h["CRVAL2"]), (h["CRPIX1"], h["CRPIX2"]), cd, sip["A"], sip["B"])

    @staticmethod
    def _poly(c, u, v):
        out = np.zeros_like(u, dtype=float)
        for (p, q), coeff in c.items():
            out = out + coeff * u ** p * v ** q
        return out

    def pix2world(self, x, y):
        u = np.asarray(x, dtype=float) - (self.crpix[0] - 1)
        v = np.asarray(y, dtype=float) - (self.crpix[1] - 1)
        f, g = u + self._poly(self.a, u, v), v + self._poly(self.b, u, v)
        xi = (self.cd[0, 0] * f + self.cd[0, 1] * g) * D2R
        eta = (self.cd[1, 0] * f + self.cd[1, 1] * g) * D2R
        den = np.cos(self.dec0) - eta * np.sin(self.dec0)
        ra = self.ra0 + np.arctan2(xi, den)
        dec = np.arctan2(np.sin(self.dec0) + eta * np.cos(self.dec0), np.hypot(xi, den))
        return (ra / D2R) % 360.0, dec / D2R

    def world2pix(self, ra, dec):
        ra, dec = np.asarray(ra, dtype=float) * D2R, np.asarray(dec, dtype=float) * D2R
        dra = ra - self.ra0
        cosc = np.sin(self.dec0) * np.sin(dec) + np.cos(self.dec0) * np.cos(dec) * np.cos(dra)
        xi = np.cos(dec) * np.sin(dra) / cosc / D2R
        eta = (np.cos(self.dec0) * np.sin(dec) - np.sin(self.dec0) * np.cos(dec) * np.cos(dra)) / cosc / D2R
        big_u = self.cdi[0, 0] * xi + self.cdi[0, 1] * eta
        big_v = self.cdi[1, 0] * xi + self.cdi[1, 1] * eta
        u, v = big_u, big_v
        for _ in range(8):   # invert the SIP polynomial by fixed-point iteration
            u, v = big_u - self._poly(self.a, u, v), big_v - self._poly(self.b, u, v)
        return u + (self.crpix[0] - 1), v + (self.crpix[1] - 1)


def sky_grid(ra: float, dec: float, fov_arcsec: float, pixscale: float) -> tuple[TanWCS, int]:
    """North-up, east-left tangent-plane grid centred on (ra, dec); returns (wcs, side)."""
    n = int(round(fov_arcsec / pixscale)) | 1
    s = pixscale / 3600.0
    return TanWCS((ra, dec), ((n + 1) / 2, (n + 1) / 2), [[-s, 0.0], [0.0, s]]), n
