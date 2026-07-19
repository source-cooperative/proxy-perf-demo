// Endpoints under comparison. All three serve the SAME object key
// (`/{account}/{product}/{path}`), so a dataset's `path` is appended to each
// base URL unchanged.
//
//   staging  – the current proxy on main (no chunk cache) — the baseline
//   preview  – PR #189 preview (chunk-aligned edge cache) — the thing we're demoing
//   direct   – the raw S3 bucket, no proxy at all — the floor/ceiling reference
//
// `us-west-2.opendata.source.coop` is an S3 *bucket name*, not a host, so the
// direct endpoint uses the path-style S3 REST endpoint. All three send
// `Access-Control-Allow-Origin: *`, so the browser can read them cross-origin.
export const ENDPOINTS = [
  {
    id: "direct",
    label: "Direct S3",
    base: "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop",
    color: "#8892b0",
    note: "raw bucket, no proxy",
  },
  {
    id: "staging",
    label: "Proxy (no cache)",
    base: "https://data.staging.source.coop",
    color: "#e0a458",
    note: "current proxy — baseline",
  },
  {
    id: "preview",
    label: "Proxy + edge cache",
    base: "https://source-data-proxy-pr-189.source-coop.workers.dev",
    color: "#43aa8b",
    note: "PR #189 chunk cache",
  },
];

// Presets live in the VIDA Google/Microsoft/OSM open-buildings GeoParquet,
// partitioned by country — same product, wildly different sizes, so you can see
// how each access pattern scales. Point `custom` at any object in the bucket.
const VIDA = "vida/google-microsoft-osm-open-buildings/geoparquet/by_country";
export const DATASETS = [
  { id: "vut", label: "Vanuatu buildings — 17 MB", path: `${VIDA}/country_iso=VUT/VUT.parquet`, kind: "parquet" },
  { id: "lux", label: "Luxembourg buildings — 26 MB", path: `${VIDA}/country_iso=LUX/LUX.parquet`, kind: "parquet" },
  { id: "arm", label: "Armenia buildings — 133 MB", path: `${VIDA}/country_iso=ARM/ARM.parquet`, kind: "parquet" },
  { id: "npl", label: "Nepal buildings — 1.77 GB", path: `${VIDA}/country_iso=NPL/NPL.parquet`, kind: "parquet" },
];

export const url = (endpoint, path) => `${endpoint.base}/${path.replace(/^\/+/, "")}`;
