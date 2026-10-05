import { test } from "node:test";
import assert from "node:assert/strict";
import { Redactor } from "../src/redact";

test("flags under sensitive-looking keys survive; values that can hold secrets do not", () => {
  const redactor = new Redactor();
  redactor.remember({ experimental_bearer_token: "sk-live-123456" });
  const cleaned = redactor.clean({
    questions: [{ id: "q", isSecret: false, isOther: false }],
    tokenCount: 42,
    secret: null,
    api_key: "plain-value",
    authorization: { scheme: "Bearer", value: "abc" },
    http_headers: ["x"],
    note: "uses sk-live-123456 here",
  });
  assert.deepEqual(cleaned.questions, [
    { id: "q", isSecret: false, isOther: false },
  ]);
  assert.equal(cleaned.tokenCount, 42);
  assert.equal(cleaned.secret, null);
  assert.equal(cleaned.api_key, "[REDACTED]");
  assert.equal(cleaned.authorization, "[REDACTED]");
  assert.equal(cleaned.http_headers, "[REDACTED]");
  assert.equal(cleaned.note, "uses [REDACTED] here");
  assert.equal(redactor.clean({ isSecret: true }).isSecret, true);
});

test("MCP credentials: apiKeyEnc and decrypted http_headers values never reach traces or logs", () => {
  const redactor = new Redactor();
  // The thread config the platform sends at session build, keys decrypted.
  redactor.remember({
    config: {
      "mcp_servers.qlik": {
        url: "https://mcp.example/mcp",
        http_headers: { "x-api-qlik-key": "qlik-decrypted-key" },
      },
      "mcp_servers.btp": {
        url: "https://btp.example/mcp",
        http_headers: { Authorization: "Bearer btp-decrypted-token" },
      },
    },
  });
  const apiKeyEnc = {
    v: 1,
    kid: "k1",
    iv: "aXYtdmFsdWUtMTI=",
    tag: "dGFnLXZhbHVlLTE2Ynl0ZXM=",
    data: "Y2lwaGVydGV4dC1kYXRh",
  };
  const cleaned = redactor.clean({
    profile: { name: "qlik", apiKeyEnc, hasKey: true },
    server: {
      url: "https://mcp.example/mcp",
      http_headers: { "x-api-qlik-key": "qlik-decrypted-key" },
    },
    log: "connecting with qlik-decrypted-key and Bearer btp-decrypted-token",
    trace: [{ detail: "header x-api-qlik-key: qlik-decrypted-key" }],
  });
  // The whole encrypted record is masked, not just fields inside it.
  assert.equal(cleaned.profile.apiKeyEnc, "[REDACTED]");
  assert.equal(cleaned.profile.hasKey, true);
  assert.equal(cleaned.server.http_headers, "[REDACTED]");
  assert.equal(cleaned.server.url, "https://mcp.example/mcp");
  const text = JSON.stringify(cleaned);
  assert.doesNotMatch(
    text,
    /qlik-decrypted-key|btp-decrypted-token|Y2lwaGVydGV4dC1kYXRh/,
  );
  // The whole remembered header value is masked, scheme included.
  assert.equal(cleaned.log, "connecting with [REDACTED] and [REDACTED]");
});

test("whole-message matches choose the longest credential regardless of registration order", () => {
  for (const values of [
    ["credential", "credential-longer"],
    ["credential-longer", "credential"],
  ]) {
    const redactor = new Redactor();
    redactor.remember({ env: Object.fromEntries(values.map((v) => [v, v])) });
    assert.equal(
      redactor.clean("credential-longer credential"),
      "[REDACTED] [REDACTED]",
    );
  }
});

test("overlapping matches preserve the leftmost-longest complete-message semantics", () => {
  const redactor = new Redactor();
  redactor.remember({
    env: { first: "abcde", second: "abcdef", third: "defghi" },
  });
  for (const text of ["abcdef", "abcdefghi", "abcdeabcde", "abcdefdefghi"]) {
    for (let split = 0; split <= text.length; split++) {
      const stream = redactor.createStream();
      assert.equal(
        stream.push(text.slice(0, split)) +
          stream.push(text.slice(split)) +
          stream.finish(),
        redactor.clean(text),
      );
    }
  }
  assert.equal(redactor.clean("abcdefghi"), "[REDACTED]ghi");
});

test("stream redaction equals complete-message redaction at every split point", () => {
  const redactor = new Redactor();
  redactor.remember({
    env: {
      first: "shared-key",
      second: "shared-key-longer",
      third: "🔐秘密credential",
    },
  });
  const text =
    "Hello 😀 shared-key-longer; shared-key and 🔐秘密credential done.";
  for (let split = 0; split <= text.length; split++) {
    const stream = redactor.createStream();
    const actual =
      stream.push(text.slice(0, split)) +
      stream.push(text.slice(split)) +
      stream.finish();
    assert.equal(actual, redactor.clean(text), `split ${split}`);
    assert.equal(stream.bufferedLength, 0);
  }
  const stream = redactor.createStream();
  assert.equal(
    text
      .split("")
      .map((c) => stream.push(c))
      .join("") + stream.finish(),
    redactor.clean(text),
  );
});

test("a credential prefix is retained and masked on error or interrupt closure", () => {
  const redactor = new Redactor();
  const secret = "sk-live-123456";
  redactor.remember({ api_key: secret });
  for (let length = 1; length <= secret.length; length++) {
    const stream = redactor.createStream();
    const first = stream.push("answer: " + secret.slice(0, length));
    assert.equal(first + stream.abort(), "answer: [REDACTED]");
    assert.equal(stream.abort(), "", "closure is idempotent");
    assert.equal(stream.bufferedLength, 0);
  }
});

test("a prefix mismatch releases ordinary text without modifying Unicode or public identity", () => {
  const redactor = new Redactor();
  redactor.remember({ apiKey: "secret-value" });
  const stream = redactor.createStream();
  assert.equal(stream.push("se"), "");
  assert.equal(
    stream.push("lect GPT-6.1 from OpenAI; 中文 😀 /repo/src/app.ts") +
      stream.finish(),
    "select GPT-6.1 from OpenAI; 中文 😀 /repo/src/app.ts",
  );
  assert.equal(stream.finish(), "");
});

test("successful closure preserves ordinary suffixes matching a credential prefix", () => {
  const redactor = new Redactor();
  redactor.remember({
    apiKey: "secret-value",
    password: "secret-value-longer",
  });
  for (const text of [
    "s",
    "sec",
    "secret-value",
    "secret-value-lon",
    "app.ts",
  ]) {
    const stream = redactor.createStream();
    assert.equal(stream.push(text) + stream.finish(), redactor.clean(text));
  }
});

test("independent streams do not combine fragments; cleared streams retain no stale prefix", () => {
  const redactor = new Redactor();
  redactor.remember({ apiKey: "abcdefghi" });
  const first = redactor.createStream();
  const second = redactor.createStream();
  assert.equal(first.push("abc"), "");
  assert.equal(second.push("defghi"), "defghi");
  assert.equal(first.push("defghi"), "[REDACTED]");
  assert.equal(first.finish(), "");
  assert.equal(second.finish(), "");
  assert.equal(first.push("abc"), "");
  first.clear();
  assert.equal(first.bufferedLength, 0);
  assert.equal(first.push("hello"), "hello");
});

test("existing streams use credentials remembered before subsequent deltas", () => {
  const redactor = new Redactor();
  const stream = redactor.createStream();
  redactor.remember({ password: "new-credential" });
  assert.equal(stream.push("new-"), "");
  assert.equal(stream.push("credential"), "[REDACTED]");
  assert.equal(stream.finish(), "");
});

test("Authorization credentials are protected with or without the scheme at every split", () => {
  const redactor = new Redactor();
  redactor.remember({
    http_headers: {
      Authorization: "Bearer private-token",
      other: "Basic encoded-private-value",
    },
  });
  const text = "Bearer private-token; private-token; encoded-private-value.";
  assert.equal(redactor.clean(text), "[REDACTED]; [REDACTED]; [REDACTED].");
  for (let split = 0; split <= text.length; split++) {
    const stream = redactor.createStream();
    assert.equal(
      stream.push(text.slice(0, split)) +
        stream.push(text.slice(split)) +
        stream.finish(),
      redactor.clean(text),
    );
  }
});

test("repetitive input keeps only a bounded suffix and matches the reference output", () => {
  const redactor = new Redactor();
  const secret = "a".repeat(4096) + "b";
  redactor.remember({ apiKey: secret });
  const stream = redactor.createStream();
  const first = stream.push("a".repeat(100_000));
  assert.equal(stream.bufferedLength, secret.length - 1);
  const second = stream.push("b end");
  assert.equal(
    first + second + stream.finish(),
    "a".repeat(100_000 - 4096) + "[REDACTED] end",
  );
});

test("deterministic fragmented inputs agree with an independent literal-match reference", () => {
  let seed = 123456;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const word = (length: number) =>
    Array.from({ length }, () => "abc"[random(3)]).join("");
  for (let iteration = 0; iteration < 200; iteration++) {
    const secrets = Array.from(
      new Set(Array.from({ length: 4 }, () => word(5 + random(8)))),
    );
    const redactor = new Redactor();
    redactor.remember({
      env: Object.fromEntries(secrets.map((secret) => [secret, secret])),
    });
    const text =
      word(20) +
      secrets[random(secrets.length)] +
      word(20) +
      secrets[random(secrets.length)] +
      word(20);
    const reference = text.replace(
      new RegExp(secrets.sort((a, b) => b.length - a.length).join("|"), "g"),
      "[REDACTED]",
    );
    const stream = redactor.createStream();
    let actual = "";
    for (let cursor = 0; cursor < text.length;) {
      const size = 1 + random(10);
      actual += stream.push(text.slice(cursor, cursor + size));
      cursor += size;
      assert.ok(
        stream.bufferedLength <
          Math.max(...secrets.map((secret) => secret.length)),
      );
    }
    actual += stream.finish();
    assert.equal(actual, reference, `iteration ${iteration}`);
    assert.equal(redactor.clean(text), reference);
  }
});

test("normal streaming holds no text; retained text is bounded by longest known secret", () => {
  const redactor = new Redactor();
  const secret = "sk-" + "x".repeat(128);
  redactor.remember({ apiKey: secret });
  const stream = redactor.createStream();
  const chunk = "A normal answer with no credentials. 😀\n".repeat(100);
  for (let index = 0; index < 250; index++) {
    assert.equal(stream.push(chunk), chunk);
    assert.equal(stream.bufferedLength, 0);
  }
  for (const char of secret) {
    stream.push(char);
    assert.ok(stream.bufferedLength < secret.length);
  }
  assert.equal(stream.finish(), "");
});

test("unknown credentials are masked by sensitive object fields, without guessing at arbitrary chat text", () => {
  const redactor = new Redactor();
  assert.deepEqual(
    redactor.clean({
      api_key: "unknown-key",
      model: "GPT-6.1",
      provider: "OpenAI",
    }),
    {
      api_key: "[REDACTED]",
      model: "GPT-6.1",
      provider: "OpenAI",
    },
  );
  // The streaming filter guarantees exact remembered values, not arbitrary
  // credentials or private information that is not in the secret registry.
  const stream = redactor.createStream();
  assert.equal(
    stream.push("sk-unknown-example from a user's code"),
    "sk-unknown-example from a user's code",
  );
  assert.equal(stream.finish(), "");
});
