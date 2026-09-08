// Page runtime. Concatenated after the wasm-bindgen glue by the build
// script, so `initSync`, `Ocean`, and the injected `WASM_B64` constant are
// in scope. Everything here is progressive enhancement: with no WebAssembly
// (or no JS at all) the page stays a complete, readable document.

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// --- Theme toggle (only present in the standalone build) ------------------

const themeBtn = document.getElementById('theme-btn');

function currentTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return systemDark.matches ? 'dark' : 'light';
}

function updateThemeButton() {
  if (!themeBtn) return;
  themeBtn.setAttribute(
    'aria-label',
    currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
  );
}

// Browser chrome (mobile address bar etc.) follows the manual choice too.
function syncThemeColorMeta() {
  if (!document.documentElement.dataset.theme) return;
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', bg));
}

if (themeBtn) {
  // A head script already applied any saved theme pre-paint; this only
  // repairs state if that script was stripped.
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.dataset.theme = saved;
    }
  } catch (e) { /* private mode: system theme only */ }

  themeBtn.hidden = false;
  updateThemeButton();
  syncThemeColorMeta();

  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* ignore */ }
    refreshPalette();
    repaintIfStatic();
    updateThemeButton();
    syncThemeColorMeta();
  });
}

// --- Ocean background ------------------------------------------------------

const canvas = document.getElementById('ocean');
const noteText = document.getElementById('live-note-text');
let ocean = null;
let wasmExports = null;
let ctx = null;
let running = false;

// Under reduced motion no animation loop exists, so anything that clears or
// re-colors the canvas (resize, theme change) must repaint the still frame.
function repaintIfStatic() {
  if (ocean && ctx && !running) {
    ocean.tick(0);
    drawFrame();
  }
}

// shade codes emitted by the simulation, in buffer order
const SHADES = [0.0, 0.45, 0.62, 1.0];
const SHADE_VARS = ['--dot-body', '--dot-saddle', '--dot-speck', '--dot-patch'];
const ALPHA_STEPS = 12;
let palette = []; // [shadeIndex][alphaBucket] -> rgba string

function refreshPalette() {
  const styles = getComputedStyle(document.documentElement);
  palette = SHADE_VARS.map((name) => {
    const hex = styles.getPropertyValue(name).trim();
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const ramp = [];
    for (let i = 0; i < ALPHA_STEPS; i++) {
      ramp.push(`rgba(${r},${g},${b},${((i + 0.5) / ALPHA_STEPS).toFixed(3)})`);
    }
    return ramp;
  });
}

function shadeIndex(shade) {
  let best = 0;
  for (let i = 1; i < SHADES.length; i++) {
    if (Math.abs(SHADES[i] - shade) < Math.abs(SHADES[best] - shade)) best = i;
  }
  return best;
}

function resize() {
  if (!canvas || !ctx || !ocean) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ocean.resize(w, h);
  // Reassigning canvas dimensions wiped the bitmap; restore the still frame.
  repaintIfStatic();
}

// Resize events arrive in bursts (drag, mobile URL bar); reallocating the
// backing store more than once per frame is pure waste.
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    resize();
  });
}

function drawFrame() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  // The buffer view is rebuilt every frame: linear memory may move if it grows.
  const view = new Float32Array(
    wasmExports.memory.buffer,
    ocean.particles_ptr(),
    ocean.particles_len(),
  );
  for (let i = 0; i < view.length; i += 5) {
    const size = view[i + 2];
    const bucket = Math.min(
      ALPHA_STEPS - 1,
      Math.max(0, Math.floor(view[i + 4] * ALPHA_STEPS)),
    );
    ctx.fillStyle = palette[shadeIndex(view[i + 3])][bucket];
    // Square, pixel-snapped dots.
    ctx.fillRect(
      Math.round(view[i] - size),
      Math.round(view[i + 1] - size),
      Math.max(1, Math.round(size * 2)),
      Math.max(1, Math.round(size * 2)),
    );
  }
}

function startOcean() {
  if (!canvas || typeof WebAssembly === 'undefined') return;
  try {
    wasmExports = initSync({ module: decodeWasm(WASM_B64) });
  } catch (e) {
    // CSP without wasm eval, or an unsupported browser: keep the calm gradient.
    canvas.remove();
    if (noteText) {
      noteText.textContent =
        'the WebAssembly ocean could not start here — the page works fine without it.';
    }
    return;
  }

  ctx = canvas.getContext('2d');
  ocean = new Ocean(window.innerWidth, window.innerHeight, 0x0dca);
  refreshPalette();
  resize();
  window.addEventListener('resize', queueResize);
  systemDark.addEventListener('change', () => {
    refreshPalette();
    repaintIfStatic();
    updateThemeButton();
  });
  // In the artifact host the theme arrives as a data-theme stamp on the
  // root element rather than a media-query change; recolor when it does.
  new MutationObserver(() => {
    refreshPalette();
    repaintIfStatic();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  let last = performance.now();

  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    ocean.tick(dt);
    drawFrame();
    requestAnimationFrame(frame);
  }

  function setMotion() {
    if (reducedMotion.matches) {
      running = false;
      ocean.settle();
      drawFrame();
    } else if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  }

  reducedMotion.addEventListener('change', setMotion);
  document.addEventListener('visibilitychange', () => {
    // rAF pauses in hidden tabs; just avoid a giant dt on return.
    last = performance.now();
  });
  setMotion();
}

function decodeWasm(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

startOcean();

// --- Depth rail ------------------------------------------------------------

const marker = document.getElementById('depth-marker');
const readout = document.getElementById('depth-readout');

if (marker && readout) {
  let rafPending = false;
  const updateDepth = () => {
    rafPending = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    marker.style.top = `${(p * 100).toFixed(1)}%`;
    readout.textContent = `−${Math.round(p * 1000)} m`;
  };
  window.addEventListener(
    'scroll',
    () => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(updateDepth);
      }
    },
    { passive: true },
  );
  updateDepth();
}

// --- Section reveals -------------------------------------------------------

if ('IntersectionObserver' in window && !reducedMotion.matches) {
  document.documentElement.classList.add('js-anim');
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}
