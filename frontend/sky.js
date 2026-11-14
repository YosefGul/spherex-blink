// Image helpers shared by the home preview and the viewer. AI-assisted code (Claude Code).
"use strict";
const Sky = {
  decode(b64) {                       // base64 little-endian float32
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  },
  mean(imgs) {
    const have = imgs.filter(Boolean);
    if (!have.length) return null;
    const out = new Float32Array(have[0].length);
    for (let p = 0; p < out.length; p++) {
      let s = 0, c = 0;
      for (const im of have) if (Number.isFinite(im[p])) { s += im[p]; c++; }
      out[p] = c ? s / c : NaN;
    }
    return out;
  },
  sigma(img) {                        // robust noise estimate (1.4826 × median absolute deviation)
    const v = Array.from(img).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return 1;
    const med = v[v.length >> 1];
    const dev = v.map(x => Math.abs(x - med)).sort((a, b) => a - b);
    return 1.4826 * dev[dev.length >> 1] || 1;
  },
  autoHi(mean, n, sigma) {            // bright target: open the stretch so its core is not burnt out
    const c = (n - 1) >> 1;
    let pk = 0;
    for (let j = c - 4; j <= c + 4; j++) for (let i = c - 4; i <= c + 4; i++) pk = Math.max(pk, mean[j * n + i] || 0);
    return pk > 100 * sigma ? Math.min(10000, Math.round(0.6 * pk / sigma)) : 12;
  },
  // Paint an n×n image (row 0 at the south edge) into an n×n canvas. cur = {img, div, sigma?}.
  paint(canvas, cur, n, sig, hiSigma) {
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext("2d"), id = ctx.createImageData(n, n), px = id.data;
    // asinh stretch; the wider the range, the more logarithmic, so faint stars stay visible next to a bright one
    const soft = Math.max(8, hiSigma / 3), k = Math.asinh(soft);
    const lo = -2 * sig, hi = hiSigma * sig, dmax = Math.min(hiSigma, 40) * (cur.sigma || sig) / 2;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = cur.img[j * n + i], o = ((n - 1 - j) * n + i) * 4;
        let r = 14, g = 14, b = 16;
        if (Number.isFinite(v)) {
          if (cur.div) {
            const t = Math.min(1, Math.abs(v) / dmax) ** 1.5;   // keeps 1-2σ noise dark
            const c = v < 0 ? [60, 130, 255] : [255, 110, 60];
            r = 10 + (c[0] - 10) * t; g = 10 + (c[1] - 10) * t; b = 12 + (c[2] - 12) * t;
          } else {
            const u = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
            r = g = b = 255 * Math.asinh(soft * u) / k;
          }
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
  },
  async api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch { /* keep status text */ }
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r.json();
  },
};
