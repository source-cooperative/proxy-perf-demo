import { ENDPOINTS, DATASETS, url } from "./config.js";
import { SCENARIOS, runScenario, fmt } from "./bench.js";

// Raw range-read benchmarks. DuckDB queries live in the Query workbench view
// (workflow.html), where a fresh DuckDB instance per endpoint keeps DuckDB's own
// cache from confounding the comparison.
const CATALOG = { ...SCENARIOS };

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), attrs);
  for (const k of kids) n.append(k);
  return n;
};

let running = null; // AbortController while a run is in flight

function buildControls() {
  // Endpoints (all on by default)
  const epBox = $("#endpoints");
  for (const e of ENDPOINTS) {
    const cb = el("input", { type: "checkbox", checked: true, value: e.id, id: `ep-${e.id}` });
    epBox.append(
      el("label", { className: "chip", style: `--c:${e.color}` }, cb,
        el("span", { className: "dot" }),
        el("b", {}, e.label),
        el("small", {}, ` ${e.note}`))
    );
  }
  // Datasets
  const ds = $("#dataset");
  for (const d of DATASETS) ds.append(el("option", { value: d.id, textContent: d.label }));
  // Scenarios
  const sc = $("#scenario");
  const groups = [
    ["Raw HTTP range", ["ttfb", "footer", "throughput"]],
  ];
  for (const [g, keys] of groups) {
    const og = el("optgroup", { label: g });
    for (const k of keys) og.append(el("option", { value: k, textContent: CATALOG[k].label }));
    sc.append(og);
  }
  sc.addEventListener("change", showBlurb);
  ds.addEventListener("change", showUrls);
  epBox.addEventListener("change", showUrls);
  showBlurb();
  showUrls();
}

function showBlurb() {
  $("#blurb").textContent = CATALOG[$("#scenario").value].blurb || "";
}

// Live list of the exact URLs each selected endpoint will be hit at, for the
// currently selected dataset. The object key is identical across endpoints;
// only the base differs.
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

function selectedEndpoints() {
  return ENDPOINTS.filter((e) => $(`#ep-${e.id}`).checked);
}

async function run() {
  if (running) {
    running.abort();
    return;
  }
  const endpoints = selectedEndpoints();
  const dataset = DATASETS.find((d) => d.id === $("#dataset").value);
  const scenario = CATALOG[$("#scenario").value];
  const samples = Math.max(2, Math.min(20, +$("#samples").value || 6));
  if (endpoints.length < 1) return log("Select at least one endpoint.");

  running = new AbortController();
  setRunning(true);
  clearOutput();
  log(`▶ ${scenario.label}`);
  log(`  dataset: ${dataset.label}`);
  log(`  endpoints: ${endpoints.map((e) => e.label).join(", ")} · ${samples} samples (interleaved)`);

  const resolveUrl = (e) => url(e, dataset.path);
  for (const e of endpoints) log(`  → ${e.label}: ${resolveUrl(e)}`);

  try {
    const result = await runScenario(scenario, endpoints, resolveUrl, samples, running.signal, log);
    renderResult(scenario, endpoints, result, resolveUrl);
    log("✓ done");
  } catch (err) {
    log(`✗ ${err.message}`);
  } finally {
    setRunning(false);
    running = null;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────
function renderResult(scenario, endpoints, result, resolveUrl) {
  const wrap = $("#results");
  const card = el("div", { className: "card" });
  card.append(el("h3", {}, scenario.label));

  // Metric direction, stated up front so the table isn't ambiguous.
  const arrow = result.lowerIsBetter ? "↓" : "↑";
  const dir = result.lowerIsBetter ? "lower is better" : "higher is better";
  card.append(el("p", { className: "metricnote" },
    `Metric: ${result.unit} · ${arrow} ${dir}. `,
    el("span", { className: "muted" }, "Fastest endpoint highlighted.")));

  const rows = endpoints
    .map((e) => ({ e, r: result.byEndpoint.get(e.id) }))
    .filter((x) => x.r);

  // Bars are scaled to the best value so the comparison is visual. For
  // lower-is-better (latency) a shorter bar wins; for MB/s a longer bar wins.
  const warmVals = rows.map((x) => x.r.warm).filter((v) => v != null);
  const maxVal = Math.max(...warmVals, 0.0001);

  const winner = pickWinner(rows, result.lowerIsBetter);

  const table = el("table");
  table.append(
    el("tr", {},
      el("th", {}, "Endpoint"),
      el("th", {}, "Cold"),
      el("th", {}, `Warm (${result.unit}) ${arrow}`),
      el("th", { className: "barcol" }, "Warm — visual"),
      el("th", {}, "x-cache"))
  );
  for (const { e, r } of rows) {
    const barPct = r.warm == null ? 0 : result.lowerIsBetter
      ? (1 - r.warm / (maxVal * 1.05)) * 100 // shorter = faster
      : (r.warm / maxVal) * 100;
    const bar = el("div", { className: "bar" },
      el("span", { style: `width:${Math.max(3, barPct).toFixed(1)}%;background:${e.color}` }));
    const disp = summarizeXCache(r.xCaches);
    table.append(
      el("tr", { className: e.id === winner ? "win" : "" },
        el("td", {},
          el("div", {}, el("span", { className: "dot", style: `background:${e.color}` }), ` ${e.label}`),
          el("a", { className: "rowurl", href: resolveUrl(e), target: "_blank", rel: "noopener",
                    textContent: shortUrl(resolveUrl(e)) })),
        el("td", {}, r.error ? "—" : fmt(r.cold, result.unit)),
        el("td", {}, el("b", {}, r.error ? "FAIL" : fmt(r.warm, result.unit))),
        el("td", { className: "barcol" }, r.error ? el("small", { className: "err" }, r.error) : bar),
        el("td", {}, disp))
    );
  }
  card.append(table);

  // Comparison summary: the edge-cache proxy relative to BOTH the no-cache
  // proxy and direct S3 (whichever are present), warm-vs-warm.
  const prev = rows.find((x) => x.e.id === "preview");
  if (prev?.r.warm && !prev.r.error) {
    const comps = [];
    for (const otherId of ["direct", "staging"]) {
      const o = rows.find((x) => x.e.id === otherId);
      if (!o?.r.warm || o.r.error) continue;
      const s = result.lowerIsBetter ? o.r.warm / prev.r.warm : prev.r.warm / o.r.warm;
      comps.push({ label: o.e.label, s });
    }
    if (comps.length) {
      const box = el("div", { className: "callout" });
      box.append(el("div", { className: "callout-h" }, "Edge cache vs. (warm):"));
      for (const c of comps) {
        box.append(el("div", { className: "callout-row" },
          el("span", {}, c.label),
          el("b", { className: c.s >= 1 ? "good" : "bad" },
            `${c.s.toFixed(1)}× ${c.s >= 1 ? "faster" : "slower"}`)));
      }
      if (comps.some((c) => c.s < 1)) {
        box.append(el("small", { className: "muted" },
          "Slower is expected on throughput / bandwidth-bound reads — the cache adds a re-serve hop."));
      }
      card.append(box);
    }
  }
  wrap.prepend(card);
}

// Trim a URL to host + last path segment for compact table display.
function shortUrl(u) {
  try {
    const { host, pathname } = new URL(u);
    const last = pathname.split("/").filter(Boolean).pop() || "";
    return `${host}/…/${last}`;
  } catch {
    return u;
  }
}

function pickWinner(rows, lowerIsBetter) {
  let best = null, bestV = lowerIsBetter ? Infinity : -Infinity;
  for (const { e, r } of rows) {
    if (r.error || r.warm == null) continue;
    if (lowerIsBetter ? r.warm < bestV : r.warm > bestV) { bestV = r.warm; best = e.id; }
  }
  return best;
}

function summarizeXCache(xs) {
  const seen = xs.filter(Boolean);
  if (!seen.length) return el("small", { className: "muted" }, "—");
  const last = seen[seen.length - 1];
  const cls = last === "HIT" ? "hit" : last === "MISS" ? "miss" : "bypass";
  return el("span", { className: `tag ${cls}` }, seen.join(" → "));
}

// ── Log + state ───────────────────────────────────────────────────────
const log = (m) => { const l = $("#log"); l.append(el("div", {}, m)); l.scrollTop = l.scrollHeight; };
const clearOutput = () => { $("#log").replaceChildren(); };
function setRunning(on) {
  $("#run").textContent = on ? "Stop" : "Run benchmark";
  $("#run").classList.toggle("stop", on);
  for (const id of ["dataset", "scenario", "samples"]) $(`#${id}`).disabled = on;
}

buildControls();
$("#run").addEventListener("click", run);
