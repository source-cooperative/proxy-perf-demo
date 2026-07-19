// Raw HTTP range-request benchmarks via the Fetch API — no dependencies.
// These measure the endpoints directly and expose the edge cache's effect
// (x-cache disposition, warm-vs-cold latency) the way the underlying data
// libraries actually hit them.

// `cache: "no-store"` bypasses the *browser* HTTP cache so every call hits the
// network — otherwise we'd be timing memory. We must NOT add a cache-busting
// query param: the proxy only chunk-caches requests with an empty query, so a
// `?_=…` would silently disable the very thing we're measuring.
export async function timedFetch(url, { range, signal } = {}) {
  const headers = {};
  if (range) headers["Range"] = range;
  const t0 = performance.now();
  const resp = await fetch(url, { headers, cache: "no-store", signal });
  if (![200, 206].includes(resp.status)) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  let ttfb = null;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb === null) ttfb = performance.now() - t0; // first byte
    bytes += value.length;
  }
  const totalMs = performance.now() - t0;
  return {
    status: resp.status,
    bytes,
    ttfbMs: ttfb ?? totalMs,
    totalMs,
    mbps: totalMs > 0 ? bytes / (totalMs / 1000) / 1e6 : 0,
    xCache: resp.headers.get("x-cache"), // null for direct S3
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The scenarios. Each returns a request plan: a label, the `metric` to chart,
// whether lower is better, and a function that issues one sample against a URL.
// `warm` runs the same request repeatedly so the edge cache fills — sample 0 is
// cold (MISS + populate), the rest are warm.
export const SCENARIOS = {
  ttfb: {
    label: "Warm TTFB — repeated 64 KiB range",
    metric: "ttfbMs",
    unit: "ms",
    lowerIsBetter: true,
    blurb:
      "The per-request latency a windowed read pays 6–10× over. Repeated identical range → the edge cache should turn it into an edge-RTT hit.",
    run: (url, signal) => timedFetch(url, { range: "bytes=0-65535", signal }),
  },
  footer: {
    label: "Parquet footer — suffix range (bytes=-65536)",
    metric: "ttfbMs",
    unit: "ms",
    lowerIsBetter: true,
    blurb:
      "Every reader of a parquet/GeoParquet file reads its footer first. The universally hot region — where cross-client caching pays most.",
    run: (url, signal) => timedFetch(url, { range: "bytes=-65536", signal }),
  },
  throughput: {
    label: "Throughput — 16 MiB range",
    metric: "mbps",
    unit: "MB/s",
    lowerIsBetter: false,
    blurb:
      "Sustained transfer of a large block (a DuckDB column chunk, a bulk read). Bandwidth-bound; the honest weak spot for a caching hop.",
    run: (url, signal) => timedFetch(url, { range: "bytes=0-16777215", signal }),
  },
};

// Run one scenario across all endpoints, interleaved per sample so network
// drift hits every endpoint evenly. `resolveUrl(endpoint)` builds the object
// URL for that endpoint. Returns per-endpoint {cold, warm, xCaches, error}.
// `onProgress(msg)` streams a live log line.
export async function runScenario(scenario, endpoints, resolveUrl, samples, signal, onProgress) {
  const out = new Map(endpoints.map((e) => [e.id, { values: [], xCaches: [], error: null }]));
  for (let i = 0; i < samples; i++) {
    for (const e of endpoints) {
      if (signal.aborted) return finalize(out, scenario);
      const rec = out.get(e.id);
      if (rec.error) continue;
      try {
        const r = await scenario.run(resolveUrl(e), signal);
        rec.values.push(r[scenario.metric]);
        rec.xCaches.push(r.xCache);
        onProgress(
          `${e.label} · #${i + 1}: ${fmt(r[scenario.metric], scenario.unit)}` +
            (r.xCache ? ` · x-cache:${r.xCache}` : "")
        );
      } catch (err) {
        rec.error = err.message;
        onProgress(`${e.label} · #${i + 1}: FAILED (${err.message})`);
      }
    }
  }
  return finalize(out, scenario);
}

function finalize(out, scenario) {
  const result = new Map();
  for (const [id, rec] of out) {
    result.set(id, {
      cold: rec.values[0] ?? null,
      warm: rec.values.length > 1 ? median(rec.values.slice(1)) : (rec.values[0] ?? null),
      xCaches: rec.xCaches,
      error: rec.error,
    });
  }
  return { metric: scenario.metric, unit: scenario.unit, lowerIsBetter: scenario.lowerIsBetter, byEndpoint: result };
}

export const fmt = (v, unit) =>
  v == null ? "—" : unit === "MB/s" ? `${v.toFixed(1)} MB/s` : `${v.toFixed(0)} ms`;
