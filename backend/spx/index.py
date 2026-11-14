"""Which SPHEREx Level-2 spectral images cover a sky position.

Queries the IRSA TAP metadata tables (spherex.plane / spherex.artifact) and caches
the answer on disk, because one query takes 20-30 s. AI-assisted code (Claude Code).
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import requests

TAP_SYNC = "https://irsa.ipac.caltech.edu/TAP/sync"
S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
IBE_PREFIX = "ibe/data/spherex/"

MAX_AGE_DAYS = 7           # SPHEREx data reach the archive weekly: ask again after this long

_LOCK = threading.Lock()   # one metadata query at a time; they are slow and cached
_REFRESHING: set[Path] = set()

_NAME = re.compile(r"level2_(?P<obs>\w+?)D(?P<det>[1-6])_spx_(?P<proc>.+)\.fits$")


@dataclass(frozen=True)
class Frame:
    uri: str          # IRSA IBE path, e.g. ibe/data/spherex/dr1/level2/...
    mjd: float        # exposure start
    detector: int     # 1..6
    release: str      # dr1, qr3, ...

    @property
    def s3_url(self) -> str:
        return S3_BASE + self.uri.removeprefix(IBE_PREFIX)

    @property
    def exposure_id(self) -> str:
        m = _NAME.search(self.uri)
        return f"{m['obs']}D{m['det']}" if m else self.uri


def _cache_file(cache_dir: Path, ra: float, dec: float) -> Path:
    return cache_dir / "index" / f"{ra:.4f}_{dec:+.4f}.json"


def _read(path: Path) -> list[Frame]:
    return [Frame(**row) for row in json.loads(path.read_text())]


def age_days(cache_dir: Path, ra: float, dec: float) -> float | None:
    """Days since the list of exposures for this position was last fetched from IRSA."""
    path = _cache_file(cache_dir, ra, dec)
    return (time.time() - path.stat().st_mtime) / 86400 if path.exists() else None


def query_frames(ra: float, dec: float, cache_dir: Path, refresh: bool = False) -> list[Frame]:
    """All spectral images whose footprint contains (ra, dec), oldest first. Kept on disk."""
    path = _cache_file(cache_dir, ra, dec)
    if path.exists() and not refresh:
        return _read(path)
    with _LOCK:
        if path.exists() and not refresh:      # another request fetched it while this one waited
            return _read(path)
        return _query_tap(ra, dec, path)


def refresh_if_old(ra: float, dec: float, cache_dir: Path, max_age_days: float = MAX_AGE_DAYS) -> bool:
    """Fetch the list again in the background when it is older than `max_age_days`, so new
    exposures show up without making anyone wait. True if a refresh was started. If IRSA does
    not answer, the old list stays and the next try is an hour later."""
    path = _cache_file(cache_dir, ra, dec)
    age = age_days(cache_dir, ra, dec)
    if age is None or age <= max_age_days:
        return False
    if path in _REFRESHING:
        return True
    _REFRESHING.add(path)

    def work():
        try:
            with _LOCK:
                _query_tap(ra, dec, path)
        except Exception as exc:
            print(f"index refresh failed for {ra:.4f} {dec:+.4f}, keeping the old list: {exc}")
            retry = time.time() - max_age_days * 86400 + 3600
            os.utime(path, (retry, retry))
        finally:
            _REFRESHING.discard(path)

    threading.Thread(target=work, daemon=True).start()
    return True


def _query_tap(ra: float, dec: float, path: Path) -> list[Frame]:

    adql = (
        "SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname "
        "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.6f}, {dec:.6f}), p.poly) "
        "ORDER BY p.time_bounds_lower"
    )
    # 10 s to connect (fail fast when IRSA is unreachable), 120 s for the query itself.
    resp = requests.get(TAP_SYNC, params={"QUERY": adql, "FORMAT": "csv"}, timeout=(10, 120))
    resp.raise_for_status()

    # The same exposure can be listed under more than one processing run; keep the latest.
    latest: dict[str, Frame] = {}
    for row in csv.DictReader(io.StringIO(resp.text)):
        uri = row["uri"]
        frame = Frame(
            uri=uri,
            mjd=float(row["time_bounds_lower"]),
            detector=int(row["energy_bandpassname"][-1]),
            release=uri.removeprefix(IBE_PREFIX).split("/")[0],
        )
        prev = latest.get(frame.exposure_id)
        if prev is None or frame.uri > prev.uri:
            latest[frame.exposure_id] = frame
    frames = sorted(latest.values(), key=lambda f: f.mjd)

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps([asdict(f) for f in frames]))
    os.replace(tmp, path)
    return frames
