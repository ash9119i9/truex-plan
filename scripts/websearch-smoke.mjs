import assert from "node:assert/strict";
import { isIP } from "node:net";

const base = new URL(process.env.WEB_SERVICE_URL || "http://127.0.0.1:4400");
const token = process.env.WEB_SERVICE_TOKEN || "";
assert.ok(
  token.length >= 32,
  "Set WEB_SERVICE_TOKEN to at least 32 characters.",
);
assert.ok(
  ["http:", "https:"].includes(base.protocol),
  "Invalid WEB_SERVICE_URL.",
);
assert.ok(
  !base.username && !base.password,
  "WEB_SERVICE_URL cannot include credentials.",
);
const query =
  process.env.WEB_SEARCH_SMOKE_QUERY || "SearXNG documentation search API";

async function request(path, options = {}) {
  const response = await fetch(
    new URL(path, `${base.href.replace(/\/$/, "")}/`),
    {
      ...options,
      signal: AbortSignal.timeout(25_000),
    },
  );
  assert.ok(response.ok, `${path} returned HTTP ${response.status}.`);
  return response.json();
}

function assertPublicResultUrl(value) {
  const url = new URL(value);
  assert.ok(
    ["http:", "https:"].includes(url.protocol),
    "Unexpected result URL scheme.",
  );
  assert.ok(!url.username && !url.password, "Result URL contains credentials.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  assert.ok(!/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(host));
  assert.ok(
    host.includes(".") || isIP(host),
    "Result URL has a local hostname.",
  );
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    assert.ok(
      !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
      ),
      "Result URL points to a private or reserved IPv4 address.",
    );
  } else if (isIP(host) === 6) {
    assert.ok(
      !/^(::|fc|fd|fe[89ab]|ff)/i.test(host),
      "Result URL points to a private or reserved IPv6 address.",
    );
  }
}

try {
  await request("health");
  await request("ready");
  const result = await request("search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, limit: 5 }),
  });
  assert.equal(result.provider, "searxng");
  assert.equal(result.query, query);
  assert.ok(
    Number.isFinite(Date.parse(result.searchedAt)),
    "Missing search timestamp.",
  );
  assert.ok(
    Array.isArray(result.results) && result.results.length > 0,
    "No live search results returned.",
  );
  assert.ok(
    result.results.length <= 5,
    "Search exceeded the requested result limit.",
  );
  const ids = new Set();
  for (const source of result.results) {
    assertPublicResultUrl(source.url);
    assert.ok(typeof source.sourceId === "string" && source.sourceId);
    assert.ok(!ids.has(source.sourceId), "Duplicate sourceId.");
    ids.add(source.sourceId);
    assert.ok(typeof source.title === "string" && source.title);
    assert.ok(typeof source.snippet === "string");
    assert.ok(Array.isArray(source.engines));
  }
  assert.ok(Array.isArray(result.warnings));
  console.log(
    JSON.stringify(
      {
        provider: result.provider,
        searchedAt: result.searchedAt,
        resultCount: result.results.length,
        sources: result.results.map(({ sourceId, url, title, engines }) => ({
          sourceId,
          url,
          title,
          engines,
        })),
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Do not print request headers, URLs containing configuration credentials or server bodies.
  console.error(
    error instanceof Error
      ? error.message.replaceAll(token, "[redacted]")
      : "WebSearch smoke failed.",
  );
  process.exitCode = 1;
}
