# Network and payloads

## Round trips

- Count round trips per user action (client -> API, API -> DB, API -> services).
  On real networks each costs 20-200 ms; loopback hides this completely.
- Collapse chatty sequences: return what the next screen needs in one response,
  or batch endpoints. Avoid client-side N+1 (list then fetch each item).
- Sequential service calls that do not depend on each other: run in parallel.

## Payload size

- Measure response bytes raw and compressed. Large JSON costs serialize time,
  transfer, and client parse.
- Return only needed fields; paginate lists; never return unbounded arrays.
- Compression (gzip/brotli) for text responses above ~1 KB, at the proxy or
  app. JSON often compresses 5-10x. Skip already-compressed content (images,
  zip). Do not compress responses that mix secrets with attacker-controlled
  input over TLS without considering BREACH-style risks.
- Large downloads/uploads: stream end to end with a size limit; do not buffer
  whole files in memory.

## HTTP caching

- `ETag` / `Last-Modified` with `304` responses for cacheable reads.
- `Cache-Control: no-store` on everything authenticated is safe but costly;
  `private, max-age=N` or revalidation is fine for data that tolerates it.
  Decide per endpoint, never cache personalized data as `public`.

## Serialization

- `JSON.stringify` of big objects blocks the event loop; stream or paginate.
- Avoid converting the same data repeatedly (DB doc -> DTO -> JSON -> parse ->
  JSON). Map once.
- Binary protocols (protobuf, msgpack) only after measuring JSON is the
  bottleneck; they add tooling cost.

## Protocol and transport

- Keep-alive and HTTP/2 between proxy and clients; reuse connections to
  upstreams.
- Check TLS termination, proxy buffering (disable for SSE/streaming), and
  request/response size limits at each hop.
- Rate limits and request size limits are also performance protections; set them
  at the edge.
