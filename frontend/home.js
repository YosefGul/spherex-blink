// Home page: a live blink of Epsilon Indi B from the shipped stacks. AI-assisted code (Claude Code).
"use strict";
(async () => {
  const T = TARGETS[1], $ = id => document.getElementById(id);
  const epochVar = (i, n) => (i === n - 1 ? "var(--epoch-current)" : `var(--epoch-${Math.min(3, Math.max(1, 3 - (n - 2 - i)))})`);
  const short = label => label.replace(/\s(\d\d)(\d\d)$/, " ’$2");
  try {
    const q = `ra=${T.ra}&dec=${T.dec}`;
    const [meta, st] = await Promise.all([Sky.api(`/api/epochs?${q}`), Sky.api(`/api/stack?${q}&fov=240&det=${T.det}`)]);
    const imgs = st.epochs.map(e => (e.data ? Sky.decode(e.data) : null)), n = imgs.length;
    const mean = Sky.mean(imgs), sig = Sky.sigma(mean), hi = Sky.autoHi(mean, st.n, sig);
    const have = imgs.map((im, i) => (im ? i : -1)).filter(i => i >= 0);
    if (!have.length) return;
    $("fVisits").textContent = meta.epochs.length; $("fFrames").textContent = meta.total_frames;
    const strip = $("pvVisits");
    strip.innerHTML = meta.epochs.map((e, i) => `<span style="--c:${epochVar(i, n)}"><i></i>${short(e.label)}</span>`).join("");
    strip.hidden = false;
    const show = i => {
      Sky.paint($("pv"), { img: imgs[i] }, st.n, sig, hi);
      $("pvEpoch").textContent = meta.epochs[i].label; $("pvEpoch").style.color = epochVar(i, n);
      [...strip.children].forEach((s, k) => s.classList.toggle("on", k === i));
    };
    let k = have.length - 1;
    show(have[k]);
    if (have.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      setInterval(() => { k = (k + 1) % have.length; show(have[k]); }, 900);
  } catch { /* the preview is decoration: leave it dark if the data is not there */ }
})();
