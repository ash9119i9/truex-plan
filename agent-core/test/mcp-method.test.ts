import assert from "node:assert/strict";
import test from "node:test";
import { mcpMethod } from "../src/mcp-method";
import { routingModeV2 } from "../src/adaptive-model-boundary-v2";

test("MCP_METHOD selects exactly three methods and defaults to direct", () => {
  assert.equal(mcpMethod({}), "direct");
  for (const method of ["direct", "omni", "adaptive_v2"] as const)
    assert.equal(
      mcpMethod({
        MCP_METHOD: method,
        TRUEX_MCP_GATEWAY_MODE: "omni",
        MCP_ROUTING_MODE: "adaptive",
      }),
      method,
    );
  for (const value of ["", "adaptive", "DIRECT", "typo", " direct "])
    assert.throws(() => mcpMethod({ MCP_METHOD: value }), /MCP_METHOD must be/);
  assert.equal(mcpMethod({ TRUEX_MCP_GATEWAY_MODE: "omni" }), "omni");
  assert.equal(mcpMethod({ MCP_ROUTING_MODE: "adaptive" }), "adaptive_v2");
});

test("the routing entry point reads MCP_METHOD without changing explicit internal modes", () => {
  const previous = process.env.MCP_METHOD;
  try {
    process.env.MCP_METHOD = "adaptive_v2";
    assert.equal(routingModeV2(), "adaptive");
    assert.equal(routingModeV2("direct"), "direct");
    process.env.MCP_METHOD = "omni";
    assert.equal(routingModeV2(), "omni");
    process.env.MCP_METHOD = "invalid";
    assert.throws(() => routingModeV2(), /MCP_METHOD/);
  } finally {
    if (previous === undefined) delete process.env.MCP_METHOD;
    else process.env.MCP_METHOD = previous;
  }
});
