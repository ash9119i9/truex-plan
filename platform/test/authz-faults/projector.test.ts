import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { harness, operation } from "../authz-integration/harness";
import {
  component,
  compileComponent,
  componentFixture,
} from "../authz-integration/poc-components";
import { pocEngine } from "../authz-integration/poc-engine";
import { policyOperationDigest } from "../../src/policy-state";
import { testEnvironment } from "../environment";
import type { FixturePayload } from "./projector-child";

const execute = promisify(execFile);
test(
  "crashed fixture projector restarts from durable payload; its late grant cannot acknowledge a newer revoke",
  { timeout: 120_000 },
  async (t) => {
    const h = await harness();
    t.after(() => h.stop());
    const engine = await pocEngine("spicedb", true);
    t.after(() => engine.close());
    const s = await h.seed("projector-crash");
    const f = componentFixture();
    await engine.write(f.tuples);
    const stage = async (eventId: string, revoke: boolean) => {
      const c = component(f.tenant, "group", "readers");
      const tuples = compileComponent(
        c,
        revoke ? [] : [{ user: f.user("reader"), relation: "member" }],
      );
      const revision = await h.policy.mutate({
        ...operation(s.context.tenant.id, eventId),
        fence: revoke ? "revoked" : "pending",
        changes: [
          {
            kind: "create",
            entity: {
              tenantId: s.context.tenant.id,
              kind: "group",
              id: eventId,
              generation: "g1",
            },
          },
        ],
      });
      await h.store.catalog
        .collection<FixturePayload>("authorization_poc_payloads")
        .insertOne({
          _id: eventId,
          revision,
          tuples,
          digest: policyOperationDigest(JSON.stringify(tuples)),
        });
      return { c, revision };
    };
    const run = async (eventId: string, crash = false) =>
      execute(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("test/authz-faults/projector-child.ts"),
          eventId,
        ],
        {
          cwd: process.cwd(),
          timeout: 30_000,
          maxBuffer: 100_000,
          env: testEnvironment({
            AUTHZ_FIXTURE_MONGO_URI: h.mongo.getUri(),
            AUTHZ_FIXTURE_CRASH_AFTER_FIRST: crash ? "1" : "0",
          }),
        },
      );
    const old = await stage("grant-old", false);
    await assert.rejects(
      run("grant-old", true),
      (error: any) => error.code === 42,
    );
    assert.equal(
      (await h.policy.states.findOne({ _id: s.context.tenant.id }))?.fence,
      "pending",
    );
    const next = await stage("revoke-next", true);
    const oldResult = await run("grant-old");
    assert.equal(JSON.parse(oldResult.stdout.trim()).published, false);
    assert.equal(
      (await h.policy.states.findOne({ _id: s.context.tenant.id }))?.fence,
      "revoked",
    );
    assert.equal(
      await engine.check(f.user("reader"), "can_read", f.owned.alias, {
        active: { ...f.active, [old.c.alias]: old.c.version },
      }),
      true,
    );
    assert.equal(
      (
        await h.policy.outbox.findOne({
          "revision.namespace": old.revision.namespace,
        })
      )?.state,
      "pending",
    );
    const nextResult = await run("revoke-next");
    assert.equal(JSON.parse(nextResult.stdout.trim()).published, true);
    const state = await h.policy.states.findOne({ _id: s.context.tenant.id });
    assert.equal(state?.active?.namespace, next.revision.namespace);
    assert.equal(state?.fence, null);
    assert.equal(
      await engine.check(f.user("reader"), "can_read", f.owned.alias, {
        active: { ...f.active, [next.c.alias]: next.c.version },
      }),
      false,
    );
  },
);
