// SPHEREx Blink viewer: data, image, matrix, timeline, layers, spectrum. AI-assisted code (Claude Code).
// The discovery tools (motion, catalogue check, candidates, menus, phone sheet) are in discover.js.
"use strict";

const BANDS = { 1: "0.75–1.09 µm", 2: "1.10–1.62 µm", 3: "1.63–2.41 µm", 4: "2.42–3.82 µm", 5: "3.83–4.41 µm", 6: "4.42–5.00 µm" };
const BAND_UM = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
const DETS = [1, 2, 3, 4, 5, 6];
const BAND_COLORS = ["#8E7CF8", "#4FA3F7", "#2EC4B6", "#A3D55D", "#F4A640", "#EF5D60"];
const D2R = Math.PI / 180, NATIVE_PIX = 6.15;
const PREFETCH_MAX_FRAMES = 600;
const SESAME_MIRRORS = ["https://vizier.cfa.harvard.edu/viz-bin/nph-sesame", "https://cds.unistra.fr/cgi-bin/nph-sesame"];
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const S = { ra: 331.096, dec: -56.801, fov: 240, det: 5, mode: "blink", axis: "epochs", ep: 0, ref: 0, hi: 12, hiAuto: true,
  fps: 2, timer: null, meta: null, stacks: {}, pending: {}, token: 0, abort: null, state: null, t0: 0, clock: null,
  pick: null, pickNext: null, aper: 2, spec: null, specState: "", specDrawn: [],
  ov: { gaia: true, catwise: true, trail: true }, cats: {}, catState: {}, ovDrawn: [] };

// Small hub so that discover.js can draw on the image and follow the state without this file knowing about it.
const App = {
  S, hooks: { render: [], overlay: [], reset: [] },
  on(k, f) { this.hooks[k].push(f); },
  emit(k, ...a) { for (const f of this.hooks[k]) f(...a); },
};

// ---------- helpers ----------
// The cut-off slider is logarithmic: 0..100 maps to an upper limit of 4σ..10000σ.
const sliderToHi = v => Math.round(4 * 10 ** (v / 100 * 3.4));
const hiToSlider = h => Math.round(100 * Math.log10(h / 4) / 3.4);
const mjdDate = mjd => new Date((mjd - 40587) * 86400000);
const isoDay = mjd => mjdDate(mjd).toISOString().slice(0, 10);
const mjdYear = mjd => 2000 + (mjd - 51544.5) / 365.25;
const shortLabel = e => e.label.replace(/ \d\d(\d\d)$/, " ’$1");
const dayMonth = mjd => mjdDate(mjd).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtDec = (d, p = 5) => `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(p)}`;
const fmtPos = (ra, dec, p = 5) => `${ra.toFixed(p)} ${fmtDec(dec, p)}`;
const phone = () => window.matchMedia("(max-width: 820px)").matches;
// Epoch colours: a grey ramp for the older visits, green for the latest one.
const epochVar = (i, n) => (i === n - 1 ? "var(--epoch-current)" : `var(--epoch-${Math.min(3, Math.max(1, 3 - (n - 2 - i)))})`);
const skyVar = name => getComputedStyle($("image")).getPropertyValue(name).trim();
const epochColor = (i, n) => skyVar(i === n - 1 ? "--epoch-current" : `--epoch-${Math.min(3, Math.max(1, 3 - (n - 2 - i)))}`);
const api = path => Sky.api(path, { signal: S.abort?.signal });

function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2200);
}
function autoStretch(det) {
  const st = S.stacks[det];
  if (!S.hiAuto || !st?.mean) return;
  S.hi = Sky.autoHi(st.mean, st.n, st.sigma);
}

// ---------- coordinates ----------
function parseCoord(text) {
  const t = text.trim().replace(/[−–]/g, "-");
  const nums = t.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!nums) return null;
  let ra, dec;
  if (nums.length === 2 && !/[a-z:]/i.test(t)) {
    [ra, dec] = nums.map(Number);
  } else if (nums.length === 6 && /^[\d\s.:hmsd°'"′″+-]+$/i.test(t)) {
    const [h, m, s, d, dm, ds] = nums.map(x => Math.abs(Number(x)));
    ra = (h + m / 60 + s / 3600) * 15;
    dec = (nums[3].startsWith("-") ? -1 : 1) * (d + dm / 60 + ds / 3600);
  } else return null;
  return ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? { ra, dec } : null;
}
async function resolveName(name) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known = TARGETS.find(t => [t.name, t.short, t.long].some(x => x && norm(x) === norm(name)));
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
  if (!m) throw new Error(`Could not find “${name}”. Enter coordinates instead.`);
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
// A patch near one of the ecliptic poles, where SPHEREx returns most often. No coverage is known in advance.
function randomPatch() {
  const south = Math.random() < 0.5, r = 2.5 * Math.sqrt(Math.random()), th = 2 * Math.PI * Math.random();
  const dec = (south ? -66.56 : 66.56) + r * Math.sin(th);
  const ra = ((south ? 90 : 270) + r * Math.cos(th) / Math.cos(dec * D2R) + 360) % 360;
  return { ra, dec };
}

// ---------- states over the image: loading, no coverage, archive error ----------
const targetButtons = () => `<div class="seg" role="group" aria-label="Test targets">${TARGETS.map((t, i) => `<button type="button" data-target="${i}">${esc(t.name)}</button>`).join("")}</div>`;
function setState(kind, detail = "") {
  const el = $("state");
  clearInterval(S.clock); S.clock = null;
  S.state = kind;
  el.hidden = !kind;
  if (!kind) { el.innerHTML = ""; return; }
  const where = fmtPos(S.ra, S.dec, 4);
  if (kind === "loading") {
    const steps = ["Find the exposures of this position", `Read and stack the D${S.det} exposures`, "Draw the visits"];
    el.innerHTML = `<h2 class="t-title">Loading ${where}</h2>
      <div class="loader"><ol>${steps.map((s, i) => `<li class="${i < detail ? "done" : i === detail ? "now" : ""}"><i>${i < detail ? ico("check", 10) : ""}</i>${s}</li>`).join("")}</ol>
      <p class="t-caption c-3" style="margin:0"><span id="elapsed">0 s</span> so far. A new position takes about 30 s the first time; after that it is instant.</p></div>
      <p class="t-caption c-3" style="margin:0">Or open a test target</p>${targetButtons()}
      <button type="button" class="pill" data-act="cancel">Cancel</button>`;
    const tick = () => { const e = $("elapsed"); if (e) e.textContent = `${Math.round((performance.now() - S.t0) / 1000)} s`; };
    tick(); S.clock = setInterval(tick, 1000);
  } else if (kind === "empty") {
    el.innerHTML = `<div class="msg"><span class="icon">${ico("image", 20)}</span><h2 class="t-title">SPHEREx has not observed this position yet</h2>
      <p class="t-body c-2" style="margin:0">The public archive holds no exposure that covers ${where}. The survey keeps filling the sky; the same link will work once this patch is released.</p>
      <div class="btns"><button type="button" class="pill primary" data-act="pick">Pick a patch for me</button></div>
      <p class="t-caption c-3" style="margin:0">Or open a test target</p>${targetButtons()}</div>`;
  } else if (kind === "error") {
    el.innerHTML = `<div class="msg"><span class="icon warn">${ico("alert", 20)}</span><h2 class="t-title">The archive did not answer</h2>
      <p class="t-body c-2" style="margin:0">The images come from the NASA/IPAC archive (IRSA) at the moment you ask. It could not be reached, or it returned an error. The test targets are stored with the tool and still open.</p>
      <span class="detail t-mono">${esc(detail || "No detail given")}</span>
      <div class="btns"><button type="button" class="pill primary" data-act="retry">${ico("refresh", 14)}Try again</button></div>${targetButtons()}</div>`;
  } else {
    el.innerHTML = `<div class="msg"><h2 class="t-title">Nothing loaded</h2>
      <p class="t-body c-2" style="margin:0">Enter a position or a name above, or open a test target.</p>
      <div class="btns"><button type="button" class="pill primary" data-act="pick">Pick a patch for me</button></div>${targetButtons()}</div>`;
  }
}

// ---------- data ----------
async function load() {
  const token = ++S.token;
  stop();
  S.abort?.abort(); S.abort = new AbortController();
  S.meta = null; S.stacks = {}; S.pending = {}; S.cats = {}; S.catState = {};
  S.pick = S.pickNext || { ra: S.ra, dec: S.dec }; S.pickNext = null;
  S.spec = null; S.specState = ""; S.hiAuto = true; S.hi = 12; S.t0 = performance.now();
  writeUrl(); buildMatrix(); buildTrack(); App.emit("reset");
  setState("loading", 0); render();
  try {
    const meta = await api(`/api/epochs?ra=${S.ra}&dec=${S.dec}`);
    if (token !== S.token) return;
    S.meta = meta;
    if (!meta.epochs.length) { setState("empty"); render(); return; }
    S.ep = meta.epochs.length - 1; S.ref = 0;
    buildMatrix(); buildTrack(); buildRef();
    setState("loading", 1);
    loadSpectrum(true);
    loadCat("gaia"); loadCat("catwise");     // also needed for the catalogue check, whether or not they are drawn
    await ensureDet(S.det, token);
    // Each exposure costs ~0.5 MB of archive reads. Fill the other rows of the matrix
    // only where that is cheap; elsewhere a band loads when it is selected.
    if (meta.total_frames <= PREFETCH_MAX_FRAMES)
      for (const d of DETS) if (token === S.token) await ensureDet(d, token);
  } catch (e) {
    if (token === S.token && e.name !== "AbortError") { setState("error", e.message); render(); }
  }
}
function ensureDet(det, token = S.token) {
  if (S.stacks[det]) return Promise.resolve();
  S.pending[det] ??= loadDet(det, token)
    .catch(e => { if (token === S.token && det === S.det && e.name !== "AbortError") { setState("error", e.message); render(); } })
    .finally(() => { if (token === S.token) delete S.pending[det]; });
  return S.pending[det];
}
async function loadDet(det, token) {
  const r = await api(`/api/stack?ra=${S.ra}&dec=${S.dec}&fov=${S.fov}&det=${det}`);
  if (token !== S.token) return;
  const epochs = r.epochs.map(e => ({ used: e.used, img: e.data ? Sky.decode(e.data) : null }));
  const mean = Sky.mean(epochs.map(e => e.img));
  S.stacks[det] = { n: r.n, pixscale: r.pixscale, epochs, mean, sigma: mean ? Sky.sigma(mean) : 1 };
  if (det === S.det) {
    autoStretch(det);
    if (S.state === "loading") setState(null);
    if (!epochs[S.ep]?.img) S.ep = Math.max(0, epochs.findLastIndex(e => e.img));
    if (!epochs[S.ref]?.img) S.ref = Math.max(0, epochs.findIndex(e => e.img));
    $("ref").value = S.ref;
  }
  render();
}

// ---------- image ----------
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
      st.diff = { key, img: d, div: true, sigma: Sky.sigma(d) };   // noise of the difference itself
    }
    return st.diff;
  }
  return E[S.ep]?.img ? { img: E[S.ep].img, div: false } : null;
}
function geometry() {
  const c = $("view"), side = Math.min(c.width, c.height);
  return { side, x0: (c.width - side) / 2, y0: (c.height - side) / 2 };
}
// Sky position to canvas pixels of the main image (for anything that draws on it).
function toScreen(ra, dec) {
  const st = S.stacks[S.det], { side, x0, y0 } = geometry();
  const p = skyToPix(ra, dec, st.n, st.pixscale);
  return [x0 + (p.ix + 0.5) / st.n * side, y0 + (1 - (p.iy + 0.5) / st.n) * side];
}
function render() {
  const c = $("view"), dpr = window.devicePixelRatio || 1, box = $("image").getBoundingClientRect();
  const st = S.stacks[S.det], cur = currentImage();
  if (box.width) {
    c.width = Math.max(1, Math.round(box.width * dpr)); c.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, c.width, c.height);
    if (cur) {
      const { side, x0, y0 } = geometry();
      Sky.paint(off, cur, st.n, st.sigma, S.hi);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, x0, y0, side, side);
      drawOverlay(ctx, x0, y0, side, dpr);
    }
  }
  renderLabels(st, cur);
  renderFacts(st);
  renderGutters();
  renderSpectrum();
  syncControls();
  paintThumbsSoon();
  App.emit("render");
}
function drawOverlay(ctx, x0, y0, side, dpr) {
  const st = S.stacks[S.det];
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, side, side); ctx.clip();
  drawCatalogs(ctx, dpr);
  App.emit("overlay", ctx, dpr);
  if (S.pick) {   // the marked spot: the dashed circle is the photometry aperture
    const [mx, my] = toScreen(S.pick.ra, S.pick.dec);
    const rad = (S.spec?.aperture_arcsec || S.aper * NATIVE_PIX) / S.fov * side;
    ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = "rgba(250,250,250,.9)";
    ctx.beginPath(); ctx.arc(mx, my, rad, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
  // scale bar and compass, bottom right
  const arc = S.fov <= 150 ? 15 : S.fov <= 400 ? 30 : 60, len = side / S.fov * arc;
  const bx = x0 + side - 84 * dpr, by = y0 + side - 34 * dpr;
  ctx.fillStyle = "#fafafa"; ctx.fillRect(bx - len, by, len, 2 * dpr);
  ctx.font = `${12 * dpr}px "JetBrains Mono", ui-monospace, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillText(`${arc}″`, bx - len / 2, by + 17 * dpr);
  const ox = x0 + side - 30 * dpr, oy = y0 + side - 22 * dpr, a = 28 * dpr;
  ctx.strokeStyle = "#fafafa"; ctx.lineWidth = 1.4 * dpr; ctx.beginPath();
  ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - a); ctx.moveTo(ox, oy); ctx.lineTo(ox - a, oy); ctx.stroke();
  ctx.font = `${11 * dpr}px Inter, system-ui, sans-serif`;
  ctx.fillText("N", ox, oy - a - 4 * dpr); ctx.fillText("E", ox - a - 8 * dpr, oy + 4 * dpr);
}
function renderLabels(st, cur) {
  const eps = S.meta?.epochs || [], e = eps[S.ep];
  if (!e) { $("epochLabel").textContent = ""; $("subLabel").textContent = ""; $("legend").textContent = ""; return; }
  const band = `D${S.det} · ${BANDS[S.det]}`;
  $("epochLabel").style.color = S.mode === "blink" ? epochVar(S.ep, eps.length) : "";
  if (S.mode === "stack") {
    $("epochLabel").textContent = "All visits";
    $("subLabel").textContent = `${band} · mean of ${eps.length} visits`;
  } else if (S.mode === "diff") {
    $("epochLabel").textContent = `${e.label} − ${eps[S.ref].label}`;
    $("subLabel").textContent = band;
  } else {
    const used = st?.epochs[S.ep]?.used;
    $("epochLabel").textContent = e.label;
    $("subLabel").textContent = st ? `${band} · stack of ${used} frame${used === 1 ? "" : "s"}` : band;
  }
  $("legend").textContent = S.mode === "diff" && cur ? `blue: brighter in ${eps[S.ref].label} · red: brighter in ${e.label}`
    : st && !cur && !S.state ? `No D${S.det} exposures in this visit.` : "";
}
function renderFacts(st) {
  const eps = S.meta?.epochs || [], e = eps[S.ep], rows = [];
  if (e) {
    const all = S.mode === "stack", yr = m => mjdDate(m).getUTCFullYear(), a = all ? eps[0].mjd_min : e.mjd_min, b = all ? eps[eps.length - 1].mjd_max : e.mjd_max;
    rows.push(["Band", `D${S.det} · ${BANDS[S.det]}`], ["Visit", `${dayMonth(a)}${yr(a) === yr(b) ? "" : ` ${yr(a)}`} – ${dayMonth(b)} ${yr(b)}`]);
    if (st) rows.push(["Exposures", `${all ? st.epochs.reduce((s, x) => s + x.used, 0) : st.epochs[S.ep].used} averaged`], ["Noise (1σ)", `${st.sigma.toExponential(2)} MJy/sr`], ["Pixel", `${st.pixscale.toFixed(2)}″ (native 6.15″)`]);
    rows.push(["Archive", `through ${dayMonth(eps[eps.length - 1].mjd_max)} ${yr(eps[eps.length - 1].mjd_max)}`]);
  } else rows.push(["Centre", fmtPos(S.ra, S.dec)]);
  $("facts").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
}
function renderGutters() {      // sky coordinates along the top and left edges of the image
  const key = `${S.ra}:${S.dec}:${S.fov}`;
  if (renderGutters.key === key) return;
  renderGutters.key = key;
  let top = "", left = "";
  for (const f of [1 / 6, 1 / 2, 5 / 6]) {
    const east = (0.5 - f) * S.fov / 3600, north = (0.5 - f) * S.fov / 3600;
    const ra = ((S.ra + east / Math.cos(S.dec * D2R)) % 360 + 360) % 360, dec = S.dec + north;
    top += `<i style="left:${f * 100}%"></i><span style="left:${f * 100}%">${ra.toFixed(3)}°</span>`;
    left += `<i style="top:${f * 100}%"></i><span style="top:${f * 100}%">${fmtDec(dec, 3)}°</span>`;
  }
  $("gutTop").innerHTML = top; $("gutLeft").innerHTML = left;
}

// ---------- catalogue overlays ----------
const CATS = { gaia: { color: "--catalog-gaia", unit: "G", label: "Gaia DR3" }, catwise: { color: "--catalog-catwise", unit: "W2", label: "CatWISE2020" } };
const FAST_MAS = 150, MAX_MARKS = 80, MAX_FAST = 5;      // label sources faster than this; draw at most this many others
// A motion counts only if the catalogue measured it well: faint CatWISE sources have large, noisy values.
const pmTotal = s => (s.pm_snr != null && s.pm_snr >= 3 ? Math.hypot(s.pmra, s.pmdec) : 0);
const isFast = s => s.pm_snr != null && s.pm_snr >= 5 && Math.hypot(s.pmra, s.pmdec) >= FAST_MAS;

async function loadCat(name) {
  const token = S.token;
  S.catState[name] = "loading";
  try {
    const r = await api(`/api/catalog?name=${name}&ra=${S.ra}&dec=${S.dec}&fov=${S.fov}`);
    if (token !== S.token) return;
    // Label the best-measured fast movers only: around a bright star CatWISE lists many spurious ones.
    const fast = new Set(r.sources.filter(isFast).sort((a, b) => b.pm_snr - a.pm_snr).slice(0, MAX_FAST));
    const rest = r.sources.filter(s => !fast.has(s)).slice(0, MAX_MARKS);   // brightest first
    S.cats[name] = { ...r, fast, shown: [...fast, ...rest] };
    S.catState[name] = "ok";
  } catch (e) {
    if (token !== S.token || e.name === "AbortError") return;
    S.catState[name] = "error";
    if (S.ov[name]) toast(`${CATS[name].label} did not answer.`);
  }
  render();
}
function sourceAt(s, year) {             // catalogue position moved to the given date
  const dt = pmTotal(s) ? year - s.epoch : 0;
  return { ra: s.ra + s.pmra * dt / 3.6e6 / Math.cos(s.dec * D2R), dec: s.dec + s.pmdec * dt / 3.6e6 };
}
function shownYear() {
  const years = S.meta.epochs.map(e => mjdYear(e.mjd));
  return S.mode === "stack" ? years.reduce((a, b) => a + b, 0) / years.length : years[S.ep];
}
function drawCatalogs(ctx, dpr) {
  const eps = S.meta?.epochs;
  S.ovDrawn = [];
  if (!eps?.length) return;
  const years = eps.map(e => mjdYear(e.mjd)), now = shownYear();
  ctx.font = `${11 * dpr}px "JetBrains Mono", ui-monospace, monospace`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (const name of Object.keys(CATS)) {
    const cat = S.cats[name];
    if (!S.ov[name] || !cat) continue;
    ctx.strokeStyle = ctx.fillStyle = skyVar(CATS[name].color); ctx.lineWidth = 1.3 * dpr;
    for (const s of cat.shown) {
      const c = sourceAt(s, now), [mx, my] = toScreen(c.ra, c.dec), pm = Math.hypot(s.pmra, s.pmdec), r = 5 * dpr;
      if (cat.fast.has(s)) {        // catalogue path from the first to the last SPHEREx visit
        const a = sourceAt(s, years[0]), b = sourceAt(s, years[years.length - 1]);
        const [ax, ay] = toScreen(a.ra, a.dec), [bx, by] = toScreen(b.ra, b.dec);
        ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillText(`${(pm / 1000).toFixed(2)}″/yr`, mx + r + 4 * dpr, my - r - 2 * dpr);
      }
      ctx.beginPath();
      if (name === "gaia") ctx.arc(mx, my, r, 0, 2 * Math.PI);
      else { ctx.moveTo(mx, my - r * 1.2); ctx.lineTo(mx + r * 1.2, my); ctx.lineTo(mx, my + r * 1.2); ctx.lineTo(mx - r * 1.2, my); ctx.closePath(); }
      ctx.stroke();
      S.ovDrawn.push({ x: mx / dpr, y: my / dpr, s, label: CATS[name].label, unit: CATS[name].unit });
    }
  }
}
function nearestSource(ev) {
  const r = $("view").getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
  let best = null, bd = 100;
  for (const d of S.ovDrawn) { const k = (d.x - mx) ** 2 + (d.y - my) ** 2; if (k < bd) { bd = k; best = d; } }
  if (!best) return "";
  const s = best.s, pm = Math.hypot(s.pmra, s.pmdec);
  return `${best.label} · ${best.unit} ${s.mag == null ? "?" : s.mag.toFixed(1)} · ${s.pm_snr == null ? "no motion given" : `${pm.toFixed(0)} mas/yr`}`;
}

// ---------- spectrum ----------
async function loadSpectrum(cachedOnly) {
  const token = S.token, pick = S.pick, aper = S.aper;
  S.spec = null; S.specState = cachedOnly ? "" : "loading"; renderSpectrum();
  try {
    const r = await api(`/api/spectrum?ra=${S.ra}&dec=${S.dec}&fov=${S.fov}&pra=${pick.ra.toFixed(5)}&pdec=${pick.dec.toFixed(5)}&aper=${aper}${cachedOnly ? "&cached_only=1" : ""}`);
    if (token !== S.token || pick !== S.pick || aper !== S.aper) return;
    S.spec = r.points ? r : null; S.specState = r.points ? "" : "hint";
  } catch (e) {
    if (token !== S.token || pick !== S.pick || aper !== S.aper || e.name === "AbortError") return;
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
function specSummary() {
  const pts = S.spec?.points;
  if (!pts?.length) return "";
  const eps = S.meta?.epochs || [], skipped = S.spec.exposures - pts.length;
  const which = S.mode === "stack" ? "all visits" : S.mode === "diff" ? `${eps[S.ep]?.label} and ${eps[S.ref]?.label}` : eps[S.ep]?.label;
  return `${pts.length} exposures${skipped ? ` (${skipped} skipped)` : ""} · bright: ${which}`;
}
function renderSpectrum() {
  const cv = $("spec"), info = $("specInfo"), pts = S.spec?.points, box = cv.getBoundingClientRect();
  $("specCsv").hidden = !pts?.length;
  S.specDrawn = [];
  info.textContent = pts?.length ? ""
    : S.specState === "loading" ? "Measuring every exposure at the marker… This can take a minute the first time."
    : S.specState.startsWith("error:") ? S.specState.slice(6)
    : pts ? "No exposure could be measured at this spot (image edge or saturated pixels)."
    : S.specState === "hint" ? "Click a source in the image to measure its spectrum. Every exposure there is read, which can take a minute the first time."
    : "";
  if (!pts?.length) $("specHover").textContent = "";
  cv.title = specSummary();
  if (!box.width) return;                       // panel not on screen
  const dpr = window.devicePixelRatio || 1, W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  if (!pts?.length) return;

  const m = { l: 46 * dpr, r: 10 * dpr, t: 22 * dpr, b: 26 * dpr }, X0 = 0.7, X1 = 5.1;
  const fl = pts.map(p => p.flux).sort((a, b) => a - b), q = f => fl[Math.min(fl.length - 1, Math.floor(f * fl.length))];
  let lo = Math.min(0, q(0.02)), hi = Math.max(q(0.98), lo + 1e-6);
  const pad = (hi - lo) * 0.08; hi += pad; if (lo < 0) lo -= pad;
  const x = lam => m.l + (lam - X0) / (X1 - X0) * (W - m.l - m.r);
  const y = f => H - m.b - (Math.min(hi, Math.max(lo, f)) - lo) / (hi - lo) * (H - m.t - m.b);
  const muted = skyVar("--text-muted"), n = S.meta?.epochs.length || 1;

  ctx.font = `${11 * dpr}px "JetBrains Mono", ui-monospace, monospace`; ctx.textBaseline = "middle";
  for (const d of DETS) {                       // detector bands
    const [a, b] = BAND_UM[d];
    if (d % 2) { ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(x(a), m.t, x(b) - x(a), H - m.t - m.b); }
    ctx.fillStyle = BAND_COLORS[d - 1]; ctx.globalAlpha = d === S.det ? 1 : 0.7; ctx.textAlign = "center"; ctx.fillText(`D${d}`, (x(a) + x(b)) / 2, 10 * dpr);
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.fillStyle = muted; ctx.lineWidth = dpr;
  for (const v of niceTicks(lo, hi, 4)) {
    ctx.beginPath(); ctx.moveTo(m.l, y(v)); ctx.lineTo(W - m.r, y(v)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(String(Number(v.toPrecision(3))), m.l - 6 * dpr, y(v));
  }
  for (const v of [1, 2, 3, 4, 5]) { ctx.textAlign = "center"; ctx.fillText(String(v), x(v), H - m.b + 12 * dpr); }
  ctx.textAlign = "right"; ctx.fillText("µm", W - m.r, H - m.b + 12 * dpr);
  ctx.textAlign = "left"; ctx.fillText("mJy", 6 * dpr, 10 * dpr);

  const lit = p => S.mode === "stack" || p.epoch === S.ep || (S.mode === "diff" && p.epoch === S.ref);
  const colors = Array.from({ length: n }, (_, i) => epochColor(i, n));
  for (const pass of [false, true]) {           // dimmed visits first, the shown visit on top
    for (const p of pts) {
      if (lit(p) !== pass) continue;
      const px = x(p.wavelength), py = y(p.flux);
      ctx.globalAlpha = pass ? 1 : 0.25; ctx.fillStyle = ctx.strokeStyle = colors[p.epoch] || muted;
      if (pass && p.error > (hi - lo) * 0.03) { ctx.beginPath(); ctx.moveTo(px, y(p.flux - p.error)); ctx.lineTo(px, y(p.flux + p.error)); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(px, py, (pass ? 2.2 : 1.8) * dpr, 0, 2 * Math.PI); ctx.fill();
      if (pass) S.specDrawn.push({ px: px / dpr, py: py / dpr, p });
    }
  }
  ctx.globalAlpha = 1;
}
function specHover(ev) {
  const r = $("spec").getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, el = $("specHover");
  let best = null, bd = 144;
  for (const d of S.specDrawn) { const k = (d.px - mx) ** 2 + (d.py - my) ** 2; if (k < bd) { bd = k; best = d.p; } }
  if (best) el.textContent = `${best.wavelength.toFixed(3)} µm · ${best.flux.toPrecision(3)} ± ${best.error.toPrecision(2)} mJy · ${isoDay(best.mjd)} · D${best.det}`;
  else el.textContent = "";
}
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function specCsv() {
  const rows = ["wavelength_um,bandwidth_um,flux_mJy,error_mJy,mjd,detector,visit"];
  for (const p of S.spec.points) rows.push([p.wavelength, p.bandwidth, p.flux, p.error, p.mjd, p.det, S.meta.epochs[p.epoch].label].join(","));
  download(`spherex_spectrum_${S.spec.ra.toFixed(5)}_${S.spec.dec.toFixed(5)}.csv`, new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
}

// ---------- matrix (bands × visits) and the phone strips ----------
function thumb(det, ep) { return `<canvas data-tdet="${det}" data-tep="${ep}"></canvas>`; }
function buildMatrix() {
  const eps = S.meta?.epochs || [], m = $("matrix"), n = eps.length;
  m.style.setProperty("--n", Math.max(n, 1));
  m.classList.toggle("wide", n > 4);        // more visits than fit: the table scrolls sideways, band names stay in place
  const months = eps.map(e => e.label.split(" ")[0]), head = (e, i) => (months.indexOf(months[i]) === months.lastIndexOf(months[i]) ? months[i] : shortLabel(e).replace("’", ""));
  let html = `<div class="mrow head"><span class="t-mono c-3">µm</span>${eps.map((e, i) => `<span class="t-caption c-3" data-ep="${i}">${esc(head(e, i))}</span>`).join("")}</div>`;
  for (const d of DETS) {
    html += `<div class="mrow" data-det="${d}" role="row"><button type="button" class="band" data-det="${d}" title="${BANDS[d]}"><b>D${d}</b><span class="t-mono c-3">${BAND_UM[d][0].toFixed(1)}–${BAND_UM[d][1].toFixed(1)}</span></button>`;
    html += eps.map((e, i) => (e.frames[d]
      ? `<button type="button" class="cell has" data-det="${d}" data-ep="${i}" aria-label="D${d}, ${esc(e.label)}, ${e.frames[d]} exposures">${thumb(d, i)}<span class="cnt">${e.frames[d]}</span></button>`
      : `<span class="cell none" aria-label="D${d}, ${esc(e.label)}, no exposures">–</span>`)).join("");
    html += "</div>";
  }
  m.innerHTML = n ? html : `<p class="t-caption c-3" style="margin:0">The table fills in once the exposures of this position are known.</p>`;
  $("timeStrip").innerHTML = `<span class="t-micro c-3">Time</span>` + eps.map((e, i) => (e.frames[S.det]
    ? `<button type="button" class="tile" data-ep="${i}" style="--c:${epochVar(i, n)}"><span class="th">${thumb("cur", i)}</span><i></i>${esc(head(e, i))}</button>`
    : `<span class="tile none">–</span>`)).join("");
  $("bandStrip").innerHTML = `<span class="t-micro c-3">Band</span>` + DETS.map(d => `<button type="button" class="tile" data-det="${d}"><span class="th">${thumb(d, "cur")}</span>D${d}</button>`).join("");
}
// Thumbnails are repainted only when their image or the cut-off changes.
function paintThumbs() {
  for (const cv of document.querySelectorAll("canvas[data-tdet]")) {
    if (!cv.offsetParent) continue;
    const det = cv.dataset.tdet === "cur" ? S.det : Number(cv.dataset.tdet), ep = cv.dataset.tep === "cur" ? S.ep : Number(cv.dataset.tep);
    const st = S.stacks[det], img = st?.epochs[ep]?.img, key = img ? `${S.token}:${det}:${ep}:${S.hi}` : "";
    if (cv.dataset.k === key) continue;
    cv.dataset.k = key;
    if (img) Sky.paint(cv, { img, div: false }, st.n, st.sigma, S.hi);
    else { cv.width = cv.height = 1; }
  }
}
function paintThumbsSoon() { clearTimeout(paintThumbsSoon.t); paintThumbsSoon.t = setTimeout(paintThumbs, 60); }

// ---------- timeline ----------
function buildTrack() {
  const tr = $("track"), eps = S.meta?.epochs || [], n = eps.length;
  tr.innerHTML = "";
  if (!n) return;
  const tmin = eps[0].mjd_min, tmax = eps[n - 1].mjd_max, pad = Math.max(30, (tmax - tmin) * 0.1);
  const t0 = tmin - pad, t1 = tmax + pad;
  eps.forEach((e, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "stop" + (e.frames[S.det] ? "" : " empty"); b.dataset.ep = i;
    b.style.left = `${((e.mjd - t0) / (t1 - t0) * 100).toFixed(3)}%`; b.style.setProperty("--c", epochVar(i, n));
    b.title = `${e.label}: ${isoDay(e.mjd_min)} → ${isoDay(e.mjd_max)}, ${e.frames[S.det]} D${S.det} exposure${e.frames[S.det] === 1 ? "" : "s"}`;
    b.innerHTML = `<i></i><span>${esc(shortLabel(e))}</span>`;
    tr.append(b);
  });
  // Where two visits sit too close for both captions, keep the caption of the selected one only.
  let prevRight = -Infinity;
  for (const b of tr.children) {
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
function step(dir, auto = false) {
  if (S.axis === "bands") {             // through the bands of the shown visit
    const frames = S.meta?.epochs[S.ep]?.frames;
    if (!frames) return;
    for (let k = 1; k <= 6; k++) {
      const d = ((S.det - 1 + dir * k) % 6 + 6) % 6 + 1;
      if (auto ? S.stacks[d]?.epochs[S.ep]?.img : frames[d]) { setDet(d); return; }
    }
    return;
  }
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
  if (S.axis === "bands") for (const d of DETS) ensureDet(d);
  S.timer = setInterval(() => step(1, true), 1000 / S.fps);
  render();
}
function stop() { clearInterval(S.timer); S.timer = null; }

// ---------- state / controls ----------
function setDet(d) {
  S.det = d; writeUrl();
  if (S.meta?.epochs.length) {
    buildTrack(); buildMatrix();
    autoStretch(d);
    if (S.stacks[d]) { if (S.state === "loading") setState(null); }
    else { S.t0 = performance.now(); setState("loading", 1); ensureDet(d); }
  }
  render();
}
function setEpoch(i) {
  stop(); S.ep = i;
  if (S.mode === "stack") S.mode = "blink";
  if (S.mode === "diff" && S.ep === S.ref) S.ref = S.stacks[S.det]?.epochs.findIndex((e, k) => e.img && k !== i) ?? 0;
  if (S.ref < 0) S.ref = 0;
  $("ref").value = S.ref;
  writeUrl(); render();
}
function setMode(m) {
  S.mode = m;
  if (m === "diff" && S.ep === S.ref) step(1);
  if (m === "stack") stop();
  writeUrl(); render();
}
function setPick(ra, dec, measure = true) {
  S.pick = { ra, dec };
  writeUrl(); render();
  loadSpectrum(!measure);
}
function goTo(ra, dec, det, pick) {
  S.ra = Number(ra.toFixed(5)); S.dec = Number(dec.toFixed(5));
  if (det) S.det = det;
  S.pickNext = pick || null;
  load();
}
function pageUrl(extra = {}) {
  const p = new URLSearchParams({ ra: S.ra, dec: S.dec, fov: S.fov, det: S.det, mode: S.mode });
  const on = ["gaia", "catwise"].filter(k => S.ov[k]);
  if (on.length < 2) p.set("ov", on.join(",") || "none");     // both catalogues are drawn unless the link says otherwise
  if (S.pick && (Math.abs(S.pick.ra - S.ra) > 1e-6 || Math.abs(S.pick.dec - S.dec) > 1e-6)) { p.set("pra", S.pick.ra.toFixed(5)); p.set("pdec", S.pick.dec.toFixed(5)); }
  if (S.aper !== 2) p.set("ap", S.aper);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `${location.origin}/explore?${p}`;
}
function writeUrl() {
  history.replaceState(null, "", pageUrl(document.body.classList.contains("embed") ? { embed: 1 } : {}));
}
function readUrl() {
  const p = new URLSearchParams(location.search), num = k => (p.has(k) && p.get(k) !== "" && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null);
  const hasPos = num("ra") !== null && num("dec") !== null && num("ra") >= 0 && num("ra") < 360 && Math.abs(num("dec")) <= 90;
  if (hasPos) { S.ra = num("ra"); S.dec = num("dec"); }
  if ([120, 240, 600].includes(num("fov"))) S.fov = num("fov");
  if (num("det") >= 1 && num("det") <= 6) S.det = Math.round(num("det"));
  if (["blink", "diff", "stack"].includes(p.get("mode"))) S.mode = p.get("mode");
  if ([1, 1.5, 2, 2.5, 3].includes(num("ap"))) S.aper = num("ap");
  if (p.has("ov")) for (const k of ["gaia", "catwise"]) S.ov[k] = p.get("ov").split(",").includes(k);
  if (hasPos && num("pra") !== null && num("pdec") !== null) S.pickNext = { ra: num("pra"), dec: num("pdec") };
  document.body.classList.toggle("embed", p.get("embed") === "1");
  return { hasPos, q: (p.get("q") || "").trim(), pick: p.get("pick") === "1", focus: p.get("focus") === "1" };
}
function press(sel, test) { document.querySelectorAll(sel).forEach(b => b.setAttribute("aria-pressed", String(!!test(b)))); }
function syncControls() {
  if (document.activeElement !== $("coord")) $("coord").value = fmtPos(S.ra, S.dec).replace("−", "-");
  const t = TARGETS.find(t => Math.abs(t.ra - S.ra) < 1e-4 && Math.abs(t.dec - S.dec) < 1e-4);
  $("startLabel").textContent = t ? t.name : "Test targets";
  press("#fov button[data-fov]", b => Number(b.dataset.fov) === S.fov);
  press("[data-mode]", b => b.dataset.mode === S.mode);
  press("#axis button", b => b.dataset.axis === S.axis);
  press("#aper button", b => Number(b.dataset.aper) === S.aper);
  press(".layer[data-layer]", b => S.ov[b.dataset.layer]);
  press(".stop", b => Number(b.dataset.ep) === S.ep && S.mode !== "stack");
  $("refRow").hidden = S.mode !== "diff";
  $("fps").value = S.fps;
  $("hi").value = hiToSlider(S.hi); $("hi").style.setProperty("--fill", `${$("hi").value}%`);
  $("hiVal").textContent = `${S.hi}σ`;
  $("play").innerHTML = ico(S.timer ? "pause" : "play", 14);
  $("play").setAttribute("aria-label", S.timer ? "Pause" : "Play");
  document.querySelectorAll(".mrow.head span[data-ep]").forEach(h => h.classList.toggle("c-3", !(Number(h.dataset.ep) === S.ep && S.mode !== "stack")));
  document.querySelectorAll(".mrow[data-det]").forEach(r => r.classList.toggle("on", Number(r.dataset.det) === S.det));
  document.querySelectorAll(".cell.has").forEach(c => c.classList.toggle("on", Number(c.dataset.det) === S.det && Number(c.dataset.ep) === S.ep && S.mode !== "stack"));
  const mx = $("matrix"), head = mx.querySelector(`.mrow.head span[data-ep="${S.ep}"]`);
  if (head && mx.classList.contains("wide") && syncControls.ep !== `${S.token}:${S.ep}`) {    // keep the shown visit in view
    syncControls.ep = `${S.token}:${S.ep}`;
    mx.scrollLeft = Math.max(0, head.offsetLeft - mx.clientWidth + head.offsetWidth + 8);
  }
  document.querySelectorAll("#timeStrip .tile[data-ep]").forEach(c => c.classList.toggle("on", Number(c.dataset.ep) === S.ep && S.mode !== "stack"));
  const fr = S.meta?.epochs[S.ep]?.frames;
  document.querySelectorAll("#bandStrip .tile").forEach(c => { c.classList.toggle("on", Number(c.dataset.det) === S.det); c.classList.toggle("none", !!fr && !fr[c.dataset.det]); });
}
function layout() {           // the image is a square that fills the height left by the bars
  const b = $("body"), embed = document.body.classList.contains("embed");
  if (phone()) { b.style.removeProperty("--stage"); return; }
  const pad = embed ? 16 : 32, h = b.clientHeight - pad, w = b.clientWidth - pad;
  const side = embed ? Math.min(h - 44 - 12, w) : Math.min(h - 44 - 48 - 24, w - 280 - 320 - 24);
  b.style.setProperty("--stage", `${Math.max(280, Math.floor(side))}px`);
}
async function search(text) {
  if (!text.trim()) return;
  try {
    const c = parseCoord(text) || await resolveName(text.trim());
    $("coord").blur();
    goTo(c.ra, c.dec, c.det);
  } catch (e) { toast(e.message); }
}

function init() {
  $("search").onsubmit = ev => { ev.preventDefault(); search($("coord").value); };
  $("fov").onclick = ev => { const b = ev.target.closest("button[data-fov]"); if (b && Number(b.dataset.fov) !== S.fov) { S.fov = Number(b.dataset.fov); S.pickNext = S.pick; load(); } };
  $("fps").onchange = e => { S.fps = Number(e.target.value); if (S.timer) { stop(); play(); } };
  $("hi").oninput = e => { S.hi = sliderToHi(Number(e.target.value)); S.hiAuto = false; render(); };
  $("ref").onchange = e => { S.ref = Number(e.target.value); if (S.mode === "diff" && S.ep === S.ref) step(1); else render(); };
  $("play").onclick = () => { if (S.timer) { stop(); render(); } else play(); };
  for (const id of ["modes", "modesPhone"]) $(id).onclick = ev => { const b = ev.target.closest("button"); if (b) setMode(b.dataset.mode); };
  $("axis").onclick = ev => { const b = ev.target.closest("button"); if (b) { S.axis = b.dataset.axis; if (S.timer) { stop(); play(); } else render(); } };
  $("aper").onclick = ev => {
    const b = ev.target.closest("button");
    if (!b || Number(b.dataset.aper) === S.aper) return;
    const had = !!S.spec || S.specState === "loading";
    S.aper = Number(b.dataset.aper); writeUrl(); render(); loadSpectrum(!had);
  };
  $("layers").onclick = ev => { const b = ev.target.closest("button[data-layer]"); if (b) { S.ov[b.dataset.layer] = !S.ov[b.dataset.layer]; writeUrl(); render(); } };
  $("matrix").onclick = ev => {
    const c = ev.target.closest(".cell.has, .band");
    if (!c) return;
    const d = Number(c.dataset.det);
    if (c.dataset.ep != null) { stop(); S.ep = Number(c.dataset.ep); if (S.mode === "stack") S.mode = "blink"; }
    if (d !== S.det) setDet(d); else { writeUrl(); render(); }
  };
  $("track").onclick = ev => { const b = ev.target.closest(".stop"); if (b) setEpoch(Number(b.dataset.ep)); };
  $("timeStrip").onclick = ev => { const b = ev.target.closest(".tile[data-ep]"); if (b) setEpoch(Number(b.dataset.ep)); };
  $("bandStrip").onclick = ev => { const b = ev.target.closest(".tile[data-det]"); if (b) setDet(Number(b.dataset.det)); };
  $("state").onclick = ev => {
    const t = ev.target.closest("[data-target]"), a = ev.target.closest("[data-act]")?.dataset.act;
    if (t) { const g = TARGETS[t.dataset.target]; goTo(g.ra, g.dec, g.det); }
    else if (a === "cancel") { S.token++; S.abort?.abort(); stop(); setState("idle"); render(); }
    else if (a === "retry") load();
    else if (a === "pick") { const p = randomPatch(); goTo(p.ra, p.dec); }
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
    return { ...pixToSky(ix, iy, st.n, st.pixscale), val, sigma: cur.sigma || st.sigma };
  };
  view.onmousemove = ev => {
    const p = pointer(ev), el = $("cursor");
    el.hidden = !p;
    if (!p) return;
    const near = nearestSource(ev);
    el.innerHTML = `<span>${fmtPos(p.ra, p.dec)}</span><span>${Number.isFinite(p.val) ? `${(p.val / p.sigma).toFixed(1)}σ` : "no data"}</span>${near ? `<span>${esc(near)}</span>` : ""}`;
  };
  view.onmouseleave = () => ($("cursor").hidden = true);
  let clickTimer = null;   // wait briefly so that a double-click does not also measure a spectrum
  view.onclick = ev => {
    const p = pointer(ev);
    if (!p) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => setPick(p.ra, p.dec), 260);
  };
  view.ondblclick = ev => { clearTimeout(clickTimer); const p = pointer(ev); if (p) goTo(p.ra, p.dec); };
  $("spec").onmousemove = specHover;
  $("spec").onmouseleave = () => ($("specHover").textContent = "");
  $("specCsv").onclick = specCsv;

  window.addEventListener("keydown", ev => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (ev.key === "ArrowRight") { stop(); step(1); }
    else if (ev.key === "ArrowLeft") { stop(); step(-1); }
    else if (ev.key === " ") { ev.preventDefault(); $("play").click(); }
    else if (/^[1-6]$/.test(ev.key)) setDet(Number(ev.key));
    else if (k === "b") setMode("blink");
    else if (k === "d") setMode("diff");
    else if (k === "s") setMode("stack");
    else if (ev.key === "/") { ev.preventDefault(); $("coord").focus(); $("coord").select(); }
  });
  let lastW = 0;
  new ResizeObserver(() => { layout(); const w = $("track").clientWidth; if (w !== lastW) { lastW = w; buildTrack(); } render(); }).observe($("body"));
  window.addEventListener("themechange", render);

  const u = readUrl();
  layout();
  if (u.q) { $("coord").value = u.q; setState("idle"); render(); search(u.q); }
  else if (u.pick) { const p = randomPatch(); goTo(p.ra, p.dec); }
  else load();
  if (u.focus) { $("coord").focus(); $("coord").select(); }
}
Object.assign(App, { goTo, setPick, setDet, setEpoch, setMode, load, render, toScreen, pageUrl, randomPatch, toast, download, stop, play, layout });
window.addEventListener("DOMContentLoaded", init);
