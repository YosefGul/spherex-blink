"""Catalogue sources around a position, with proper motions, for drawing over the images.

Two catalogues: Gaia DR3 (optical; ESA Gaia archive) and CatWISE2020 (3.4 and 4.6 micrometres;
IRSA). Each source is returned at the catalogue's reference epoch together with its proper
motion, so the viewer can place it where it was on the date of each SPHEREx epoch.
AI-assisted code (Claude Code).
"""
from __future__ import annotations

import csv
import io

import requests

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
CATWISE_EPOCH = 2000.0 + (57170.0 - 51544.5) / 365.25     # ra_pm/dec_pm refer to MJD 57170
MAX_SOURCES = 400

CATALOGS = {
    "gaia": {"label": "Gaia DR3", "band": "G"},
    "catwise": {"label": "CatWISE2020", "band": "W2"},
}


def _circle(ra: float, dec: float, radius_deg: float) -> str:
    return f"1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.6f}))"


def _rows(url: str, params: dict, read_timeout: int) -> list[dict]:
    r = requests.get(url, params=params, timeout=(10, read_timeout))
    r.raise_for_status()
    if not r.text.lstrip().lower().startswith(("source_id", "source_name")):
        raise RuntimeError(r.text.strip()[:200])
    return list(csv.DictReader(io.StringIO(r.text)))


def _num(text: str | None) -> float | None:
    try:
        v = float(text)
    except (TypeError, ValueError):
        return None
    return v if v == v else None       # drop NaN


def _snr(pmra: float, pmdec: float, era: float | None, edec: float | None) -> float | None:
    """Total proper motion divided by its uncertainty; None if the catalogue gives no motion."""
    if era is None or edec is None or not (era > 0 and edec > 0):
        return None
    return round((pmra ** 2 + pmdec ** 2) ** 0.5 / (era ** 2 + edec ** 2) ** 0.5, 1)


def _gaia(ra: float, dec: float, radius_deg: float) -> list[dict]:
    adql = (f"SELECT TOP {MAX_SOURCES} source_id, ra, dec, pmra, pmdec, pmra_error, pmdec_error, ref_epoch, phot_g_mean_mag "
            f"FROM gaiadr3.gaia_source WHERE {_circle(ra, dec, radius_deg)} ORDER BY phot_g_mean_mag")
    rows = _rows(GAIA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}, 60)
    return [{"id": r["source_id"], "ra": float(r["ra"]), "dec": float(r["dec"]),
             "pmra": _num(r["pmra"]) or 0.0, "pmdec": _num(r["pmdec"]) or 0.0,     # mas/yr
             "pm_snr": _snr(_num(r["pmra"]) or 0.0, _num(r["pmdec"]) or 0.0, _num(r["pmra_error"]), _num(r["pmdec_error"])),
             "epoch": float(r["ref_epoch"]), "mag": _num(r["phot_g_mean_mag"])} for r in rows]


def _catwise(ra: float, dec: float, radius_deg: float) -> list[dict]:
    adql = (f"SELECT TOP {MAX_SOURCES} source_name, ra_pm, dec_pm, pmra, pmdec, sigpmra, sigpmdec, w1mpro_pm, w2mpro_pm "
            f"FROM catwise_2020 WHERE {_circle(ra, dec, radius_deg)} ORDER BY w2mpro_pm")
    rows = _rows(IRSA_TAP, {"FORMAT": "csv", "QUERY": adql}, 180)
    out = []
    for r in rows:
        x, y = _num(r["ra_pm"]), _num(r["dec_pm"])
        if x is None or y is None:
            continue
        out.append({"id": r["source_name"], "ra": x, "dec": y,
                    "pmra": (_num(r["pmra"]) or 0.0) * 1000, "pmdec": (_num(r["pmdec"]) or 0.0) * 1000,   # arcsec -> mas/yr
                    "pm_snr": _snr(_num(r["pmra"]) or 0.0, _num(r["pmdec"]) or 0.0, _num(r["sigpmra"]), _num(r["sigpmdec"])),
                    "epoch": round(CATWISE_EPOCH, 3), "mag": _num(r["w2mpro_pm"])})
    return out


def query(name: str, ra: float, dec: float, fov_arcsec: float) -> dict:
    """Sources within the view (plus a margin for stars that move into it), brightest first.
    pmra is the motion on the sky towards east (it includes cos(dec)), in mas/yr; pm_snr is the
    total motion divided by its uncertainty (None when the catalogue has no motion for the source)."""
    radius_deg = (fov_arcsec * 0.75 + 20) / 3600
    sources = {"gaia": _gaia, "catwise": _catwise}[name](ra, dec, radius_deg)
    return {"name": name, **CATALOGS[name], "ra": ra, "dec": dec, "fov": fov_arcsec,
            "truncated": len(sources) >= MAX_SOURCES, "sources": sources}
