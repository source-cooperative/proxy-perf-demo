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
const CDN = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/dist`;

let dbPromise = null;

async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const duckdb = await import(`${CDN}/duckdb-browser.mjs`);
    const bundle = {
      mainModule: `${CDN}/duckdb-eh.wasm`,
      mainWorker: `${CDN}/duckdb-browser-eh.worker.js`,
    };
    // The worker must be same-origin; wrap the CDN worker in a Blob URL.
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule);
    URL.revokeObjectURL(workerUrl);
    await (await db.connect()).query("INSTALL httpfs; LOAD httpfs;").catch(() => {});
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
