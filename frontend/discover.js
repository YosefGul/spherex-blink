// SPHEREx Blink discovery tools: motion of the marked source, catalogue check, candidates, change list,
// menus, help, tour and the phone sheet. AI-assisted code (Claude Code).
// Everything here is measured in the browser from the stacked images. It is an aid for the eye, not calibrated astrometry.
"use strict";

const F = { near: {}, lastPick: null, anchorNext: null, ep0: null, anchor: null, marked: false, watched: false, savedKey: "", motion: null, motionKey: "", changes: null, changesKey: "", tourStep: 0 };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const arcsec = v => (Math.abs(v) < 60 ? `${v.toFixed(1)}″` : `${(v / 60).toFixed(1)}′`);
const signed = v => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}″`;
const pickKey = () => (S.pick ? `${S.ra}:${S.dec}:${S.pick.ra.toFixed(5)}:${S.pick.dec.toFixed(5)}` : "");

// ---------- motion of the marked source ----------
function medianOf(vals) { vals.sort((a, b) => a - b); return vals.length ? vals[vals.length >> 1] : 0; }
function peaksNear(img, n, cx, cy, rs) {      // local maxima of the 3×3 brightness within rs pixels, brightest first
  const box = (i, j) => { let t = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v = img[(j + dj) * n + i + di]; if (Number.isFinite(v)) t += v; } return t; };
  const out = [];
  for (let j = Math.max(2, Math.floor(cy - rs)); j <= Math.min(n - 3, Math.ceil(cy + rs)); j++) {
    for (let i = Math.max(2, Math.floor(cx - rs)); i <= Math.min(n - 3, Math.ceil(cx + rs)); i++) {
      if ((i - cx) ** 2 + (j - cy) ** 2 > rs * rs) continue;
      const t = box(i, j);
      let top = true;
      for (let dj = -1; dj <= 1 && top; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && box(i + di, j + dj) > t) { top = false; break; }
      if (top) out.push([i, j, t]);
    }
  }
  out.sort((p, q) => q[2] - p[2]);
  return out.length ? out.slice(0, 6) : [[Math.round(cx), Math.round(cy), 0]];
}
function centroid(img, n, cx, cy, r, sig) {   // flux-weighted centre above the local sky, and how clearly it stands out
  const ring = [], R = Math.ceil(r + 4);
  for (let j = Math.round(cy) - R; j <= Math.round(cy) + R; j++) for (let i = Math.round(cx) - R; i <= Math.round(cx) + R; i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const d = Math.hypot(i - cx, j - cy), v = img[j * n + i];
    if (d > r + 1 && d <= r + 4 && Number.isFinite(v)) ring.push(v);
  }
  const bg = medianOf(ring);
  let x = cx, y = cy, flux = 0, np = 0, holes = 0;
  for (let it = 0; it < 3; it++) {
    let sw = 0, sx = 0, sy = 0; flux = 0; np = 0; holes = 0;
    for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
      if (i < 0 || j < 0 || i >= n || j >= n || Math.hypot(i - x, j - y) > r) continue;
      const v = img[j * n + i];
      if (!Number.isFinite(v)) { holes++; continue; }
      const w = Math.max(0, v - bg);
      sw += w; sx += w * i; sy += w * j; flux += v - bg; np++;
    }
    if (!sw || !np) return null;
    x = sx / sw; y = sy / sw;
  }
  return { x, y, flux, holes, snr: flux / (sig * Math.sqrt(np)) };
}
// The empty (saturated or masked) region that touches a window of radius r around (x, y), if it is a closed hole.
function holeAt(img, n, x, y, r) {
  const seen = new Set(), todo = [];
  for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(n - 1, Math.ceil(y + r)); j++) for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(n - 1, Math.ceil(x + r)); i++)
    if (Math.hypot(i - x, j - y) <= r && !Number.isFinite(img[j * n + i])) todo.push(j * n + i);
  let cnt = 0, hx = 0, hy = 0;
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    const i = p % n, j = (p - i) / n;
    if (i === 0 || j === 0 || i === n - 1 || j === n - 1 || ++cnt > 600) return null;     // runs off the image: an edge, not a star
    hx += i; hy += j;
    for (const q of [p + 1, p - 1, p + n, p - n]) if (!Number.isFinite(img[q]) && !seen.has(q)) todo.push(q);
  }
  return cnt ? { cnt, x: hx / cnt, y: hy / cnt } : null;
}
// Measure what sits at pixel (bx, by). A saturated star has an empty core: a small window then follows the rim
// of the hole. Such a star is measured from the middle of the hole, with a window that takes in its wings.
function sourceHere(img, n, ps, sig, bx, by) {
  const r = Math.max(2, 9 / ps);
  let c = centroid(img, n, bx, by, r, sig);
  const hole = !c || c.holes ? holeAt(img, n, c ? c.x : bx, c ? c.y : by, r) : null;
  if (hole) {
    const rh = Math.sqrt(hole.cnt / Math.PI), w = centroid(img, n, hole.x, hole.y, Math.max(15 / ps, 2.5 * rh + 2), sig);
    if (!w || Math.hypot(w.x - hole.x, w.y - hole.y) > rh + 2) return null;
    w.sat = true; w.rh = rh; c = w;
  } else if (!c || Math.hypot(c.x - bx, c.y - by) > 0.6 * r) return null;     // a slope (the wing of a bright star), not a source
  if (c.snr < 5) return null;
  c.err = c.sat ? Math.max(1.5, 0.2 * c.rh * ps) : Math.max(0.3, 6.2 / c.snr);     // rough 1σ position error, arcsec
  return c;
}
// Find a source within rs pixels of (x, y). Without ref: the brightest one. With ref (the same source in another
// visit): the nearest one of about the same brightness, so that the search does not hop to a neighbour.
function locate(img, n, ps, sig, x, y, rs, ref) {
  let best = null;
  for (const [bx, by] of peaksNear(img, n, x, y, rs)) {
    const c = sourceHere(img, n, ps, sig, bx, by);
    if (!c) continue;
    if (!ref) { if (!best || c.flux > best.flux) best = c; continue; }
    const q = c.flux / ref.flux, lim = c.sat || ref.sat ? 3 : 2;
    if (q < 1 / lim || q > lim) continue;
    c.d = Math.hypot(c.x - x, c.y - y);
    if (!best || c.d < best.d) best = c;
  }
  return best;
}
function measureMotion() {
  const st = S.stacks[S.det], eps = S.meta?.epochs;
  if (!st || !eps || !S.pick) return null;
  const n = st.n, ps = st.pixscale, E = st.epochs;
  const have = E.map((e, i) => (e.img ? i : -1)).filter(i => i >= 0);
  if (!have.length) return { none: true };
  const want = F.anchor ?? eps.length - 1;
  const anchor = have.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  const p0 = skyToPix(S.pick.ra, S.pick.dec, n, ps), pts = new Array(E.length).fill(null);
  const at = (i, cx, cy, rs, ref) => { const e = E[i]; e.sig ??= Sky.sigma(e.img); return locate(e.img, n, ps, e.sig, cx, cy, rs, ref); };
  const a = at(anchor, p0.ix, p0.iy, Math.max(1.5, 7 / ps));
  if (!a) return { faint: true, anchor };
  pts[anchor] = a;
  for (const dir of [-1, 1]) {               // follow the source outwards from the visit where it was marked
    let prev = a;
    for (let k = have.indexOf(anchor) + dir; k >= 0 && k < have.length; k += dir) {
      const c = at(have[k], prev.x, prev.y, 14 / ps, a);
      if (c) { pts[have[k]] = c; prev = c; }
    }
  }
  const ok = pts.map((p, i) => (p ? i : -1)).filter(i => i >= 0), i0 = ok[0], i1 = ok[ok.length - 1];
  const out = pts.map((p, i) => p && ({ i, x: p.x, y: p.y, snr: p.snr, err: p.err, sat: !!p.sat,
    east: -(p.x - pts[i0].x) * ps, north: (p.y - pts[i0].y) * ps, ...pixToSky(p.x, p.y, n, ps) })).filter(Boolean);
  const last = out[out.length - 1], first = out[0];
  const shift = Math.hypot(last.east, last.north), err = Math.hypot(first.err, last.err), years = (eps[i1].mjd - eps[i0].mjd) / 365.25;
  // A real mover drifts steadily. Positions that jump about between visits are a blend or a hop to a neighbour.
  let steady = true;
  for (const p of out.slice(1, -1)) {
    const f = (eps[p.i].mjd - eps[i0].mjd) / (eps[i1].mjd - eps[i0].mjd || 1);
    if (Math.hypot(p.east - f * last.east, p.north - f * last.north) > Math.max(3 * p.err, 3)) steady = false;
  }
  const big = ok.length > 1 && shift > Math.max(3 * err, 1.5);
  return { pts: out, anchor, shift, err, years, east: last.east, north: last.north, rate: years > 0.05 ? shift / years : null,
    moved: big && steady, jumpy: big && !steady, faint: false, weak: Math.min(...out.map(p => p.snr)) < 20,
    missing: have.length - ok.length, sat: out.some(p => p.sat) };
}
function motion() {
  const key = `${S.token}:${S.det}:${pickKey()}:${F.anchor}:${S.stacks[S.det] ? 1 : 0}`;
  if (F.motionKey !== key) { F.motionKey = key; F.motion = measureMotion(); }
  return F.motion;
}
function renderMotion() {
  const m = motion(), eps = S.meta?.epochs || [], n = eps.length, nums = $("nums"), plot = $("plot");
  const tx = (x, y, s, anchor = "start") => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" fill="var(--text-secondary)" font-family="var(--sans)">${s}</text>`;
  const frame = inner => `<svg viewBox="0 0 140 140" width="100%" height="100%" aria-hidden="true"><path d="M70 0V140M0 70H140" stroke="var(--border-subtle)" stroke-width="1"/>${tx(76, 15, "N")}${tx(7, 84, "E")}${inner}</svg>`;
  if (!m || m.none || m.faint) {
    plot.innerHTML = frame("");
    nums.innerHTML = !m ? `<p class="t-caption c-3" style="margin:0">Waiting for the image.</p>`
      : `<p class="t-label" style="margin:0">Nothing measurable here</p><p class="t-caption c-3" style="margin:0">${m.none ? `No D${S.det} exposures at this position.` : `No source stands out at the marker in D${S.det} (signal below 5σ). Click a source in the image, or try another band.`}</p>`;
    return;
  }
  const half = Math.max(1.5, ...m.pts.map(p => Math.max(Math.abs(p.east - m.east / 2), Math.abs(p.north - m.north / 2)) + p.err)) * 1.25;
  const sx = p => 70 - (p.east - m.east / 2) / half * 58, sy = p => 70 - (p.north - m.north / 2) / half * 58;
  plot.innerHTML = frame(`<polyline points="${m.pts.map(p => `${sx(p).toFixed(1)},${sy(p).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--text-muted)" stroke-width="1"/>`
    + m.pts.map(p => `<circle cx="${sx(p).toFixed(1)}" cy="${sy(p).toFixed(1)}" r="${Math.max(2, p.err / half * 58).toFixed(1)}" fill="${epochVar(p.i, n)}" fill-opacity=".18"/><circle cx="${sx(p).toFixed(1)}" cy="${sy(p).toFixed(1)}" r="3.5" fill="${epochVar(p.i, n)}"/>`).join("")
    + (m.pts.length > 1 ? [m.pts[0], m.pts[m.pts.length - 1]].map(p => tx(Math.min(134, Math.max(6, sx(p))), sy(p) + (sy(p) < 70 ? -9 : 18), esc(shortLabel(eps[p.i])), sx(p) > 96 ? "end" : sx(p) < 44 ? "start" : "middle")).join("") : ""));
  const c = catalogueCheck(), cs = c?.best?.s, months = Math.round(m.years * 12), comp = (v, pos, neg) => `${Math.abs(v).toFixed(1)}″ ${v >= 0 ? pos : neg}`;
  const lost = m.missing ? ` · not found in ${m.missing} visit${m.missing === 1 ? "" : "s"}` : "";
  nums.innerHTML = m.pts.length < 2 ? `<p class="t-title" style="margin:0">One visit only</p><p class="t-caption c-3" style="margin:0">A shift needs the source in at least two D${S.det} visits.</p>`
    : m.moved ? `<p class="t-heading" style="margin:0">${arcsec(m.shift)}</p>
       <p class="t-caption c-2" style="margin:0">in ${months < 24 ? `${months} month${months === 1 ? "" : "s"}` : `${m.years.toFixed(1)} years`} · ±${m.err.toFixed(1)}″${m.sat ? " · saturated" : ""}${m.weak ? " · faint, check by eye" : ""}${lost}</p>
       <p class="t-mono c-2" style="margin:0">${comp(m.east, "E", "W")} · ${comp(m.north, "N", "S")}</p>
       ${m.rate ? `<p class="t-mono" style="margin:0">${m.rate.toFixed(1)}″/yr measured</p>` : ""}
       ${cs && cs.pm_snr >= 3 ? `<p class="t-mono c-3" style="margin:0">${(Math.hypot(cs.pmra, cs.pmdec) / 1000).toFixed(1)}″/yr catalogue</p>` : ""}`
    : m.jumpy ? `<p class="t-title" style="margin:0">No steady shift</p><p class="t-caption c-3" style="margin:0">The position jumps between visits instead of drifting one way: probably a blend with a neighbour, not a moving source.</p>`
    : `<p class="t-title" style="margin:0">No significant shift</p><p class="t-mono c-2" style="margin:0">${m.shift.toFixed(1)}″ ± ${m.err.toFixed(1)}″</p>
       <p class="t-caption c-3" style="margin:0">${esc(shortLabel(eps[m.pts[0].i]))} to ${esc(shortLabel(eps[m.pts[m.pts.length - 1].i]))} · D${S.det}${lost}</p>`;
}
App.on("overlay", (ctx, dpr) => {           // measured path of the marked source, drawn on the image
  const m = motion(), n = S.meta?.epochs.length || 0;
  if (!S.ov.trail || !m?.moved) return;
  const xy = m.pts.map(p => App.toScreen(p.ra, p.dec));
  ctx.strokeStyle = "rgba(250,250,250,.55)"; ctx.lineWidth = 1.2 * dpr; ctx.beginPath();
  xy.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  xy.forEach(([x, y], k) => { ctx.fillStyle = epochColor(m.pts[k].i, n); ctx.beginPath(); ctx.arc(x, y, 3.5 * dpr, 0, 2 * Math.PI); ctx.fill(); });
});

// ---------- catalogue check ----------
const MATCH_ARCSEC = 6;
// A wide field lists only the brightest few hundred sources. For the check, ask again just around the marked spot.
function nearCats() {
  if (!S.pick) return;
  for (const name of ["gaia", "catwise"]) {
    const k = `${name}:${pickKey()}`;
    if (!S.cats[name]?.truncated || F.near[k]) continue;
    F.near[k] = { state: "loading" };
    const token = S.token;
    Sky.api(`/api/catalog?name=${name}&ra=${S.pick.ra.toFixed(4)}&dec=${S.pick.dec.toFixed(4)}&fov=120`)
      .then(r => { F.near[k] = { state: "ok", sources: r.sources }; })
      .catch(() => { F.near[k] = { state: "error" }; })
      .finally(() => { if (token === S.token) App.render(); });
  }
}
function catSources(name) {
  if (!S.cats[name]?.truncated) return { list: S.cats[name]?.sources || [], state: S.catState[name] };
  const near = F.near[`${name}:${pickKey()}`];
  return { list: near?.sources || [], state: near?.state || "loading" };
}
function catalogueCheck() {
  if (!S.meta?.epochs.length || !S.pick) return null;
  nearCats();
  const m = motion(), cur = m?.pts?.find(p => p.i === S.ep) || m?.pts?.find(p => p.i === m.anchor), pos = cur || S.pick;
  const year = mjdYear(S.meta.epochs[cur ? cur.i : S.ep].mjd);
  let best = null;
  for (const name of ["gaia", "catwise"]) {
    let near = null;
    for (const s of catSources(name).list) {
      const c = sourceAt(s, year), d = Math.hypot((c.ra - pos.ra) * Math.cos(pos.dec * D2R), c.dec - pos.dec) * 3600;
      if (d > MATCH_ARCSEC) continue;
      // the nearest one, unless a source ten times brighter is also inside the circle: that one fills the SPHEREx pixel
      if (!near || (s.mag ?? 99) < (near.s.mag ?? 99) - 2.5 || (d < near.d && (s.mag ?? 99) < (near.s.mag ?? 99) + 2.5)) near = { d, s, name };
    }
    if (near && (!best || near.d < best.d)) best = near;
  }
  const st = ["gaia", "catwise"].map(k => catSources(k).state);
  return { best, loading: st.includes("loading") || st.includes(undefined), failed: ["gaia", "catwise"].filter(k => catSources(k).state === "error") };
}
function checkText(c) {
  if (!c) return "";
  if (c.best) { const s = c.best.s, pm = Math.hypot(s.pmra, s.pmdec); return `Known: ${CATS[c.best.name].label}, ${CATS[c.best.name].unit} ${s.mag == null ? "?" : s.mag.toFixed(1)}${s.pm_snr >= 3 ? `, ${(pm / 1000).toFixed(2)}″/yr` : ""}`; }
  if (c.loading) return "";
  return c.failed.length === 2 ? "Catalogues not reachable" : `Not in ${c.failed.length ? CATS[c.failed[0] === "gaia" ? "catwise" : "gaia"].label : "Gaia DR3 or CatWISE2020"}`;
}
function renderCheck() {
  const c = catalogueCheck(), el = $("check");
  if (!c) { el.innerHTML = ""; return; }
  if (c.best) {
    const s = c.best.s;
    el.innerHTML = `<span class="res t-body c-2" title="${esc(String(s.id))}"><span class="ok">${ico("check", 16)}</span>${CATS[c.best.name].label} · ${CATS[c.best.name].unit} ${s.mag == null ? "?" : s.mag.toFixed(1)} · ${c.best.d.toFixed(1)}″ away</span><span class="tag">Known object</span>`;
  } else if (c.loading) {
    el.innerHTML = `<span class="res t-body c-3">${ico("database", 16)}Asking Gaia DR3 and CatWISE2020…</span>`;
  } else {
    const none = c.failed.length === 2, one = c.failed.length === 1 && CATS[c.failed[0] === "gaia" ? "catwise" : "gaia"].label;
    el.innerHTML = `<span class="res t-body c-2"><span class="warn">${ico("alert", 16)}</span>${none ? "The catalogues did not answer" : `No ${one || "Gaia DR3 or CatWISE2020"} source within ${MATCH_ARCSEC}″${one ? ` (${CATS[c.failed[0]].label} did not answer)` : ""}`}</span>${none ? "" : `<span class="tag warn">Not in the catalogues</span>`}`;
  }
}

// ---------- candidates (kept in this browser) ----------
const candidates = () => store.get("spx.candidates", []);
function saveCandidate() {
  const m = motion(), c = catalogueCheck(), eps = S.meta?.epochs || [], list = candidates();
  if (!S.pick || !eps.length) return;
  const item = { id: Date.now().toString(36), saved: new Date().toISOString(), ra: Number(S.pick.ra.toFixed(5)), dec: Number(S.pick.dec.toFixed(5)),
    det: S.det, visits: `${eps[0].label} – ${eps[eps.length - 1].label}`, shift: m?.moved ? Number(m.shift.toFixed(2)) : null, shift_err: m?.pts ? Number(m.err.toFixed(2)) : null,
    rate: m?.moved && m.rate ? Number(m.rate.toFixed(2)) : null, catalogue: checkText(c) || "not checked", note: "", url: App.pageUrl() };
  list.unshift(item);
  if (!store.set("spx.candidates", list)) { toast("This browser does not allow saving here."); return; }
  F.savedKey = pickKey();
  toast(`Saved. ${list.length} candidate${list.length === 1 ? "" : "s"} in this browser.`);
  renderFindings();
}
function candLine(c) {
  return [`D${c.det}`, c.visits, c.shift != null ? `shift ${c.shift}″${c.rate ? ` (${c.rate}″/yr)` : ""}` : "no significant shift", c.catalogue].join(" · ");
}
function openCandidates() {
  const draw = () => {
    const list = candidates();
    $("modal").innerHTML = `<div class="cands" role="dialog" aria-label="My candidates">
      <div class="row between"><h2 class="t-title">My candidates</h2><span class="count c-2">${list.length}</span></div>
      ${list.length ? list.map(c => `<div class="cand" data-id="${c.id}"><span class="t-mono">${fmtPos(c.ra, c.dec)}</span><span class="t-caption c-3">${esc(candLine(c))}</span>
        <input type="text" value="${esc(c.note || "")}" placeholder="Add a note" aria-label="Note" maxlength="200">
        <div class="acts"><button type="button" data-act="open">Open</button><button type="button" class="c-2" data-act="copy">Copy link</button><button type="button" class="c-3" data-act="remove">Remove</button></div></div>`).join("")
      : `<p class="t-body c-3" style="margin:0">Nothing saved yet. Mark a source in the image and press “Save as candidate”.</p>`}
      <p class="t-caption c-3" style="margin:0">Kept in this browser only. Nothing is sent to a server.</p>
      <div class="row between"><div class="row"><button type="button" class="pill sm" data-act="csv" ${list.length ? "" : "disabled"}>${ico("download", 12)}Export CSV</button><button type="button" class="pill sm" data-act="text" ${list.length ? "" : "disabled"}>Copy as text</button></div><button type="button" class="pill sm primary" data-act="close">Close</button></div></div>`;
  };
  draw(); openModal();
  $("modal").onchange = ev => {
    const id = ev.target.closest(".cand")?.dataset.id, list = candidates(), c = list.find(x => x.id === id);
    if (c) { c.note = ev.target.value; store.set("spx.candidates", list); }
  };
  $("modal").onclick = ev => {
    if (ev.target === $("modal")) return closeModal();
    const act = ev.target.closest("[data-act]")?.dataset.act, id = ev.target.closest(".cand")?.dataset.id, list = candidates(), c = list.find(x => x.id === id);
    if (act === "close") closeModal();
    else if (act === "open" && c) location.href = c.url;
    else if (act === "copy" && c) copy(c.url, "Link copied");
    else if (act === "remove" && c) { store.set("spx.candidates", list.filter(x => x.id !== id)); draw(); renderFindings(); }
    else if (act === "csv") {
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = ["ra_deg,dec_deg,band,visits,shift_arcsec,shift_error_arcsec,rate_arcsec_per_yr,catalogue,note,saved_utc,link",
        ...list.map(x => [x.ra, x.dec, `D${x.det}`, q(x.visits), x.shift ?? "", x.shift_err ?? "", x.rate ?? "", q(x.catalogue), q(x.note), x.saved, q(x.url)].join(","))];
      App.download("spherex_candidates.csv", new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
    } else if (act === "text") copy(list.map(x => `${fmtPos(x.ra, x.dec)}  ${candLine(x)}${x.note ? `  — ${x.note}` : ""}\n${x.url}`).join("\n\n"), "Copied");
  };
}
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast("Copying is blocked in this browser."); }
}

// ---------- changes in the field (first visit against the last one) ----------
function findChanges() {
  const st = S.stacks[S.det], eps = S.meta?.epochs;
  if (!st || !eps) return null;
  const E = st.epochs, a = E.findIndex(e => e.img), b = E.findLastIndex(e => e.img);
  if (a < 0 || a === b) return { single: true };
  const n = st.n, ps = st.pixscale, A = E[a].img, B = E[b].img, d = new Float32Array(A.length);
  for (let p = 0; p < d.length; p++) d[p] = B[p] - A[p];
  const sig = Sky.sigma(d), mar = Math.ceil(9 / ps) + 1, cand = [];
  for (let j = mar; j < n - mar; j++) for (let i = mar; i < n - mar; i++) {
    const p = j * n + i, v = d[p], av = Math.abs(v);
    if (!(av > 8 * sig) || av < 0.15 * Math.max(Math.abs(A[p]), Math.abs(B[p]))) continue;   // real, and not the rim of a bright star
    let top = true;
    for (let dj = -1; dj <= 1 && top; dj++) for (let di = -1; di <= 1; di++) if (Math.abs(d[p + dj * n + di]) > av) { top = false; break; }
    if (top) cand.push({ i, j, v });
  }
  cand.sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
  const keep = [];
  for (const c of cand) { if (keep.every(k => Math.hypot(k.i - c.i, k.j - c.j) > 12 / ps)) keep.push(c); if (keep.length >= 14) break; }
  const bgA = medianOf(Array.from(A).filter((v, k) => k % 7 === 0 && Number.isFinite(v))), bgB = medianOf(Array.from(B).filter((v, k) => k % 7 === 0 && Number.isFinite(v)));
  const sum = (img, bg, c) => { let s = 0, r = 9 / ps; for (let j = Math.floor(c.j - r); j <= c.j + r; j++) for (let i = Math.floor(c.i - r); i <= c.i + r; i++) { const v = img[j * n + i]; if (Math.hypot(i - c.i, j - c.j) <= r && Number.isFinite(v)) s += v - bg; } return s; };
  const apSig = 4 * sig * Math.sqrt(Math.PI) * 9 / ps, rows = [], used = new Set();
  const pk = S.pick && skyToPix(S.pick.ra, S.pick.dec, n, ps);
  const where = c => {
    if (pk && Math.hypot(c.i - pk.ix, c.j - pk.iy) * ps <= 9) return "marked source";
    const e = -(c.i - (n - 1) / 2) * ps, nn = (c.j - (n - 1) / 2) * ps, dist = Math.hypot(e, nn);
    if (dist < 6) return "centre";
    const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(Math.atan2(e, nn) / (Math.PI / 4) + 8) % 8];
    return `${arcsec(dist)} ${dir}`;
  };
  // Moved or changed? Follow the source from one visit to the other, as for the marked source: the same
  // brightness a little way off is a move; a spot of a difference image alone cannot tell the two apart.
  const sA = (E[a].sig ??= Sky.sigma(A)), sB = (E[b].sig ??= Sky.sigma(B));
  const find = (img, sg, x, y, rs, ref) => locate(img, n, ps, sg, x, y, rs, ref);
  keep.forEach((c, k) => {
    if (used.has(k)) return;
    const up = c.v > 0, here = find(up ? B : A, up ? sB : sA, c.i, c.j, 6 / ps), there = here && find(up ? A : B, up ? sA : sB, here.x, here.y, 14 / ps, here);
    const dist = there ? Math.hypot(here.x - there.x, here.y - there.y) * ps : 0;
    if (there && dist > Math.max(1.5, 3 * Math.hypot(here.err, there.err))) {
      const now = up ? here : there;         // where it is in the last visit
      keep.forEach((o, m) => { if ([here, there].some(q => Math.hypot(o.i - q.x, o.j - q.y) < (q.sat ? 30 : 12) / ps)) used.add(m); });
      rows.push({ kind: "Moved", amount: arcsec(dist), c: { i: now.x, j: now.y }, rank: Math.abs(c.v) * 2 });
      return;
    }
    used.add(k);
    if (here?.sat) {                         // the rim of a saturated star: one entry for the star, and no percentage
      keep.forEach((o, m) => { if (Math.hypot(o.i - here.x, o.j - here.y) < 2.5 * here.rh + 2 + 12 / ps) used.add(m); });
      rows.push({ kind: up ? "Brightened" : "Faded", amount: "saturated", c: { i: here.x, j: here.y }, rank: Math.abs(c.v) });
      return;
    }
    const fa = sum(A, bgA, c), fb = sum(B, bgB, c), base = up ? fa : fb;
    const pct = base > apSig ? Math.abs((fb - fa) / fa * 100) : null;
    if (pct !== null && pct < 10) return;      // a few per cent on a bright star is how the pixels fell, not a change
    const amount = pct !== null ? `${up ? "+" : "−"}${Math.min(999, pct).toFixed(0)}%` : "";
    rows.push({ kind: up ? (amount ? "Brightened" : "Appeared") : (amount ? "Faded" : "Gone"), amount, c, rank: Math.abs(c.v) });
  });
  rows.sort((x, y) => y.rank - x.rank);
  return { a, b, rows: rows.slice(0, 5).map(r => ({ ...r, where: where(r.c), ...pixToSky(r.c.i, r.c.j, n, ps) })) };
}
function changes() {
  const key = `${S.token}:${S.det}:${S.stacks[S.det] ? 1 : 0}:${pickKey()}`;
  if (F.changesKey !== key) { F.changesKey = key; F.changes = findChanges(); }
  return F.changes;
}
function renderChanges() {
  const c = changes(), eps = S.meta?.epochs || [], el = $("changes"), bd = $("badges");
  bd.innerHTML = "";
  if (!c) { el.innerHTML = `<p class="t-caption c-3" style="margin:0">Waiting for the image.</p>`; return; }
  if (c.single) { el.innerHTML = `<p class="t-caption c-3" style="margin:0">A comparison needs D${S.det} exposures in at least two visits.</p>`; return; }
  const head = `${eps[c.a].label} against ${eps[c.b].label}, D${S.det}`;
  if (!c.rows.length) { el.innerHTML = `<p class="t-caption c-3" style="margin:0">Nothing changed by more than 8σ. ${head}.</p>`; return; }
  el.innerHTML = c.rows.map((r, k) => `<button type="button" class="chg" data-k="${k}"><span class="what"><span class="badge">${k + 1}</span><span class="t-label">${r.kind}</span><span class="t-mono c-3">${r.where}</span></span><span class="t-mono c-2">${r.amount}</span></button>`).join("")
    + `<p class="t-caption c-3" style="margin:0">${head}. Found automatically; check each one by eye.</p>`;
  const view = $("view"), dpr = view.width / (view.getBoundingClientRect().width || 1);
  if (S.stacks[S.det] && !S.state) c.rows.forEach((r, k) => {
    const [x, y] = App.toScreen(r.ra, r.dec), b = document.createElement("button");
    b.type = "button"; b.className = "badge"; b.textContent = k + 1; b.dataset.k = k; b.title = `${r.kind}${r.amount ? ` ${r.amount}` : ""}`;
    b.style.left = `${x / dpr}px`; b.style.top = `${y / dpr}px`;
    bd.append(b);
  });
}
function pickChange(ev) {
  const k = ev.target.closest("[data-k]")?.dataset.k, r = k != null && changes()?.rows?.[k];
  if (r) { F.anchorNext = changes().b; App.setPick(r.ra, r.dec); }
}

// ---------- flow strip and the findings panel ----------
function renderFlow() {
  const c = catalogueCheck(), loaded = !!S.stacks[S.det] && !S.state;
  const done = [loaded, loaded && F.watched, loaded && F.marked, loaded && F.marked && !!c && !c.loading, loaded && F.savedKey === pickKey()];
  const cur = done.indexOf(false);
  $("flow").innerHTML = ["Pick", "Watch", "Mark", "Check", "Save"].map((s, i) => `<li class="${done[i] ? "done" : i === cur ? "cur" : ""}"><i></i>${s}</li>`).join("");
}
function renderFindings() {
  if (F.ep0 == null && S.stacks[S.det]) F.ep0 = S.ep;
  if (S.timer || (F.ep0 != null && S.ep !== F.ep0)) F.watched = true;
  if (S.pick !== F.lastPick) {              // a new mark: remember the visit it was made in, the source is followed from there
    F.anchor = F.anchorNext ?? (S.mode === "stack" ? null : S.ep); F.anchorNext = null; F.marked = true; F.lastPick = S.pick;
  }
  renderMotion(); renderCheck(); renderChanges(); renderFlow();
  const saved = F.savedKey === pickKey(), ready = !!S.stacks[S.det] && !S.state;
  $("save").disabled = !ready || saved;
  $("save").classList.toggle("primary", ready && !saved && F.marked);
  $("save").lastElementChild.textContent = saved ? "Saved" : "Save as candidate";
  renderTour();
}
App.on("reset", () => {
  F.lastPick = S.pick; F.anchorNext = null; F.ep0 = null; F.anchor = null; F.watched = false; F.savedKey = ""; F.tourStep = 0; F.near = {};
  F.marked = Math.abs(S.pick.ra - S.ra) > 1e-6 || Math.abs(S.pick.dec - S.dec) > 1e-6;
});
App.on("render", renderFindings);

// ---------- tour (test targets only) ----------
const TOUR = {
  moves: ["Press play. The visits swap in place: the background stars stay put, and one source steps across the field.",
    "Click that source. “Marked source” measures how far it moved between visits and checks the catalogues.",
    "Try Difference. A source that moved shows as a blue spot next to a red one."],
  varies: ["Press play. Nothing moves here; watch the brightness of the star in the centre change between visits.",
    "Click the star. Its spectrum is measured in every exposure; the bright dots belong to the visit on screen.",
    "“Changes in this field” lists what brightened or faded between the first visit and the last."],
};
function renderTour() {
  const el = $("tour"), t = TARGETS.find(t => Math.abs(t.ra - S.ra) < 1e-4 && Math.abs(t.dec - S.dec) < 1e-4);
  const show = t && !S.state && S.stacks[S.det] && F.tourStep < 3 && store.get("spx.tour", "on") !== "off" && !document.body.classList.contains("embed");
  el.hidden = !show;
  if (!show) return;
  const key = `${t.name}:${F.tourStep}`;
  if (el.dataset.k === key) return;
  el.dataset.k = key;
  el.innerHTML = `<span class="t-micro c-3">Tour · ${esc(t.name)} · ${F.tourStep + 1} of 3</span><span class="t-body">${TOUR[t.kind][F.tourStep]}</span>
    <div class="acts"><button type="button" class="next" data-act="next">${F.tourStep < 2 ? "Next" : "Done"}${F.tourStep < 2 ? ico("arrow", 12) : ""}</button><button type="button" class="t-label c-3" data-act="skip">Skip tour</button></div>`;
}

// ---------- popovers and the modal ----------
let popAnchor = null;
function closePop() {
  $("pop").hidden = true; $("pop").innerHTML = "";
  popAnchor?.setAttribute("aria-expanded", "false"); popAnchor = null;
}
function openPop(anchor, html, width, align) {
  if (popAnchor === anchor) return closePop();
  closePop();
  const p = $("pop"), r = anchor.getBoundingClientRect();
  p.innerHTML = html; p.hidden = false; p.style.width = `${width}px`;
  p.style.top = `${r.bottom + 8}px`;
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, align === "right" ? r.right - width : r.left))}px`;
  p.style.transformOrigin = align === "right" ? "top right" : "top left";
  popAnchor = anchor; anchor.setAttribute("aria-expanded", "true");
}
const mi = (icon, title, cap, attrs = "") => `<button type="button" class="mi" role="menuitem" ${attrs}>${icon ? ico(icon, 16) : ""}<span class="tx"><span class="t-label">${title}</span>${cap ? `<span class="t-caption c-3">${cap}</span>` : ""}</span></button>`;
function startItems() {
  const n = candidates().length;
  return mi("refresh", "Pick a patch for me", "A random field away from the Milky Way and the crowded ecliptic poles", 'data-act="pick"')
    + `<span class="t-micro c-3 lbl">Test targets</span>`
    + TARGETS.map((t, i) => `<button type="button" class="mi between${Math.abs(t.ra - S.ra) < 1e-4 && Math.abs(t.dec - S.dec) < 1e-4 ? " hl" : ""}" role="menuitem" data-target="${i}"><span class="t-label">${esc(t.long || t.short)}</span><span class="t-caption c-3">${t.kind}</span></button>`).join("")
    + `<hr class="div"><button type="button" class="mi between" role="menuitem" data-act="cands"><span class="row" style="gap:12px">${ico("star", 16)}<span class="t-label">My candidates</span></span><span class="count c-2">${n}</span></button>`;
}
function shareItems() {
  return mi("link", "Copy link", "position, band, mode", 'data-act="link"') + mi("code", "Copy embed code", "image and timeline only", 'data-act="embed"')
    + mi("target", "Open in Aladin Lite", "the same field in other sky surveys", 'data-act="aladin"')
    + mi("image", "Save image", "PNG of this frame", 'data-act="png"') + mi("download", "Save blink", "GIF of all visits · not available yet", "disabled");
}
function popAction(ev) {
  const t = ev.target.closest("[data-target]"), act = ev.target.closest("[data-act]")?.dataset.act;
  if (!t && !act) return;
  closePop();
  if (t) { const g = TARGETS[t.dataset.target]; App.goTo(g.ra, g.dec, g.det); }
  else if (act === "pick") { const p = App.randomPatch(); App.goTo(p.ra, p.dec); }
  else if (act === "cands") openCandidates();
  else if (act === "link") copy(App.pageUrl(), "Link copied");
  else if (act === "embed") copy(`<iframe src="${App.pageUrl({ embed: 1 })}" width="480" height="540" style="border:0" loading="lazy" title="SPHEREx Blink"></iframe>`, "Embed code copied");
  else if (act === "png") $("view").toBlob(b => b && App.download(`spherex_${S.ra.toFixed(4)}_${S.dec.toFixed(4)}_D${S.det}.png`, b), "image/png");
  else if (act === "aladin") window.open(`https://aladin.cds.unistra.fr/AladinLite/?target=${S.ra.toFixed(5)}%20${S.dec >= 0 ? "%2B" : ""}${S.dec.toFixed(5)}&fov=${(S.fov / 3600 * 1.5).toFixed(3)}&survey=${encodeURIComponent("CDS/P/allWISE/color")}`, "_blank", "noopener");
  else if (act === "help") openHelp();
  else if (act === "theme") Theme.set(Theme.get() === "light" ? "dark" : "light");
}
function openModal() { $("modal").hidden = false; }
function closeModal() { $("modal").hidden = true; $("modal").innerHTML = ""; $("modal").onclick = null; $("modal").onchange = null; }
function openHelp() {
  const keys = [["Space", "Play or pause"], ["← →", "Previous or next visit (or band)"], ["1 – 6", "Band D1 to D6"], ["B", "Blink"], ["D", "Difference"], ["S", "Stack"], ["/", "Type a position"], ["?", "This help"]];
  $("modal").innerHTML = `<div class="modal" role="dialog" aria-label="Help"><div class="mb">
    <h2 class="t-title">How to look for something that moves</h2>
    <p class="t-body c-2" style="margin:0">Enter a position or pick a patch. Play the visits and watch for a source that steps or changes while the rest stays put. Click it: the panel on the right measures its shift, checks Gaia DR3 and CatWISE2020, and shows its spectrum. If no catalogue knows it, save it as a candidate.</p>
    <p class="t-body c-2" style="margin:0">Click marks a source. Double-click moves the centre there.</p>
    <div class="keys">${keys.map(([k, v]) => `<span><span class="kbd">${k}</span></span><span class="t-body c-2">${v}</span>`).join("")}</div>
    <p class="t-caption c-3" style="margin:0">Shifts and changes are measured in your browser from the stacked images. They are a guide for the eye, not calibrated measurements.</p>
    </div><div class="mf"><button type="button" data-act="tour">Show the tour again</button><button type="button" class="pri" data-act="close">Close</button></div></div>`;
  openModal();
  $("modal").onclick = ev => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "tour") { store.set("spx.tour", "on"); F.tourStep = 0; $("tour").dataset.k = ""; closeModal(); App.render(); }
    else if (act === "close" || ev.target === $("modal")) closeModal();
  };
}

// ---------- phone: the panels move into a sheet with three heights ----------
const SHEET_TABS = { find: ["secMotion", "secChanges"], spec: ["secSpectrum"], layers: ["layers", "cut"], matrix: ["navigator"] };
const homes = new Map();
let sheetTab = "find", sheetOn = false, sheetLevel = 1, sheetDragging = false;
function detents() {        // peek, up to the controls, nearly full
  const mid = Math.max(170, Math.round(window.innerHeight - $("timeline").getBoundingClientRect().bottom));
  return [92, mid, Math.max(mid + 120, window.innerHeight - 110)];
}
function setSheet(level) {
  sheetLevel = level;
  $("sheet").classList.remove("dragging");
  $("sheet").classList.toggle("open", level === 2);
  $("sheet").style.setProperty("--sheet-h", `${detents()[level]}px`);
}
function showTab(tab) {
  sheetTab = tab;
  for (const [k, ids] of Object.entries(SHEET_TABS)) for (const id of ids) $(id).hidden = k !== tab;
  document.querySelectorAll("#sheetTabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
  if (sheetLevel === 0) setSheet(1);
  App.render();
}
function syncSheet() {
  const on = phone();
  if (on === sheetOn) return;
  sheetOn = on;
  const ids = Object.values(SHEET_TABS).flat();
  if (on) {
    for (const id of ids) { const el = $(id); homes.set(id, [el.parentNode, el.nextSibling]); $("sheetBody").append(el); }
    setSheet(1); showTab(sheetTab);
  } else {
    for (const id of ids) { const [parent, next] = homes.get(id); parent.insertBefore($(id), next); $(id).hidden = false; }
    App.layout(); App.render();
  }
}
App.on("render", () => { if (sheetOn && !sheetDragging) $("sheet").style.setProperty("--sheet-h", `${detents()[sheetLevel]}px`); });
function sheetDrag() {      // the sheet follows the finger; on release it settles at the height the flick was heading for
  const g = $("grab");
  let y0 = 0, h0 = 0, hist = [];
  g.addEventListener("pointerdown", ev => {
    try { g.setPointerCapture(ev.pointerId); } catch { /* not a live pointer */ }
    sheetDragging = true; y0 = ev.clientY; h0 = $("sheet").getBoundingClientRect().height; hist = [[ev.timeStamp, ev.clientY]];
  });
  g.addEventListener("pointermove", ev => {
    if (!sheetDragging) return;
    const [lo, , hi] = detents(); let h = h0 + (y0 - ev.clientY);
    if (h > hi) h = hi + (h - hi) * 0.25; if (h < lo) h = lo - (lo - h) * 0.25;     // soft edges
    $("sheet").classList.add("dragging"); $("sheet").style.setProperty("--sheet-h", `${Math.round(h)}px`);
    hist.push([ev.timeStamp, ev.clientY]); if (hist.length > 5) hist.shift();
  });
  const end = ev => {
    if (!sheetDragging) return;
    sheetDragging = false;
    const [t0, ya] = hist[0], [t1, yb] = hist[hist.length - 1], v = t1 > t0 ? (ya - yb) / (t1 - t0) * 1000 : 0;   // px/s, up is positive
    const d = detents(), h = $("sheet").getBoundingClientRect().height + v * 0.18;
    const tap = Math.abs(ev.clientY - y0) < 4;
    setSheet(tap ? (sheetLevel + 1) % 3 : d.indexOf(d.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a))));
  };
  g.addEventListener("pointerup", end); g.addEventListener("pointercancel", end);
}

window.addEventListener("DOMContentLoaded", () => {
  $("startBtn").onclick = () => openPop($("startBtn"), startItems(), 300, "left");
  $("shareBtn").onclick = () => openPop($("shareBtn"), shareItems(), 280, "right");
  $("menuBtn").onclick = () => openPop($("menuBtn"), startItems() + `<hr class="div">` + mi("link", "Copy link", "position, band, mode", 'data-act="link"')
    + mi("help", "Help", "", 'data-act="help"') + mi(Theme.get() === "light" ? "moon" : "sun", "Switch theme", "", 'data-act="theme"')
    + `<hr class="div"><div class="row" style="padding:8px;gap:16px;flex-wrap:wrap">${PAGES.map(([, l, h]) => `<a class="t-label c-2" href="${h}">${l}</a>`).join("")}</div>`, 300, "right");
  $("helpBtn").onclick = openHelp;
  $("pop").onclick = popAction;
  $("save").onclick = saveCandidate;
  $("changes").onclick = pickChange; $("badges").onclick = pickChange;
  $("tour").onclick = ev => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "next") { F.tourStep++; renderTour(); } else if (act === "skip") { store.set("spx.tour", "off"); renderTour(); }
  };
  $("sheetTabs").onclick = ev => { const b = ev.target.closest("button"); if (b) showTab(b.dataset.tab); };
  document.addEventListener("pointerdown", ev => { if (popAnchor && !ev.target.closest("#pop") && !popAnchor.contains(ev.target)) closePop(); });
  window.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { closePop(); if (!$("modal").hidden) closeModal(); }
    else if (ev.key === "?" && !/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) openHelp();
  });
  window.addEventListener("resize", () => { closePop(); syncSheet(); });
  sheetDrag(); syncSheet();
});
