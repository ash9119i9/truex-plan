import assert from "node:assert/strict";

const base = new URL(process.env.WEB_SERVICE_URL || "http://127.0.0.1:4400");
const token = process.env.WEB_SERVICE_TOKEN || "";
assert.ok(
  /^[A-Za-z0-9_-]{32,256}$/.test(token),
  "Configure WEB_SERVICE_TOKEN.",
);
assert.ok(
  ["http:", "https:"].includes(base.protocol) &&
    !base.username &&
    !base.password,
);

async function request(path, input) {
  const response = await fetch(new URL(path, base), {
    ...(input
      ? {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        }
      : {}),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.ok(
    response.ok,
    `${path} returned HTTP ${response.status} (${result.code || "unknown"}).`,
  );
  return result;
}

try {
  await request("/read/ready");
  const cases = process.env.WEB_READ_SMOKE_URL
    ? [{ url: process.env.WEB_READ_SMOKE_URL }]
    : [
        { url: "https://example.com/", includes: "documentation examples" },
        { url: "https://quotes.toscrape.com/js/", includes: "Albert Einstein" },
      ];
  for (const check of cases) {
    const result = await request("/read", { url: check.url, maxChars: 5000 });
    assert.equal(result.provider, "crawl4ai");
    assert.equal(result.requestedUrl, new URL(check.url).href);
    assert.ok(result.statusCode >= 200 && result.statusCode < 300);
    assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
    assert.ok(result.markdown.trim() && result.markdown.length <= 5000);
    assert.ok(
      Number.isInteger(result.totalChars) &&
        result.totalChars >= result.markdown.length,
    );
    assert.equal(result.truncated, result.totalChars > result.markdown.length);
    assert.ok(Array.isArray(result.warnings));
    if (check.includes)
      assert.ok(
        result.markdown.includes(check.includes),
        "Expected page text was not rendered/extracted.",
      );
    console.log(
      JSON.stringify({
        provider: result.provider,
        url: result.url,
        title: result.title,
        retrievedAt: result.retrievedAt,
        statusCode: result.statusCode,
        returnedChars: result.markdown.length,
        totalChars: result.totalChars,
        truncated: result.truncated,
        warnings: result.warnings,
      }),
    );
  }
  // Validate the actual API policy rather than relying on a syntactic URL guard.
  const denied = await fetch(new URL("/read", base), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: "http://127.0.0.1/" }),
    signal: AbortSignal.timeout(10_000),
  });
  const failure = await denied.json();
  assert.equal(denied.status, 403);
  assert.equal(failure.code, "READ_BLOCKED");
  console.log("Private target rejected by the live reader.");
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replaceAll(token, "[redacted]")
      : "WebRead smoke failed.",
  );
  process.exitCode = 1;
}
