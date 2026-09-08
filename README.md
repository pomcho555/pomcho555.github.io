# Depth Log — portfolio page

Portfolio page generated from the CV in `../resume.md`. The personal name,
contact details, alma mater universities, and publications are withheld;
everything else — employers, MaskTap, RCAST/UTokyo affiliation, GitHub /
Kaggle / X links, award and OSS specifics — is shown, with the CV's original
URLs kept intact.

The background is a pod of orcas rendered as square dots — a particle
simulation written in Rust, compiled to `wasm32-unknown-unknown` with
[wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen), and embedded
into the page as base64 (the single-file builds work from `file://`, no
server needed).

The GitHub Pages build additionally stores the CV data in
**DuckDB-WASM** (OPFS-persisted when the browser allows) and ships a "Sonar"
SQL console: visitors can query the data, and an `UPDATE` re-renders the
experience timeline live.

## Layout

```
wasm/            Rust crate (simulation: sampling, swim wave, drift)
  src/lib.rs
  pkg/           wasm-pack output (generated)
web/             page source
  style.css      design tokens, dark/light themes
  body.html      content
  app.js         canvas renderer, theme toggle, depth rail, reveals
  console.html   Sonar console markup (site build only)
  console.js     DuckDB boot, seeding, SQL console, live re-render
  cvdata.js      seed rows for the DuckDB tables
tools/
  build.mjs      assembles all three dist outputs
  preview.mjs    headless render of the sim to PNG (no browser needed)
  testserver.mjs static server with a load-latch, used for headless E2E
dist/
  index.html     fully standalone single file — open directly
  artifact.html  Artifact-host flavor (no document wrapper / theme toggle)
  site/          ← deploy this directory to GitHub Pages
    index.html
    assets/      bundled console.js + DuckDB worker + duckdb-eh.wasm (36 MB)
```

## Build

```sh
npm install                                      # duckdb-wasm + esbuild
(cd wasm && wasm-pack build --target web --release)
node tools/build.mjs
```

Test / preview:

```sh
(cd wasm && cargo test)                     # silhouette + determinism tests
node tools/preview.mjs 0 dist/preview.png   # static scene render
node tools/preview.mjs 4 dist/preview.png   # after 4 s of swimming
```

## Deploying to GitHub Pages

Deployment is automated: pushing to `master` of
[pomcho555.github.io](https://github.com/pomcho555/pomcho555.github.io) runs
`.github/workflows/deploy.yml`, which tests and builds the Rust crate
(wasm-pack), assembles the site (`node tools/build.mjs`), and publishes
`dist/site/` to GitHub Pages via `actions/deploy-pages`. Pull requests run
the build for CI signal without deploying. Notes:

- `duckdb-eh.wasm` is ~36 MB — within the GitHub Pages per-file limit, and
  fetched lazily by the console module, so first paint doesn't wait for it.
- No COOP/COEP headers are required (the `eh` bundle, not `coi`).
- OPFS persistence (`opfs://depthlog.db`) works on HTTPS origins; browsers
  without OPFS silently fall back to an in-memory database.

## How the background works

- `Ocean::new` rejection-samples ~1,800 dots from an orca silhouette SDF
  (torso profile, falcate dorsal fin, sheared flukes, pectoral, white eye
  patch / chin, gray saddle) for a pod of three, plus ~140 drifting specks.
- Each `tick(dt)` applies a traveling wave down the spine (amplitude grows
  toward the tail), drift, and wrap-around, then packs
  `[x, y, size, shade, alpha]` per dot into one `Vec<f32>`.
- JS builds a `Float32Array` view over linear memory each frame and blits
  square, pixel-snapped dots with a precomputed rgba palette keyed off CSS
  custom properties — so the dots re-color with the theme.
- `prefers-reduced-motion` renders one calm static frame (`settle()`);
  if WebAssembly is unavailable (strict CSP), the canvas is removed and the
  page stands on its own.
