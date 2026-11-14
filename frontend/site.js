// Shared shell of every page: theme, icons, top bar, footer. AI-assisted code (Claude Code).
"use strict";

// ---------- theme (set before first paint; this script is loaded in <head>) ----------
const Theme = {
  get() { return document.documentElement.dataset.theme === "light" ? "light" : "dark"; },
  set(t, save = true) {
    document.documentElement.dataset.theme = t;
    if (save) try { localStorage.setItem("theme", t); } catch { /* private window: keep for this page only */ }
    window.dispatchEvent(new CustomEvent("themechange", { detail: t }));
  },
  init() {
    let t = null;
    try { t = localStorage.getItem("theme"); } catch { /* storage blocked */ }
    if (t !== "light" && t !== "dark") t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = t;
  },
};
Theme.init();

// ---------- icons (24-unit grid, drawn with the current text colour) ----------
const ICONS = {
  target: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  play: '<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
};
const ico = (name, size = 16) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

customElements.define("x-ico", class extends HTMLElement {
  connectedCallback() { this.style.display = "inline-flex"; this.innerHTML = ico(this.getAttribute("name"), Number(this.getAttribute("size")) || 16); }
});

// ---------- top bar pieces ----------
const PAGES = [["explore", "Explore", "/explore"], ["targets", "Targets", "/targets"], ["method", "Method", "/method"], ["api", "API", "/api-docs"], ["about", "About", "/about"]];
const navHtml = active => `<nav class="nav" aria-label="Site">${PAGES.map(([k, l, h]) => `<a href="${h}"${k === active ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
const brandHtml = () => `<a class="brand" href="/" aria-label="SPHEREx Blink, home">${ico("target", 20)}<span>SPHEREx Blink</span></a>`;

customElements.define("site-brand", class extends HTMLElement { connectedCallback() { this.style.display = "contents"; this.innerHTML = brandHtml(); } });
customElements.define("site-nav", class extends HTMLElement { connectedCallback() { this.style.display = "contents"; this.innerHTML = navHtml(this.getAttribute("active")); } });
customElements.define("theme-toggle", class extends HTMLElement {
  connectedCallback() {
    this.style.display = "contents";
    this.innerHTML = `<button class="theme" type="button" aria-label="Switch between light and dark theme"><span class="sun">${ico("sun", 14)}</span><span class="moon">${ico("moon", 14)}</span></button>`;
    this.firstChild.addEventListener("click", () => Theme.set(Theme.get() === "light" ? "dark" : "light"));
  }
});
customElements.define("site-header", class extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<header class="topbar"><div class="group">${brandHtml()}${navHtml(this.getAttribute("active"))}</div><div class="group r"><theme-toggle></theme-toggle></div></header>`;
  }
});
customElements.define("site-footer", class extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<footer class="footer wrap"><span>SPHEREx data: NASA/JPL-Caltech, served by IRSA&nbsp; ·&nbsp; Gaia DR3: ESA/Gaia/DPAC&nbsp; ·&nbsp; CatWISE2020: NASA WISE/NEOWISE</span><nav aria-label="Footer"><a href="/api-docs">API</a><a href="/about">About</a><a href="https://github.com/YosefGul/spherex-blink" rel="noopener">Source code</a></nav></footer>`;
  }
});

// The five test targets of the challenge. Present-day (2026) positions for the fast movers.
const TARGETS = [
  { name: "Barnard's Star", short: "Barnard’s Star", ra: 269.4463, dec: 4.7680, det: 2, kind: "moves" },
  { name: "Eps Indi B", short: "Eps Indi B", long: "Epsilon Indi B", ra: 331.0960, dec: -56.8010, det: 5, kind: "moves" },
  { name: "WISE 0855", short: "WISE 0855−0714", ra: 133.7598, dec: -7.2422, det: 5, kind: "moves" },
  { name: "RW Aur", short: "RW Aur", long: "RW Aurigae", ra: 76.9563, dec: 30.4014, det: 3, kind: "varies" },
  { name: "R Dra", short: "R Dra", long: "R Draconis", ra: 248.1675, dec: 66.7550, det: 3, kind: "varies" },
];
const targetHref = t => `/explore?ra=${t.ra}&dec=${t.dec}&det=${t.det}`;

// Browser-tab icon: the brand mark, drawn inline so no extra file is requested.
document.head.insertAdjacentHTML("beforeend", `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linecap="round">${ICONS.target}</svg>`)}">`);
