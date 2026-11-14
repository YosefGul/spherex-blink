// SPHEREx Blink viewer. AI-assisted code (Claude Code).
"use strict";

// Present-day (2026) positions for the fast movers; catalogue positions for the variables.
const TARGETS = [
  { name: "Barnard's Star", ra: 269.4463, dec: 4.7680, det: 2 },
  { name: "Eps Indi B", ra: 331.0960, dec: -56.8010, det: 3 },
  { name: "WISE 0855", ra: 133.7598, dec: -7.2422, det: 5 },
  { name: "RW Aur", ra: 76.9563, dec: 30.4014, det: 3 },
  { name: "R Dra", ra: 248.1675, dec: 66.7550, det: 3 },
];
const EPOCH_COLORS = ["#E69F00", "#56B4E9", "#CC79A7", "#009E73", "#F0E442", "#D55E00", "#0072B2"];
const BANDS = {
  1: ["0.75–1.09 µm", "#8E7CF8"], 2: ["1.10–1.62 µm", "#4FA3F7"], 3: ["1.63–2.41 µm", "#2EC4B6"],
  4: ["2.42–3.82 µm", "#A3D55D"], 5: ["3.83–4.41 µm", "#F4A640"], 6: ["4.42–5.00 µm", "#EF5D60"],
};
const D2R = Math.PI / 180;
const $ = id => document.getElementById(id);

const S = { ra: 133.7598, dec: -7.2422, fov: 240, det: 5, mode: "blink", ep: 0, ref: 0, hi: 12,
  fps: 2, timer: null, meta: null, stacks: {}, pending: {}, token: 0,
  pick: null, spec: null, specState: "", specDrawn: [] };
const BAND_UM = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
const PREFETCH_MAX_FRAMES = 600;
const SESAME_MIRRORS = ["https://vizier.cfa.harvard.edu/viz-bin/nph-sesame", "https://cds.unistra.fr/cgi-bin/nph-sesame"];

// ---------- helpers ----------
const epColor = i => EPOCH_COLORS[i % EPOCH_COLORS.length];
const mjdDate = mjd => new Date((mjd - 40587) * 86400000);
const isoDay = mjd => mjdDate(mjd).toISOString().slice(0, 10);

function decode(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function meanImage(imgs) {
  const have = imgs.filter(Boolean);
  if (!have.length) return null;
  const out = new Float32Array(have[0].length);
  for (let p = 0; p < out.length; p++) {
    let s = 0, c = 0;
    for (const im of have) if (Number.isFinite(im[p])) { s += im[p]; c++; }
    out[p] = c ? s / c : NaN;
  }
  return out;
}
function robustSigma(img) {
  const v = Array.from(img).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 1;
  const med = v[v.length >> 1];
  const dev = v.map(x => Math.abs(x - med)).sort((a, b) => a - b);
  return 1.4826 * dev[dev.length >> 1] || 1;
}
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return r.json();
}
function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

// ---------- coordinates ----------
function parseCoord(text) {
  const t = text.trim().replace(/[−–]/g, "-");
  const nums = t.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!nums) return null;
  let ra, dec;
  if (nums.length === 2 && !/[a-z:]/i.test(t)) {
    [ra, dec] = nums.map(Number);
  } else if (nums.length === 6 && /^[\d\s.:hmsd°'"+-]+$/i.test(t)) {
    const [h, m, s, d, dm, ds] = nums.map(x => Math.abs(Number(x)));
    ra = (h + m / 60 + s / 3600) * 15;
    dec = (nums[3].startsWith("-") ? -1 : 1) * (d + dm / 60 + ds / 3600);
  } else return null;
  return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? { ra, dec } : null;
}
async function resolveName(name) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known = TARGETS.find(t => norm(t.name) === norm(name));
  if (known) return known;
  let text = null;
  for (const base of SESAME_MIRRORS) {     // CDS Sesame name resolver; first mirror that answers wins
    try {
      const r = await fetch(`${base}/-oI/SNV?${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { text = await r.text(); break; }
    } catch { /* try the next mirror */ }
  }
  if (text === null) throw new Error("The name resolver did not answer. Enter coordinates instead.");
  const m = text.match(/^%J\s+([\d.]+)\s+([+-]?[\d.]+)/m);
  if (!m) throw new Error(`Could not find "${name}". Enter coordinates instead.`);
  return { ra: Number(m[1]), dec: Number(m[2]) };
}
function skyToPix(ra, dec, n, ps) {   // inverse of pixToSky
  const d0 = S.dec * D2R, d = dec * D2R, da = (ra - S.ra) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  const xi = Math.cos(d) * Math.sin(da) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc;
  return { ix: (n - 1) / 2 - xi / D2R * 3600 / ps, iy: (n - 1) / 2 + eta / D2R * 3600 / ps };
}
function pixToSky(ix, iy, n, ps) {
  const xi = -(ix - (n - 1) / 2) * ps / 3600 * D2R, eta = (iy - (n - 1) / 2) * ps / 3600 * D2R;
  const d0 = S.dec * D2R, den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = S.ra + Math.atan2(xi, den) / D2R;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / D2R;
  return { ra: (ra + 360) % 360, dec };
}

// ---------- data ----------
async function load() {
  const token = ++S.token;
  stop();
  S.meta = null; S.stacks = {}; S.pending = {};
  S.pick = { ra: S.ra, dec: S.dec }; S.spec = null; S.specState = "";
  writeUrl(); syncControls(); buildRail(); $("track").innerHTML = ""; render();
  setStatus("Looking up SPHEREx exposures… A new position takes about 30 s the first time.");
  try {
    const meta = await api(`/api/epochs?ra=${S.ra}&dec=${S.dec}`);
    if (token !== S.token) return;
    S.meta = meta;
    if (!meta.epochs.length) { setStatus("SPHEREx has no released exposures of this position yet.", true); return; }
    S.ep = meta.epochs.length - 1; S.ref = 0;
    buildTrack(); buildRef();
    loadSpectrum(true);
    await ensureDet(S.det, token);
    // Each exposure costs ~0.5 MB of archive reads. Prefetch the other bands for their
    // thumbnails only where that is cheap; elsewhere a band loads when it is selected.
    if (meta.total_frames <= PREFETCH_MAX_FRAMES)
      for (const d of [1, 2, 3, 4, 5, 6]) if (token === S.token) await ensureDet(d, token);
  } catch (e) {
    if (token === S.token) setStatus(e.message, true);
  }
}
function ensureDet(det, token = S.token) {
  if (S.stacks[det]) return Promise.resolve();
  S.pending[det] ??= loadDet(det, token)
    .catch(e => { if (token === S.token && det === S.det) setStatus(e.message, true); })
    .finally(() => { if (token === S.token) delete S.pending[det]; });
  return S.pending[det];
}
async function loadDet(det, token) {
  if (det === S.det) setStatus(`Reading D${det} exposures from the SPHEREx archive…`);
  const r = await api(`/api/stack?ra=${S.ra}&dec=${S.dec}&fov=${S.fov}&det=${det}`);
  if (token !== S.token) return;
  const epochs = r.epochs.map(e => ({ used: e.used, img: e.data ? decode(e.data) : null }));
  const mean = meanImage(epochs.map(e => e.img));
  S.stacks[det] = { n: r.n, pixscale: r.pixscale, epochs, mean, sigma: mean ? robustSigma(mean) : 1 };
  if (det === S.det) {
    setStatus("");
    if (!epochs[S.ep]?.img) S.ep = Math.max(0, epochs.findLastIndex(e => e.img));
    if (!epochs[S.ref]?.img) S.ref = Math.max(0, epochs.findIndex(e => e.img));
    $("ref").value = S.ref;
  }
  render();
}

// ---------- rendering ----------
const off = document.createElement("canvas");

function currentImage(det = S.det) {
  const st = S.stacks[det];
  if (!st) return null;
  const E = st.epochs;
  if (S.mode === "stack") return st.mean && { img: st.mean, div: false };
  if (S.mode === "diff") {
    const a = E[S.ep]?.img, b = E[S.ref]?.img;
    if (!a || !b) return null;
    const key = `${S.ep}:${S.ref}`;
    if (st.diff?.key !== key) {
      const d = new Float32Array(a.length);
      for (let p = 0; p < d.length; p++) d[p] = a[p] - b[p];
      st.diff = { key, img: d, div: true, sigma: robustSigma(d) };   // noise of the difference itself
    }
    return st.diff;
  }
  return E[S.ep]?.img ? { img: E[S.ep].img, div: false } : null;
}
function paint(cur, st) {
  const n = st.n, sig = st.sigma;
  off.width = off.height = n;
  const ctx = off.getContext("2d"), id = ctx.createImageData(n, n), px = id.data;
  const lo = -2 * sig, hi = S.hi * sig, k = Math.asinh(8), dmax = S.hi * (cur.sigma || sig) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = cur.img[j * n + i], o = ((n - 1 - j) * n + i) * 4;   // row 0 is south: flip
      let r = 21, g = 25, b = 34;
      if (Number.isFinite(v)) {
        if (cur.div) {
          const t = Math.min(1, Math.abs(v) / dmax) ** 1.5;   // keeps 1-2σ noise dark
          const c = v < 0 ? [60, 130, 255] : [255, 110, 60];
          r = 16 + (c[0] - 16) * t; g = 18 + (c[1] - 18) * t; b = 24 + (c[2] - 24) * t;
        } else {
          const u = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
          r = g = b = 255 * Math.asinh(8 * u) / k;
        }
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
}
function geometry() {
  const c = $("view"), side = Math.min(c.width, c.height);
  return { side, x0: (c.width - side) / 2, y0: (c.height - side) / 2 };
}
function render() {
  const c = $("view"), dpr = window.devicePixelRatio || 1, box = $("stage").getBoundingClientRect();
  c.width = Math.max(1, Math.round(box.width * dpr)); c.height = Math.max(1, Math.round(box.height * dpr));
  const ctx = c.getContext("2d"), st = S.stacks[S.det], cur = currentImage();
  ctx.fillStyle = "#04060A"; ctx.fillRect(0, 0, c.width, c.height);
  const { side, x0, y0 } = geometry();
  if (cur) {
    paint(cur, st);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, x0, y0, side, side);
    drawOverlay(ctx, x0, y0, side, dpr);
  }
  renderLabels(st, cur);
  renderMeta(st);
  renderSpectrum();
  for (const d of [1, 2, 3, 4, 5, 6]) drawThumb(d);
  document.querySelectorAll(".ep").forEach((b, i) => b.setAttribute("aria-pressed", String(i === S.ep && S.mode !== "stack")));
  document.querySelectorAll(".band").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.det) === S.det)));
  document.querySelectorAll("#modes button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode)));
  $("play").textContent = S.timer ? "❚❚" : "▶";
}
function drawOverlay(ctx, x0, y0, side, dpr) {
  const cx = x0 + side / 2, cy = y0 + side / 2, g = 18 * dpr, l = 16 * dpr;
  ctx.strokeStyle = "rgba(221,230,255,.75)"; ctx.lineWidth = dpr; ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(cx + dx * g, cy + dy * g); ctx.lineTo(cx + dx * (g + l), cy + dy * (g + l));
  }
  ctx.stroke();
  const st = S.stacks[S.det];
  if (S.pick && st) {   // spot whose spectrum is shown; the circle is the photometry aperture
    const p = skyToPix(S.pick.ra, S.pick.dec, st.n, st.pixscale);
    const mx = x0 + (p.ix + 0.5) / st.n * side, my = y0 + (1 - (p.iy + 0.5) / st.n) * side;
    const rad = (S.spec?.aperture_arcsec || 12.3) / S.fov * side;
    ctx.save(); ctx.strokeStyle = "#DDE6FF"; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.arc(mx, my, rad, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
  }
  const arc = S.fov <= 150 ? 15 : S.fov <= 400 ? 30 : 60, len = side / S.fov * arc;
  const bx = x0 + side - 84 * dpr, by = y0 + side - 34 * dpr;
  ctx.fillStyle = "#E8ECF2"; ctx.fillRect(bx - len, by, len, 2 * dpr);
  ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`; ctx.textAlign = "center";
  ctx.fillText(`${arc}″`, bx - len / 2, by + 16 * dpr);
  const ox = x0 + side - 30 * dpr, oy = y0 + side - 22 * dpr, a = 28 * dpr;
  ctx.strokeStyle = "#E8ECF2"; ctx.lineWidth = 1.4 * dpr; ctx.beginPath();
  ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - a); ctx.moveTo(ox, oy); ctx.lineTo(ox - a, oy); ctx.stroke();
  ctx.font = `${10 * dpr}px Inter, system-ui, sans-serif`;
  ctx.fillText("N", ox, oy - a - 4 * dpr); ctx.fillText("E", ox - a - 8 * dpr, oy + 3 * dpr);
}
// ---------- spectrum ----------
async function loadSpectrum(cachedOnly) {
  const token = S.token, pick = S.pick;
  S.spec = null; S.specState = cachedOnly ? "" : "loading"; renderSpectrum();
  try {
    const r = await api(`/api/spectrum?ra=${S.ra}&dec=${S.dec}&fov=${S.fov}&pra=${pick.ra.toFixed(5)}&pdec=${pick.dec.toFixed(5)}${cachedOnly ? "&cached_only=1" : ""}`);
    if (token !== S.token || pick !== S.pick) return;
    S.spec = r.points ? r : null; S.specState = r.points ? "" : "hint";
  } catch (e) {
    if (token !== S.token || pick !== S.pick) return;
    S.specState = "error:" + e.message;
  }
  render();
}
function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
}
function renderSpectrum() {
  const cv = $("spec"), info = $("specInfo"), pts = S.spec?.points, box = cv.getBoundingClientRect();
  $("specCsv").hidden = !pts?.length;
  S.specDrawn = [];
  if (!pts?.length) {
    info.textContent = S.specState === "loading" ? "Measuring every exposure at the marker…"
      : S.specState.startsWith("error:") ? S.specState.slice(6)
      : pts ? "No exposure could be measured at this spot (image edge or saturated pixels)."
      : S.specState === "hint" ? "Click the image to measure the spectrum of that spot. Every exposure there is read, which can take a minute the first time."
      : "";
  }
  if (!box.width) return;                       // side panel hidden on narrow screens
  const dpr = window.devicePixelRatio || 1, W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  if (!pts?.length) return;

  const m = { l: 46 * dpr, r: 8 * dpr, t: 16 * dpr, b: 24 * dpr }, X0 = 0.7, X1 = 5.1;
  const fl = pts.map(p => p.flux).sort((a, b) => a - b), q = f => fl[Math.min(fl.length - 1, Math.floor(f * fl.length))];
  let lo = Math.min(0, q(0.02)), hi = Math.max(q(0.98), lo + 1e-6);
  const pad = (hi - lo) * 0.08; hi += pad; if (lo < 0) lo -= pad;
  const x = lam => m.l + (lam - X0) / (X1 - X0) * (W - m.l - m.r);
  const y = f => H - m.b - (Math.min(hi, Math.max(lo, f)) - lo) / (hi - lo) * (H - m.t - m.b);

  ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`; ctx.textBaseline = "middle";
  for (const d of [1, 2, 3, 4, 5, 6]) {         // detector bands
    const [a, b] = BAND_UM[d];
    if (d % 2) { ctx.fillStyle = "rgba(255,255,255,.035)"; ctx.fillRect(x(a), m.t, x(b) - x(a), H - m.t - m.b); }
    ctx.fillStyle = BANDS[d][1]; ctx.textAlign = "center"; ctx.fillText(`D${d}`, (x(a) + x(b)) / 2, 8 * dpr);
  }
  ctx.strokeStyle = "#262C38"; ctx.fillStyle = "#6B7483"; ctx.lineWidth = dpr;
  for (const v of niceTicks(lo, hi, 4)) {
    ctx.beginPath(); ctx.moveTo(m.l, y(v)); ctx.lineTo(W - m.r, y(v)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(String(Number(v.toPrecision(3))), m.l - 5 * dpr, y(v));
  }
  for (const v of [1, 2, 3, 4, 5]) { ctx.textAlign = "center"; ctx.fillText(String(v), x(v), H - m.b + 9 * dpr); }
  ctx.textAlign = "right"; ctx.fillText("µm", W - m.r, H - 6 * dpr);
  ctx.textAlign = "left"; ctx.fillText("mJy", 4 * dpr, 8 * dpr);

  const lit = p => S.mode === "stack" || p.epoch === S.ep || (S.mode === "diff" && p.epoch === S.ref);
  for (const pass of [false, true]) {           // dimmed epochs first, the shown epoch on top
    for (const p of pts) {
      if (lit(p) !== pass) continue;
      const px = x(p.wavelength), py = y(p.flux);
      ctx.globalAlpha = pass ? 1 : 0.2; ctx.fillStyle = ctx.strokeStyle = epColor(p.epoch);
      if (pass && p.error > (hi - lo) * 0.03) {
        ctx.beginPath(); ctx.moveTo(px, y(p.flux - p.error)); ctx.lineTo(px, y(p.flux + p.error)); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(px, py, (pass ? 2.2 : 1.8) * dpr, 0, 2 * Math.PI); ctx.fill();
      if (pass) S.specDrawn.push({ px: px / dpr, py: py / dpr, p });
    }
  }
  ctx.globalAlpha = 1;
  const eps = S.meta?.epochs || [], which = S.mode === "stack" ? "all epochs"
    : S.mode === "diff" ? `${eps[S.ep]?.label} and ${eps[S.ref]?.label}` : eps[S.ep]?.label;
  const skipped = S.spec.exposures - pts.length;
  info.textContent = `${pts.length} exposures, one dot each${skipped ? ` (${skipped} more skipped: saturated or off the detector edge)` : ""}; bright dots: ${which}. Aperture radius ${S.spec.aperture_arcsec.toFixed(1)}″ (the dashed circle), sky from a ring around it, no aperture correction. Neighbours inside the circle are included.`;
}
function specHover(ev) {
  const r = $("spec").getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
  let best = null, bd = 144;
  for (const d of S.specDrawn) { const k = (d.px - mx) ** 2 + (d.py - my) ** 2; if (k < bd) { bd = k; best = d.p; } }
  $("specHover").textContent = best
    ? `${best.wavelength.toFixed(3)} µm  ${best.flux.toPrecision(3)} ± ${best.error.toPrecision(2)} mJy  ${isoDay(best.mjd)}  D${best.det}` : "\u00a0";
}
function specCsv() {
  const rows = ["wavelength_um,bandwidth_um,flux_mJy,error_mJy,mjd,detector,epoch"];
  for (const p of S.spec.points) rows.push([p.wavelength, p.bandwidth, p.flux, p.error, p.mjd, p.det, S.meta.epochs[p.epoch].label].join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `spherex_spectrum_${S.spec.ra.toFixed(5)}_${S.spec.dec.toFixed(5)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

function renderLabels(st, cur) {
  const eps = S.meta?.epochs || [], e = eps[S.ep], el = $("epochLabel");
  if (!e) { el.textContent = ""; $("subLabel").textContent = ""; $("legend").textContent = ""; return; }
  const band = `D${S.det} · ${BANDS[S.det][0]}`;
  if (S.mode === "stack") {
    el.textContent = "All epochs"; el.style.color = "var(--text)";
    $("subLabel").textContent = `${band} · mean of ${eps.length} epochs`;
  } else if (S.mode === "diff") {
    el.textContent = `${e.label} − ${eps[S.ref].label}`; el.style.color = "var(--text)";
    $("subLabel").textContent = band;
  } else {
    el.textContent = e.label; el.style.color = epColor(S.ep);
    const used = st?.epochs[S.ep]?.used;
    $("subLabel").textContent = st ? `${band} · stack of ${used} frame${used === 1 ? "" : "s"}` : band;
  }
  $("legend").textContent = S.mode === "diff" && cur
    ? `blue: brighter in ${eps[S.ref].label} · red: brighter in ${e.label}` : "";
  if (S.meta && st && !cur && !$("status").textContent)
    $("legend").textContent = `No D${S.det} exposures in this epoch.`;
}
function renderMeta(st) {
  const e = S.meta?.epochs[S.ep], rows = [["Centre", `${S.ra.toFixed(5)}  ${S.dec >= 0 ? "+" : "−"}${Math.abs(S.dec).toFixed(5)}`]];
  if (e) {
    rows.push(["Epoch dates", `${isoDay(e.mjd_min)} → ${isoDay(e.mjd_max)}`]);
    rows.push(["Detector", `D${S.det}  ${BANDS[S.det][0]}`]);
    if (st) rows.push(["Frames stacked", `${st.epochs[S.ep].used}`]);
    rows.push(["Exposures here", `${S.meta.total_frames} in ${S.meta.epochs.length} epochs`]);
    if (st) rows.push(["Pixel", `${st.pixscale.toFixed(2)}″ (native 6.15″)`], ["Noise σ", `${st.sigma.toExponential(2)} MJy/sr`]);
  }
  $("meta").innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = k; dd.textContent = v; dd.className = "mono"; $("meta").append(dt, dd);
  }
  $("hiVal").textContent = `${S.hi}σ`;
}

// ---------- band rail ----------
function buildRail() {
  const rail = $("rail");
  rail.querySelectorAll(".band").forEach(b => b.remove());
  for (const d of [1, 2, 3, 4, 5, 6]) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "band"; b.dataset.det = d;
    b.innerHTML = `<canvas width="184" height="96"></canvas><span class="t"><span class="sw" style="background:${BANDS[d][1]}"></span>D${d}</span><span class="r">${BANDS[d][0]}</span>`;
    b.onclick = () => setDet(d);
    rail.append(b);
  }
}
function drawThumb(det) {
  const cv = document.querySelector(`.band[data-det="${det}"] canvas`);
  if (!cv) return;
  const ctx = cv.getContext("2d"), st = S.stacks[det], cur = currentImage(det);
  ctx.fillStyle = "#04060A"; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!st || !cur) return;
  paint(cur, st);
  const sh = st.n * cv.height / cv.width;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, (st.n - sh) / 2, st.n, sh, 0, 0, cv.width, cv.height);
}

// ---------- timeline ----------
function buildTrack() {
  const tr = $("track"), eps = S.meta.epochs;
  tr.innerHTML = "";
  const tmin = eps[0].mjd_min, tmax = eps[eps.length - 1].mjd_max, pad = Math.max(30, (tmax - tmin) * 0.06);
  const t0 = tmin - pad, t1 = tmax + pad;
  const pos = m => `calc(8px + (100% - 16px) * ${((m - t0) / (t1 - t0)).toFixed(5)})`;
  const add = (cls, left, text) => {
    const d = document.createElement("div"); d.className = cls; if (left) d.style.left = left; if (text) d.textContent = text; tr.append(d); return d;
  };
  add("axis");
  const start = mjdDate(t0);
  add("year-label", "8px", String(start.getUTCFullYear()));
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1; ; m++) {
    const mjd = Date.UTC(y, m, 1) / 86400000 + 40587;
    if (mjd > t1) break;
    const d = new Date(Date.UTC(y, m, 1)), jan = d.getUTCMonth() === 0;
    add(jan ? "tick year" : "tick", pos(mjd));
    if (jan) add("year-label", `calc(${pos(mjd).slice(5, -1)} + 5px)`, String(d.getUTCFullYear()));
  }
  eps.forEach((e, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ep" + (e.frames[S.det] ? "" : " empty");
    b.style.left = pos(e.mjd); b.style.setProperty("--c", epColor(i));
    b.innerHTML = `<span class="dot"></span><span class="l"></span><span class="n"></span>`;
    b.children[1].textContent = e.label;
    b.children[2].textContent = `${e.frames[S.det]} frame${e.frames[S.det] === 1 ? "" : "s"}`;
    b.onclick = () => { stop(); S.ep = i; if (S.mode === "stack") S.mode = "blink"; writeUrl(); render(); };
    tr.append(b);
  });
  // Where two epochs sit too close for both captions, keep the caption of the selected one only.
  let prevRight = -Infinity;
  for (const b of tr.querySelectorAll(".ep")) {
    const r = b.getBoundingClientRect();
    b.classList.toggle("tight", r.left < prevRight + 4);
    if (!b.classList.contains("tight")) prevRight = r.right;
  }
}
function buildRef() {
  $("ref").innerHTML = "";
  S.meta.epochs.forEach((e, i) => $("ref").add(new Option(e.label, i)));
  $("ref").value = S.ref;
}
function step(dir) {
  const E = S.stacks[S.det]?.epochs;
  if (!E) return;
  for (let k = 1; k <= E.length; k++) {
    const i = (S.ep + dir * k + E.length * k) % E.length;
    if (E[i].img && !(S.mode === "diff" && i === S.ref)) { S.ep = i; break; }
  }
  render();
}
function play() {
  if (S.mode === "stack") S.mode = "blink";
  S.timer = setInterval(() => step(1), 1000 / S.fps);
  render();
}
function stop() { clearInterval(S.timer); S.timer = null; }

// ---------- state / controls ----------
function setDet(d) {
  S.det = d; writeUrl();
  if (S.meta?.epochs.length) {
    buildTrack();
    setStatus(S.stacks[d] ? "" : `Reading D${d} exposures from the SPHEREx archive…`);
    ensureDet(d);
  }
  render();
}
function setMode(m) {
  S.mode = m;
  if (m === "diff" && S.ep === S.ref) step(1);
  if (m === "stack") stop();
  writeUrl(); render();
}
function goTo(ra, dec, det) {
  S.ra = Number(ra.toFixed(5)); S.dec = Number(dec.toFixed(5));
  if (det) S.det = det;
  load();
}
function writeUrl() {
  const p = new URLSearchParams(location.search);
  p.set("ra", S.ra); p.set("dec", S.dec); p.set("fov", S.fov); p.set("det", S.det); p.set("mode", S.mode);
  history.replaceState(null, "", "?" + p);
}
function readUrl() {
  const p = new URLSearchParams(location.search), num = k => (p.has(k) && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null);
  if (num("ra") !== null && num("dec") !== null) { S.ra = num("ra"); S.dec = num("dec"); }
  if ([120, 240, 360, 600].includes(num("fov"))) S.fov = num("fov");
  if (num("det") >= 1 && num("det") <= 6) S.det = Math.round(num("det"));
  if (["blink", "diff", "stack"].includes(p.get("mode"))) S.mode = p.get("mode");
  document.body.classList.toggle("embed", p.get("embed") === "1");
}
function syncControls() {
  $("coord").value = `${S.ra.toFixed(5)} ${S.dec >= 0 ? "+" : ""}${S.dec.toFixed(5)}`;
  $("fov").value = S.fov; $("fps").value = S.fps; $("hi").value = S.hi;
  document.querySelectorAll(".chip").forEach((c, i) => {
    const t = TARGETS[i];
    c.setAttribute("aria-pressed", String(Math.abs(t.ra - S.ra) < 1e-4 && Math.abs(t.dec - S.dec) < 1e-4));
  });
}

function init() {
  for (const t of TARGETS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = t.name;
    b.onclick = () => goTo(t.ra, t.dec, t.det);
    $("targets").append(b);
  }
  $("search").onsubmit = async ev => {
    ev.preventDefault();
    const text = $("coord").value;
    if (!text.trim()) return;
    try {
      const c = parseCoord(text) || await resolveName(text.trim());
      goTo(c.ra, c.dec);
    } catch (e) { setStatus(e.message, true); }
  };
  $("fov").onchange = e => { S.fov = Number(e.target.value); load(); };
  $("fps").onchange = e => { S.fps = Number(e.target.value); if (S.timer) { stop(); play(); } };
  $("hi").oninput = e => { S.hi = Number(e.target.value); render(); };
  $("ref").onchange = e => { S.ref = Number(e.target.value); if (S.mode === "diff" && S.ep === S.ref) step(1); else render(); };
  $("play").onclick = () => { if (S.timer) { stop(); render(); } else play(); };
  document.querySelectorAll("#modes button").forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $("copy").textContent = "Copied"; }
    catch { $("copy").textContent = "Copy failed"; }
    setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
  };

  const view = $("view");
  const pointer = ev => {
    const st = S.stacks[S.det], cur = currentImage();
    if (!st || !cur) return null;
    const r = view.getBoundingClientRect(), dpr = view.width / r.width, { side, x0, y0 } = geometry();
    const u = ((ev.clientX - r.left) * dpr - x0) / side, v = ((ev.clientY - r.top) * dpr - y0) / side;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const ix = u * st.n - 0.5, iy = (1 - v) * st.n - 0.5;
    const val = cur.img[Math.min(st.n - 1, Math.max(0, Math.round(iy))) * st.n + Math.min(st.n - 1, Math.max(0, Math.round(ix)))];
    return { ...pixToSky(ix, iy, st.n, st.pixscale), val, sigma: st.sigma };
  };
  view.onmousemove = ev => {
    const p = pointer(ev), dd = $("cursor").querySelectorAll("dd");
    dd[0].textContent = p ? `${p.ra.toFixed(5)}  ${p.dec >= 0 ? "+" : "−"}${Math.abs(p.dec).toFixed(5)}` : "–";
    dd[1].textContent = p && Number.isFinite(p.val) ? `${p.val.toExponential(2)} MJy/sr (${(p.val / p.sigma).toFixed(1)}σ)` : "–";
  };
  let clickTimer = null;   // wait briefly so that a double-click does not also measure a spectrum
  view.onclick = ev => {
    const p = pointer(ev);
    if (!p) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { S.pick = { ra: p.ra, dec: p.dec }; render(); loadSpectrum(false); }, 260);
  };
  view.ondblclick = ev => { clearTimeout(clickTimer); const p = pointer(ev); if (p) goTo(p.ra, p.dec); };
  $("spec").onmousemove = specHover;
  $("spec").onmouseleave = () => ($("specHover").textContent = "\u00a0");
  $("specCsv").onclick = specCsv;

  window.addEventListener("keydown", ev => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "ArrowRight") { stop(); step(1); }
    else if (ev.key === "ArrowLeft") { stop(); step(-1); }
    else if (ev.key === " ") { ev.preventDefault(); $("play").click(); }
    else if (/^[1-6]$/.test(ev.key)) setDet(Number(ev.key));
    else if (ev.key.toLowerCase() === "b") setMode("blink");
    else if (ev.key.toLowerCase() === "d") setMode("diff");
    else if (ev.key.toLowerCase() === "s") setMode("stack");
  });
  new ResizeObserver(() => render()).observe($("stage"));

  readUrl();
  load();
}
init();
