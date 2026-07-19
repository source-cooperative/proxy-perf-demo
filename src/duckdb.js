// DuckDB-WASM: run real analytical queries against remote Parquet over HTTP
// range requests (footer/metadata, then only the column chunks a query needs).
//
// IMPORTANT — fair measurement: DuckDB keeps an in-memory cache of remote file
// metadata/buffers keyed by URL, for the life of the instance. If you reuse one
// instance, a repeated query is served from DuckDB's memory (single-digit ms) —
// that measures DuckDB, not the endpoint. So the workbench spins up a FRESH
// instance per endpoint (`newDb`) and measures a cold query each time. The
// module itself (and the wasm binary, once the browser caches it) is loaded
// lazily from jsDelivr and shared; only the DuckDB *instance* is fresh.

const DUCKDB_VERSION = "1.29.0";

let modPromise = null;

// Import via jsDelivr's `/+esm` bundle, which rewrites the module's bare
// `apache-arrow` import into a resolvable URL (a plain dist/.mjs import fails in
// the browser with "Failed to resolve module specifier apache-arrow").
function loadModule() {
  if (!modPromise) {
    modPromise = import(
      `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`
    );
  }
  return modPromise;
}

// Create a fresh, isolated DuckDB instance with an empty cache. Returns the db
// plus a `close()` that tears down the worker. Instantiation (fetching the wasm)
// is NOT part of any query timing — callers time `conn.query` only.
export async function newDb() {
  const duckdb = await loadModule();
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // The worker URL is cross-origin (jsDelivr); a classic Worker() can't load it
  // directly, but importScripts can — wrap it in a same-origin Blob.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  return {
    db,
    close: async () => {
      try { await db.terminate(); } catch { /* ignore */ }
      try { worker.terminate(); } catch { /* ignore */ }
    },
  };
}

// Run SQL against a given instance; time only the query. Returns timing +
// up to 50 result rows for display. BigInts → Number, nested structs → JSON.
export async function runSqlOn(db, sqlText, signal) {
  const conn = await db.connect();
  try {
    const t0 = performance.now();
    const table = await conn.query(sqlText);
    const ms = performance.now() - t0;
    if (signal?.aborted) throw new Error("aborted");
    const columns = table.schema.fields.map((f) => f.name);
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
