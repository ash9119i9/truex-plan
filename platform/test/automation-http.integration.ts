import assert from "node:assert/strict";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { startPlatform } from "./harness";
import { insertFixtures } from "./fixtures";
test(
  "authenticated automation HTTP boundaries, native preview and controls, idempotency and ownership",
  { timeout: 120000 },
  async (t) => {
    const environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { type: "cached-download", version: "v1.9.1" } },
    });
    const harness = await startPlatform({
      env: {
        AUTH_MODE: "dev",
        DEV_USER_HEADER: "on",
        DEV_USER_ID: "owner",
        DEV_USER_ROLE: "user",
        AUTOMATIONS_ENABLED: "on",
        TEMPORAL_ADDRESS: environment.connection.options.address,
      },
    });
    t.after(async () => {
      await harness.stop();
      await environment.teardown();
    });
    await insertFixtures(harness.store);
    const request = async (
      path: string,
      method = "GET",
      body?: unknown,
      user = "owner",
    ) => {
      const response = await fetch(harness.base + path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-truex-user": user,
          "x-truex-role": "user",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const recipe = {
      name: "HTTP verification",
      agentId: "assistant",
      prompt: "RESTRICTED_TEST_PROMPT",
      trigger: {
        kind: "interval",
        everyMs: 3600000,
        anchorAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        timeZone: "Asia/Kolkata",
      },
    };
    const preview = await request("/api/automations/preview", "POST", {
      trigger: recipe.trigger,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.times.length, 5);
    const created = await request("/api/automations", "POST", {
      ...recipe,
      ownerId: "spoofed",
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.ownerId, "owner");
    const id = created.data.id;
    assert.equal(
      (
        await request(`/api/automations/${id}/runs`, "POST", {
          requestKey: "same",
          revision: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(`/api/automations/${id}`, "GET", undefined, "other"))
        .status,
      404,
    );
    assert.equal(
      (await request("/api/automations", "GET", undefined, "other")).data.items
        .length,
      0,
    );
    const enabled = await request(`/api/automations/${id}/control`, "POST", {
      version: 1,
      action: "enable",
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.syncState, "synced");
    const run = await request(`/api/automations/${id}/runs`, "POST", {
      requestKey: "same",
      revision: 1,
    });
    assert.equal(run.status, 202);
    assert.equal(
      (
        await request(`/api/automations/${id}/runs`, "POST", {
          requestKey: "same",
          revision: 1,
        })
      ).data.id,
      run.data.id,
    );
    assert.equal(
      (
        await request(
          `/api/automations/${id}/runs/${run.data.id}`,
          "GET",
          undefined,
          "other",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/automations/${id}/control`, "POST", {
          version: 1,
          action: "pause",
        })
      ).status,
      409,
    );
    const pause = await request(`/api/automations/${id}/control`, "POST", {
      version: 2,
      action: "pause",
    });
    assert.equal(pause.data.status, "paused");
    const rows = await request(`/api/automations/${id}/runs?limit=1`);
    assert.equal(rows.data.items.length, 1);
    const csv = await fetch(
      `${harness.base}/api/automations/${id}/export.csv`,
      { headers: { "x-truex-user": "owner" } },
    );
    assert.equal(csv.status, 200);
    assert.equal((await csv.text()).includes("RESTRICTED_TEST_PROMPT"), false);
    assert.equal(
      harness.core.calls.filter((c) => c.path.endsWith("/turns")).length,
      0,
      "No agent work in this HTTP test",
    );
  },
);
