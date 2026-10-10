import assert from "node:assert/strict";
import test from "node:test";
import { prepareMcpRoutingV2 } from "../src/mcp-routing-v2";

const options = {
  scope: { tenantId: "t1", userId: "u1" },
  authorize: () => true,
};
test("V2 direct mode preserves existing configs without connecting or exposing a gateway", async () => {
  const configs = {
    qlik: {
      url: "http://127.0.0.1:1/mcp",
      http_headers: { "x-test-key": "CANARY" },
    },
  };
  const prepared = await prepareMcpRoutingV2(configs, {
    ...options,
    mode: "direct",
  });
  assert.deepEqual(prepared.mcpServers, configs);
  assert.notEqual(prepared.mcpServers, configs);
  assert.equal(prepared.instructions, "");
  assert.equal(prepared.session, undefined);
  prepared.close();
});
test("V2 mode factory keeps Omni available and creates adaptive only on opt-in", async () => {
  const previous = process.env.TRUEX_MCP_GATEWAY_MODE;
  process.env.TRUEX_MCP_GATEWAY_MODE = "direct";
  try {
    const omni = await prepareMcpRoutingV2(
      {},
      { ...options, mode: "omni", requireProjection: true },
    );
    try {
      assert.ok(omni.mcpServers.omni);
      assert.equal(omni.session, undefined);
    } finally {
      omni.close();
    }
    const adaptive = await prepareMcpRoutingV2(
      {},
      { ...options, mode: "adaptive" },
    );
    try {
      assert.ok(adaptive.mcpServers.adaptive);
      assert.ok(adaptive.session);
      // Discovery fallback exposes no business tools; instructions must still name the path.
      assert.match(adaptive.instructions, /discover_tools/);
      assert.doesNotMatch(adaptive.instructions, /already selected/);
    } finally {
      adaptive.close();
    }
  } finally {
    if (previous === undefined) delete process.env.TRUEX_MCP_GATEWAY_MODE;
    else process.env.TRUEX_MCP_GATEWAY_MODE = previous;
  }
});
test("V2 prepared gateways refuse an accidental second Omni wrapper", async () => {
  const previous = process.env.TRUEX_MCP_GATEWAY_MODE;
  process.env.TRUEX_MCP_GATEWAY_MODE = "omni";
  try {
    await assert.rejects(
      prepareMcpRoutingV2({}, { ...options, mode: "adaptive" }),
      /prepared profiles/,
    );
  } finally {
    if (previous === undefined) delete process.env.TRUEX_MCP_GATEWAY_MODE;
    else process.env.TRUEX_MCP_GATEWAY_MODE = previous;
  }
});
