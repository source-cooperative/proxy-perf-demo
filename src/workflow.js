// Query-workbench view: a realistic analyst workflow. Run the same SQL against
// the remote Parquet through each endpoint with DuckDB-WASM, which fetches only
// the bytes each query needs over HTTP range requests — footer, a row group, a
// single column — and compare how long it takes per endpoint.

import { ENDPOINTS, DATASETS, url } from "./config.js";
import { newDb, runSqlOn } from "./duckdb.js";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), attrs);
  for (const k of kids) n.append(k);
  return n;
};

// Presets. `{url}` is substituted per endpoint. Each demonstrates a different
// range-read shape, noted in `reads`.
const PRESETS = {
  count: {
    label: "Row count",
    reads: "footer only — the last few KB",
    sql: `SELECT count(*) AS buildings\nFROM read_parquet('{url}')`,
  },
  peek: {
    label: "Peek 5 rows",
    reads: "footer + the first row group (all columns, a few rows)",
    sql: `SELECT *\nFROM read_parquet('{url}')\nLIMIT 5`,
  },
  extent: {
    label: "Spatial extent (bbox column scan)",
    reads: "the bbox column across every row group — geometry is skipped",
    sql:
      `SELECT count(*) AS n,\n` +
      `       min(bbox.xmin) AS west, max(bbox.xmax) AS east,\n` +
      `       min(bbox.ymin) AS south, max(bbox.ymax) AS north\n` +
      `FROM read_parquet('{url}')`,
  },
};

let running = null;

function build() {
  const epBox = $("#endpoints");
  for (const e of ENDPOINTS) {
    const cb = el("input", { type: "checkbox", checked: true, id: `ep-${e.id}`, value: e.id });
    epBox.append(
      el("label", { className: "chip", style: `--c:${e.color}` }, cb,
        el("span", { className: "dot" }), el("b", {}, e.label), el("small", {}, ` ${e.note}`))
    );
  }
  const ds = $("#dataset");
  for (const d of DATASETS) ds.append(el("option", { value: d.id, textContent: d.label }));
  const pr = $("#preset");
  for (const [k, p] of Object.entries(PRESETS)) pr.append(el("option", { value: k, textContent: p.label }));
  pr.append(el("option", { value: "custom", textContent: "Custom…" }));

  pr.addEventListener("change", loadPreset);
  ds.addEventListener("change", () => { showUrls(); refreshReads(); });
  epBox.addEventListener("change", showUrls);
  loadPreset();
  showUrls();
}

function loadPreset() {
  const k = $("#preset").value;
  if (k !== "custom") $("#sql").value = PRESETS[k].sql;
  refreshReads();
}

function refreshReads() {
  const k = $("#preset").value;
  $("#reads").textContent = k === "custom" ? "Custom query — reads whatever DuckDB needs." : `Reads: ${PRESETS[k].reads}.`;
}

function showUrls() {
  const dataset = DATASETS.find((d) => d.id === $("#dataset").value);
  const box = $("#urls");
  box.replaceChildren();
  for (const e of ENDPOINTS) {
    const on = $(`#ep-${e.id}`)?.checked;
    box.append(
      el("div", { className: `urlrow ${on ? "" : "off"}` },
        el("span", { className: "dot", style: `background:${e.color}` }),
        el("span", { className: "urllabel" }, e.label),
        el("a", { className: "url", href: url(e, dataset.path), target: "_blank", rel: "noopener",
                  textContent: url(e, dataset.path) }))
    );
  }
}

async function run() {
  if (running) { running.abort(); return; }
  const endpoints = ENDPOINTS.filter((e) => $(`#ep-${e.id}`).checked);
  const dataset = DATASETS.find((d) => d.id === $("#dataset").value);
  const template = $("#sql").value.trim();
  if (!endpoints.length || !template) return;

  running = new AbortController();
  setRunning(true);
  log(`▶ query · ${dataset.label}`);
  log("  fresh DuckDB per endpoint (cold cache) so the timing is the endpoint, not DuckDB's memory…");

  const results = [];
  try {
    for (const e of endpoints) {
      if (running.signal.aborted) break;
      const sql = template.replaceAll("{url}", url(e, dataset.path));
      log(`  ${e.label}: running…`);
      let handle = null;
      try {
        handle = await newDb();
        const r = await runSqlOn(handle.db, sql, running.signal);
        results.push({ e, ...r });
        log(`  ${e.label}: ${r.ms.toFixed(0)} ms · ${r.numRows} row(s)`);
      } catch (err) {
        results.push({ e, error: err.message });
        log(`  ${e.label}: FAILED — ${err.message}`);
      } finally {
        if (handle) await handle.close();
      }
    }
    render(dataset, template, results);
    log("✓ done");
  } catch (err) {
    log(`✗ ${err.message}`);
  } finally {
    setRunning(false);
    running = null;
  }
}

function render(dataset, template, results) {
  const card = el("div", { className: "card" });
  card.append(el("h3", {}, `${PRESETS[$("#preset").value]?.label ?? "Custom query"} · ${dataset.label}`));
  card.append(el("p", { className: "metricnote" }, "Query time (ms) · ↓ lower is better. ",
    el("span", { className: "muted" }, "Same query, same result — only the endpoint differs.")));

  // Timing comparison (bars + edge-cache-vs-others summary).
  const ok = results.filter((r) => !r.error && r.ms != null);
  const maxMs = Math.max(...ok.map((r) => r.ms), 0.0001);
  const winner = ok.reduce((a, b) => (a && a.ms <= b.ms ? a : b), null)?.e.id;

  const table = el("table");
  table.append(el("tr", {}, el("th", {}, "Endpoint"), el("th", {}, "Query time ↓"), el("th", { className: "barcol" }, "Visual")));
  for (const r of results) {
    const barPct = r.error ? 0 : (1 - r.ms / (maxMs * 1.05)) * 100;
    const bar = el("div", { className: "bar" }, el("span", { style: `width:${Math.max(3, barPct).toFixed(1)}%;background:${r.e.color}` }));
    table.append(el("tr", { className: r.e.id === winner ? "win" : "" },
      el("td", {}, el("span", { className: "dot", style: `background:${r.e.color}` }), ` ${r.e.label}`),
      el("td", {}, el("b", {}, r.error ? "FAIL" : `${r.ms.toFixed(0)} ms`)),
      el("td", { className: "barcol" }, r.error ? el("small", { className: "err" }, r.error) : bar)));
  }
  card.append(table);

  // Edge cache vs. direct and vs. no-cache proxy.
  const prev = results.find((r) => r.e.id === "preview" && !r.error);
  if (prev) {
    const box = el("div", { className: "callout" });
    box.append(el("div", { className: "callout-h" }, "Edge cache vs. (query time):"));
    let any = false;
    for (const id of ["direct", "staging"]) {
      const o = results.find((r) => r.e.id === id && !r.error);
      if (!o) continue;
      any = true;
      const s = o.ms / prev.ms;
      box.append(el("div", { className: "callout-row" }, el("span", {}, o.e.label),
        el("b", { className: s >= 1 ? "good" : "bad" }, `${s.toFixed(1)}× ${s >= 1 ? "faster" : "slower"}`)));
    }
    if (any) card.append(box);
  }

  // The result itself (identical across endpoints — show the first success).
  const sample = results.find((r) => !r.error && r.rows);
  if (sample) {
    card.append(el("div", { className: "resulthdr" }, `Result — ${sample.numRows} row(s)`));
    card.append(resultTable(sample.columns, sample.rows));
  }

  // The exact SQL that ran (with a real URL substituted).
  const anyEp = results[0]?.e;
  if (anyEp) {
    const sql = template.replaceAll("{url}", url(anyEp, dataset.path));
    card.append(el("details", { className: "sqldetail" },
      el("summary", {}, "SQL sent"), el("pre", {}, sql)));
  }
  $("#results").prepend(card);
}

function resultTable(columns, rows) {
  const wrap = el("div", { className: "resultscroll" });
  const t = el("table", { className: "result" });
  t.append(el("tr", {}, ...columns.map((c) => el("th", {}, c))));
  for (const row of rows.slice(0, 20)) {
    t.append(el("tr", {}, ...columns.map((c) => el("td", {}, fmtCell(row[c])))));
  }
  wrap.append(t);
  return wrap;
}

const fmtCell = (v) =>
  v == null ? "" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(4)) : String(v).slice(0, 80);

const log = (m) => { const l = $("#log"); l.append(el("div", {}, m)); l.scrollTop = l.scrollHeight; };
function setRunning(on) {
  $("#run").textContent = on ? "Stop" : "Run query";
  $("#run").classList.toggle("stop", on);
  for (const id of ["dataset", "preset", "sql"]) $(`#${id}`).disabled = on;
  if (on) $("#log").replaceChildren();
}

build();
$("#run").addEventListener("click", run);
