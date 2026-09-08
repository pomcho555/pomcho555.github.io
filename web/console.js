// "Sonar" console — the page's data lives in DuckDB-WASM.
//
// Boot: spin up the DuckDB worker, open an OPFS-backed database when the
// browser offers one (falls back to in-memory), seed the CV tables on first
// run, then wire a small SQL console. Any statement that touches
// `experience` re-renders the dive record above, so UPDATEs change the page.
//
// Served only in the GitHub Pages build (dist/site/): DuckDB needs a real
// HTTP origin for its worker, so the single-file builds omit this module.

import * as duckdb from '@duckdb/duckdb-wasm';
import { CV } from './cvdata.js';

const section = document.getElementById('console');
const statusEl = document.getElementById('console-status');
const sqlEl = document.getElementById('console-sql');
const runBtn = document.getElementById('console-run');
const resetBtn = document.getElementById('console-reset');
const resultEl = document.getElementById('console-result');
const persistNote = document.getElementById('persist-note');

let conn = null;
let persistent = false;

boot();

async function boot() {
  if (!section) return;
  section.hidden = false;
  try {
    const worker = new Worker(new URL('./duckdb-browser-eh.worker.js', import.meta.url));
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(new URL('./duckdb-eh.wasm', import.meta.url).href);

    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        await db.open({
          path: 'opfs://depthlog.db',
          accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
        });
        persistent = true;
      }
    } catch (e) {
      // No OPFS (private window, older browser): stay in-memory.
    }

    conn = await db.connect();
    await seedIfEmpty();
    await rerenderTimeline();

    if (persistNote) {
      persistNote.textContent = persistent
        ? ' — and persists in this browser via OPFS'
        : '';
    }
    setStatus(`ready · duckdb ${await versionOf(db)} · ${persistent ? 'opfs://depthlog.db' : 'in-memory'}`);
  } catch (e) {
    setStatus(`DuckDB could not start here — ${String(e && e.message || e).slice(0, 120)}`, true);
    if (runBtn) runBtn.disabled = true;
    return;
  }

  runBtn.addEventListener('click', run);
  sqlEl.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      run();
    }
  });
  document.querySelectorAll('.console-chips button[data-sql]').forEach((b) => {
    b.addEventListener('click', () => {
      sqlEl.value = b.dataset.sql;
      run();
    });
  });
  resetBtn.addEventListener('click', async () => {
    try {
      await conn.query('DROP TABLE IF EXISTS experience; DROP TABLE IF EXISTS skills; DROP TABLE IF EXISTS signals;');
      await seedIfEmpty();
      await rerenderTimeline();
      resultEl.innerHTML = '';
      setStatus('data reset to the shipped CV');
    } catch (e) {
      setStatus(String(e.message || e), true);
    }
  });
}

async function versionOf(db) {
  try { return (await db.getVersion()).replace(/^v/, ''); } catch (e) { return 'wasm'; }
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', !!isError);
}

// --- Seeding ---------------------------------------------------------------

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function seedIfEmpty() {
  const t = await conn.query(
    `SELECT count(*)::INT AS n FROM information_schema.tables
     WHERE table_name IN ('experience','skills','signals')`,
  );
  if (t.toArray()[0].n === 3) return;

  const stmts = [
    `CREATE TABLE IF NOT EXISTS experience(
       depth_m INTEGER PRIMARY KEY, role VARCHAR, org VARCHAR, org_url VARCHAR,
       link_url VARCHAR, link_label VARCHAR,
       start_label VARCHAR, dt_start VARCHAR, end_label VARCHAR, dt_end VARCHAR,
       bullets VARCHAR)`,
    `CREATE TABLE IF NOT EXISTS skills(area VARCHAR, item VARCHAR, ord INTEGER)`,
    `CREATE TABLE IF NOT EXISTS signals(category VARCHAR, what VARCHAR, note VARCHAR, url VARCHAR)`,
  ];
  for (const e of CV.experience) {
    stmts.push(
      `INSERT OR REPLACE INTO experience VALUES (${e.depth_m}, ${q(e.role)}, ${q(e.org)},
       ${q(e.org_url)}, ${q(e.link_url)}, ${q(e.link_label)}, ${q(e.start_label)},
       ${q(e.dt_start)}, ${q(e.end_label)}, ${q(e.dt_end)}, ${q(JSON.stringify(e.bullets))})`,
    );
  }
  CV.skills.forEach(([area, items]) => {
    items.forEach((item, i) => {
      stmts.push(`INSERT INTO skills VALUES (${q(area)}, ${q(item)}, ${i})`);
    });
  });
  for (const [category, what, note, url] of CV.signals) {
    stmts.push(`INSERT INTO signals VALUES (${q(category)}, ${q(what)}, ${q(note)}, ${q(url)})`);
  }
  await conn.query(stmts.join(';\n'));
}

// --- Console ---------------------------------------------------------------

async function run() {
  const sql = sqlEl.value.trim();
  if (!sql || !conn) return;
  const t0 = performance.now();
  try {
    const res = await conn.query(sql);
    const ms = (performance.now() - t0).toFixed(1);
    renderResult(res);
    const n = res.numRows;
    setStatus(`${n} row${n === 1 ? '' : 's'} · ${ms} ms · ${persistent ? 'opfs' : 'in-memory'}`);
    await rerenderTimeline();
  } catch (e) {
    setStatus(String(e.message || e).split('\n')[0].slice(0, 200), true);
  }
}

function renderResult(res) {
  const cols = res.schema.fields.map((f) => f.name);
  const rows = res.toArray().slice(0, 100);
  if (!cols.length) {
    resultEl.innerHTML = '';
    return;
  }
  const esc = escapeHtml;
  const head = cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const body = rows
    .map((r) => {
      const j = r.toJSON();
      return `<tr>${cols.map((c) => `<td>${esc(fmt(j[c]))}</td>`).join('')}</tr>`;
    })
    .join('');
  const more = res.numRows > 100
    ? `<p class="mono muted">… ${res.numRows - 100} more rows not shown</p>`
    : '';
  resultEl.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

function fmt(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Live re-render of the dive record ------------------------------------

async function rerenderTimeline() {
  const ol = document.querySelector('.dive-record');
  if (!ol || !conn) return;
  let rows;
  try {
    rows = (await conn.query('SELECT * FROM experience ORDER BY depth_m'))
      .toArray().map((r) => r.toJSON());
  } catch (e) {
    return; // table dropped or renamed — leave the static markup alone
  }
  const esc = escapeHtml;
  ol.innerHTML = rows
    .map((r) => {
      let bullets = [];
      try { bullets = JSON.parse(r.bullets || '[]'); } catch (e) { bullets = [String(r.bullets)]; }
      const org = r.org_url
        ? `<a href="${esc(r.org_url)}" rel="noopener">${esc(r.org)}</a>`
        : esc(r.org || '');
      const end = r.end_label
        ? `<time datetime="${esc(r.dt_end || '')}">${esc(r.end_label)}</time>`
        : 'present';
      const extra = r.link_url
        ? `<a class="mono" href="${esc(r.link_url)}" rel="noopener">${esc(r.link_label || 'link ↗')}</a>`
        : '';
      return `<li>
        <p class="depth-tag"><span class="depth">▾ ${Number(r.depth_m)} m</span>
          <time datetime="${esc(r.dt_start || '')}">${esc(r.start_label || '')}</time> — ${end}</p>
        <div class="role-head"><h3>${esc(r.role || '')} <span class="org">· ${org}</span></h3>${extra}</div>
        <ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      </li>`;
    })
    .join('');
}
