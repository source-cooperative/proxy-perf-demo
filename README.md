# Source Cooperative — edge-cache speed demo

An in-browser A/B that reads the **same object** three ways and shows the
difference per access pattern:

| Endpoint | What it is |
|----------|------------|
| **Direct S3** | `s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/…` — the raw bucket, no proxy |
| **Proxy (no cache)** | `data.staging.source.coop` — the current proxy (baseline) |
| **Proxy + edge cache** | `source-data-proxy-pr-189.source-coop.workers.dev` — the [PR #189](https://github.com/source-cooperative/data.source.coop/pull/189) chunk-aligned edge cache |

Everything runs client-side — no server, no build step — so it deploys to
GitHub Pages as static files. All three endpoints send
`Access-Control-Allow-Origin: *`, and the object key is identical across them,
so the browser reads them directly and cross-origin.

## Two views

- **Range benchmarks** (`index.html`) — controlled low-level measurement of the raw range-read
  patterns, showing `x-cache` disposition and warm-vs-cold.
- **Query workbench** (`workflow.html`) — a realistic analyst workflow: run the same DuckDB-WASM
  SQL against the remote Parquet through each endpoint and compare query time. Presets exercise
  different partial-read shapes (footer-only count, first-row-group peek, single-column bbox scan);
  the SQL is editable. The result is identical across endpoints — only latency differs.

## Access patterns

- **Raw HTTP range** (Fetch API, no deps):
  - *Warm TTFB* — a repeated 64 KiB range: the per-request latency a windowed
    read pays over and over. Repeated → the edge cache turns it into an edge-RTT hit.
  - *Parquet footer* — a suffix range (`bytes=-64KiB`): the universally hot
    region every reader of a file hits first.
  - *Throughput* — a 16 MiB range: sustained bulk transfer (bandwidth-bound).
- **Real tool — DuckDB-WASM**:
  - `COUNT(*)` over remote Parquet: DuckDB reads only the footer via range
    requests — a real query hitting the hot region on each endpoint.

Each request uses `cache: no-store` so the **browser** cache never hides the
network; the edge cache still fills because the URL is left clean (the proxy
only chunk-caches empty-query requests, so no cache-buster is added). Cold =
first request; warm = median of the rest. Requests are interleaved across
endpoints so network drift hits them evenly.

> Absolute milliseconds are network-dependent — judge the **ratios** and the
> `x-cache` disposition (`HIT` / `MISS` / `BYPASS`), not the raw numbers.

## Run locally

Any static file server (ES modules need `http://`, not `file://`):

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` publishes the repo root on every push to `main`.
One-time: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Then the site is at `https://<org>.github.io/proxy-perf-demo/`.

## Adding datasets

Edit `src/config.js`. Presets point at the VIDA open-buildings GeoParquet
(partitioned by country), but any object in the `us-west-2.opendata.source.coop`
bucket works — the same `path` is appended to all three endpoint bases.
