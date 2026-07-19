// DuckDB-WASM scenario: a real analytical access pattern. DuckDB reads remote
// Parquet over HTTP *range requests* — footer/metadata first, then only the
// column chunks a query needs — which is exactly the workload the chunk cache
// targets. We run queries against each endpoint's URL and time them.
//
// Loaded lazily from jsDelivr the first time this scenario runs (a few MB of
// wasm), so the raw-range benchmarks stay dependency-free and instant. Uses the
// "eh" (exception-handling, single-threaded) bundle so it works on GitHub Pages
// without cross-origin isolation (COOP/COEP headers we can't set there).

const DUCKDB_VERSION = "1.29.0";

let dbPromise = null;

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    // Import via jsDelivr's `/+esm` bundle, which rewrites the module's bare
    // `apache-arrow` import into a resolvable URL. A plain `dist/duckdb-browser.mjs`
    // import fails in the browser ("Failed to resolve module specifier apache-arrow").
    const duckdb = await import(
      `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`
    );
    // Let duckdb pick the wasm + worker bundle for this browser (eh vs mvp); the
    // URLs point at the matching version's dist.
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    // The worker URL is cross-origin (jsDelivr) — a classic `Worker()` can't load
    // it directly, but `importScripts` can, so wrap it in a same-origin Blob.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    // httpfs is compiled into duckdb-wasm — remote `read_parquet('https://…')`
    // works out of the box via HTTP range requests.
    return db;
  })();
  return dbPromise;
}

// `count` is pure footer/metadata: row-group counts live in the Parquet footer,
// so DuckDB fetches only the last few KB — the universally hot read every client
// of a file makes, and the best case for cross-client edge caching.
export const DUCKDB_QUERIES = {
  count: {
    label: "DuckDB · COUNT(*) — footer/metadata read",
    blurb:
      "Row counts live in the Parquet footer, so DuckDB fetches only the last few KB — the hot region every reader hits first. Best case for cross-client edge caching.",
    sql: (u) => `SELECT count(*) AS n FROM read_parquet('${u}')`,
  },
};

// Time one query against one URL. Returns {ttfbMs: ms, mbps: null} shaped like a
// bench result so the same aggregation/rendering applies. We report wall-clock
// query time in the `ttfbMs` slot (it's a latency, lower-is-better).
export async function runQuery(sql, url, signal) {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const t0 = performance.now();
    const res = await conn.query(sql(url));
    const ms = performance.now() - t0;
    if (signal?.aborted) throw new Error("aborted");
    const rows = Number(res.get(0)?.n ?? 0);
    return { status: 200, ttfbMs: ms, totalMs: ms, mbps: 0, bytes: 0, xCache: null, rows };
  } finally {
    await conn.close();
  }
}

// Run arbitrary SQL and return timing + up to 50 result rows for display.
// Used by the query-workbench view. BigInts (e.g. count) are coerced to Number
// so they render/JSON-serialize cleanly.
export async function runSql(sqlText, signal) {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const t0 = performance.now();
    const table = await conn.query(sqlText);
    const ms = performance.now() - t0;
    if (signal?.aborted) throw new Error("aborted");
    const columns = table.schema.fields.map((f) => f.name);
    // Read each cell by column name off the Arrow row proxy (robust across
    // arrow versions); coerce BigInt→Number and nested structs→JSON for display.
    const rows = table.toArray().slice(0, 50).map((r) => {
      const o = {};
      for (const c of columns) {
        let v = r[c];
        if (typeof v === "bigint") v = Number(v);
        else if (v != null && typeof v === "object") v = JSON.stringify(v);
        o[c] = v;
      }
      return o;
    });
    return { ms, columns, rows, numRows: table.numRows };
  } finally {
    await conn.close();
  }
}

// A DuckDB "scenario" adapts a query into the same shape bench.runScenario uses,
// so orchestration/rendering is shared. Query time is the metric.
export function duckdbScenario(queryKey) {
  const q = DUCKDB_QUERIES[queryKey];
  return {
    label: q.label,
    blurb: q.blurb,
    metric: "ttfbMs",
    unit: "ms",
    lowerIsBetter: true,
    run: (url, signal) => runQuery(q.sql, url, signal),
  };
}
