import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { skillRoot } from "../../src/runtime/skills";
import { Harness, completed } from "../support/harness";
import type { Behavior } from "../support/model-fixture";
import { archiveOf, sampleSkill, sha256 } from "../support/skill-archive";

// Skills on the real pinned Codex: the platform pushes an archive, the run
// names it, Codex offers its `skills` tools and the model reads the skill.
// With coding on, the skill's scripts run inside the sandbox.

const PO = sampleSkill(
  "po-check",
  "Check SAP purchase orders for approval issues.",
);
const PO_SHA = sha256(PO);
const GL = sampleSkill("gl-close", "Month-end general ledger close checklist.");
const GL_SHA = sha256(GL);

function putSkill(
  h: Harness,
  archive: Buffer,
  digest = sha256(archive),
  chatId = "chat1",
  type = "application/gzip",
) {
  return h.fetch(`/v1/chats/${chatId}/skills/${digest}?tenantId=tenant1`, {
    method: "PUT",
    headers: { "content-type": type },
    body: new Uint8Array(archive),
  });
}

const read = (args: Record<string, unknown>): Behavior => ({
  kind: "call",
  name: "read",
  namespace: "skills",
  args,
});

function toolOutputs(h: Harness): string {
  const input = h.model.lastRequest().body.input as Array<
    Record<string, unknown>
  >;
  return JSON.stringify(
    input.filter((item) => item.type === "function_call_output"),
  );
}

// The package locator the catalog gives the model for a skill, such as
// "e0/po-check".
function locator(body: Record<string, unknown>, slug: string): string {
  const match = new RegExp(`executor package: (e\\d+/${slug})\\)`).exec(
    JSON.stringify(body.input),
  );
  assert.ok(match, `the catalog lists ${slug}`);
  return match[1]!;
}

describe("skills (real Codex)", () => {
  const h = new Harness();
  before(() => h.start());
  after(() => h.close());

  const skills = [
    { sha256: PO_SHA, slug: "po-check" },
    { sha256: GL_SHA, slug: "gl-close" },
  ];
  let threadId = "";

  test("a run naming skills this runtime lacks is SKILLS_MISSING, before any process starts", async () => {
    const res = await h.post("/v1/runs", h.body({ skills }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as {
      error: { code: string; details: { missing: string[] } };
    };
    assert.equal(body.error.code, "SKILLS_MISSING");
    assert.deepEqual(body.error.details.missing, [PO_SHA, GL_SHA]);
    assert.equal(h.manager.stats.processes, 0);
  });

  test("the skills route checks type, digest and content, works with coding off, and repeats as a no-op", async () => {
    assert.equal(h.manager.codingEnabled, false);
    const wrongType = await putSkill(
      h,
      PO,
      PO_SHA,
      "chat1",
      "application/json",
    );
    assert.equal(wrongType.status, 400);
    const tampered = await putSkill(h, PO, GL_SHA);
    assert.equal(tampered.status, 400);
    const badChat = await putSkill(h, PO, PO_SHA, "../x");
    assert.equal(badChat.status, 400);
    const unauthorized = await h.fetch(
      `/v1/chats/chat1/skills/${PO_SHA}?tenantId=tenant1`,
      {
        method: "PUT",
        headers: { "content-type": "application/gzip", authorization: "x" },
        body: new Uint8Array(PO),
      },
    );
    assert.equal(unauthorized.status, 401);
    assert.ok(!existsSync(skillRoot(h.stateDir, PO_SHA)));

    const first = await putSkill(h, PO);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { slug: "po-check", created: true });
    const again = await putSkill(h, PO);
    assert.deepEqual(await again.json(), { slug: "po-check", created: false });
    assert.equal((await putSkill(h, GL)).status, 200);
    // Stored outside every chat's workspace.
    assert.ok(existsSync(join(skillRoot(h.stateDir, PO_SHA), "po-check")));
    assert.ok(!existsSync(join(h.stateDir, "t", "tenant1", "c", "chat1")));
  });

  test("the model is offered the skills tools and a catalog of both skills", async () => {
    const events = await h.run(h.body({ skills }));
    assert.equal(completed(events).status, "completed");
    threadId = String(events[0]!.data.threadId);
    // Listed in the catalog but never opened: no skill was used.
    assert.ok(!events.some((event) => event.type === "skill.used"));
    const body = h.model.lastRequest().body;
    const tools = (body.tools ?? []) as Array<Record<string, unknown>>;
    const namespace = tools.find((tool) => tool.name === "skills");
    assert.ok(namespace, JSON.stringify(tools.map((t) => t.name)));
    assert.deepEqual(
      ((namespace.tools ?? []) as Array<{ name: string }>)
        .map((t) => t.name)
        .sort(),
      ["list", "read"],
    );
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["skills", "update_plan"],
      "no other tool is offered",
    );
    const text = JSON.stringify(body);
    assert.ok(text.includes("Check SAP purchase orders for approval issues."));
    assert.ok(text.includes("Month-end general ledger close checklist."));
    // Bodies are read on demand, never put in the prompt.
    assert.ok(!text.includes("BODY-po-check"));
    // The skill path names no tenant or chat.
    assert.ok(!text.includes("tenant1"), "no tenant ID reaches the model");
    assert.ok(!text.includes("/c/chat1"), "no chat path reaches the model");
  });

  test("skills.read returns SKILL.md and a reference file", async () => {
    const pkg = locator(h.model.lastRequest().body, "po-check");
    h.model.script.push(read({ package: pkg }), { kind: "reply", text: "ok" });
    let events = await h.run(h.body({ threadId, skills }));
    assert.equal(completed(events).status, "completed");
    // The read is reported once, by the slug the platform sent, before the
    // reply, and kept in the run's items. Nothing else of the call shows.
    const used = events.filter((event) => event.type === "skill.used");
    assert.deepEqual(
      used.map((event) => event.data),
      [{ slug: "po-check" }],
    );
    assert.deepEqual(
      (completed(events).items as Array<{ type: string }>).find(
        (item) => item.type === "skill",
      ),
      { type: "skill", slug: "po-check" },
    );
    assert.doesNotMatch(JSON.stringify(events), /skill:\/\/|\/skills\//);
    let outputs = toolOutputs(h);
    assert.ok(outputs.includes("BODY-po-check"), outputs.slice(0, 800));
    const resource = /skill:\/\/[^"\\]*po-check\/SKILL\.md/
      .exec(outputs)?.[0]
      ?.replace("SKILL.md", "references/detail.md");
    assert.ok(resource, "the read names the skill's resource");

    h.model.script.push(read({ package: pkg, resource }), {
      kind: "reply",
      text: "ok",
    });
    events = await h.run(h.body({ threadId, skills }));
    assert.equal(completed(events).status, "completed");
    // A reference read is a use of the same skill; earlier turns' reads in
    // the rollout are not reported again.
    assert.deepEqual(
      events
        .filter((event) => event.type === "skill.used")
        .map((event) => event.data),
      [{ slug: "po-check" }],
    );
    outputs = toolOutputs(h);
    assert.ok(
      outputs.includes("REFERENCE-BODY-po-check"),
      outputs.slice(0, 800),
    );
    assert.ok(!outputs.includes("tenant1"));
  });

  test("a traversal out of a skill is refused", async () => {
    h.model.script.push(read({ package: "../../etc" }), {
      kind: "reply",
      text: "ok",
    });
    const events = await h.run(h.body({ threadId, skills }));
    assert.equal(completed(events).status, "completed");
    assert.ok(!toolOutputs(h).includes("root:"));
    // Not one of the chat's slugs, so not reported.
    assert.ok(!events.some((event) => event.type === "skill.used"));
  });

  test("after a restart the resumed thread still reads its skills", async () => {
    await h.restart();
    const pkg = locator(h.model.lastRequest().body, "gl-close");
    h.model.script.push(read({ package: pkg }), { kind: "reply", text: "ok" });
    const events = await h.run(h.body({ threadId, skills }));
    assert.equal(events[0]!.data.resumed, true);
    assert.equal(completed(events).status, "completed");
    assert.ok(toolOutputs(h).includes("BODY-gl-close"));
    // The resumed thread's rollout is found and read from its end.
    assert.deepEqual(
      events
        .filter((event) => event.type === "skill.used")
        .map((event) => event.data),
      [{ slug: "gl-close" }],
    );
  });

  test("a run without skills offers only update_plan", async () => {
    const events = await h.run(h.body({ chatId: "plain1" }));
    assert.equal(completed(events).status, "completed");
    assert.deepEqual(
      (
        (h.model.lastRequest().body.tools ?? []) as Array<{ name?: string }>
      ).map((tool) => tool.name),
      ["update_plan"],
    );
    assert.doesNotMatch(
      JSON.stringify(h.model.lastRequest().body),
      /po-check|skills\.read/,
    );
  });
});

describe("skill scripts under the coding sandbox (real Codex)", () => {
  const h = new Harness({ coding: true });
  before(() => h.start());
  after(() => h.close());

  const exec = (cmd: string): Behavior => ({
    kind: "call",
    name: "exec_command",
    args: { cmd },
  });

  test("the chat's skill script runs; another skill on the runtime is unreadable", async () => {
    assert.equal((await putSkill(h, PO, PO_SHA, "code1")).status, 200);
    // Pushed for another chat; not this chat's skill.
    const other = archiveOf([
      { path: "secret", type: "5" },
      {
        path: "secret/SKILL.md",
        data: "---\nname: secret\ndescription: x\n---\nSECRET-BODY",
      },
    ]);
    assert.equal(
      (await putSkill(h, other, sha256(other), "code2")).status,
      200,
    );
    const script = join(
      skillRoot(h.stateDir, PO_SHA),
      "po-check",
      "scripts",
      "hello.sh",
    );
    const otherFile = join(
      skillRoot(h.stateDir, sha256(other)),
      "secret",
      "SKILL.md",
    );

    h.model.script.push(
      exec(`sh '${script}'`),
      exec(`cat '${otherFile}'`),
      exec(`sh -c 'echo changed > "${script}"' ; cat '${script}'`),
      { kind: "reply", text: "ran" },
    );
    const events = await h.run(
      h.body({
        chatId: "code1",
        skills: [{ sha256: PO_SHA, slug: "po-check" }],
      }),
    );
    assert.equal(completed(events).status, "completed");
    const input = h.model.lastRequest().body.input as Array<
      Record<string, unknown>
    >;
    const outputs = input
      .filter((item) => item.type === "function_call_output")
      .map((item) => String(item.output));
    assert.equal(outputs.length, 3);
    assert.match(outputs[0]!, /SCRIPT-RAN-po-check/);
    assert.doesNotMatch(outputs[1]!, /SECRET-BODY/);
    assert.doesNotMatch(outputs[2]!, /^changed$/m, "the skill is read-only");
  });

  test("$SKILLS names the chat's skills by name; scripts run from it and it can't be changed", async () => {
    h.model.script.push(
      exec(`sh "$SKILLS/po-check/scripts/hello.sh"`),
      exec(`ls "$SKILLS"`),
      exec(
        `rm "$SKILLS/po-check" ; ln -s / "$SKILLS/root" ; echo x > "$SKILLS/po-check/new" ; ls "$SKILLS"`,
      ),
      { kind: "reply", text: "ran" },
    );
    const events = await h.run(
      h.body({
        chatId: "code1",
        skills: [{ sha256: PO_SHA, slug: "po-check" }],
      }),
    );
    assert.equal(completed(events).status, "completed");
    const body = h.model.lastRequest().body;
    const outputs = (body.input as Array<Record<string, unknown>>)
      .filter((item) => item.type === "function_call_output")
      .map((item) => String(item.output))
      .slice(-3);
    assert.match(outputs[0]!, /SCRIPT-RAN-po-check/);
    // Only this chat's skills, by name; the other chat's skill is not there.
    assert.match(outputs[1]!, /^po-check$/m);
    assert.doesNotMatch(outputs[1]!, /secret/);
    assert.match(outputs[2]!, /^po-check$/m);
    assert.doesNotMatch(outputs[2]!, /^root$/m, "no link can be added");
    assert.ok(
      !existsSync(join(skillRoot(h.stateDir, PO_SHA), "po-check", "new")),
    );
    const text = JSON.stringify(body);
    assert.ok(text.includes("$SKILLS/<skill name>/"), "skill instructions");
    assert.ok(text.includes("use $TMPDIR, never /tmp"), "tmp instructions");
  });

  test("shown commands and output never name the tenant, chat or state directory", async () => {
    const root = join(h.stateDir, "t", "tenant1", "c", "code1");
    const stored = join(skillRoot(h.stateDir, PO_SHA), "po-check");
    h.model.script.push(
      exec(`pwd ; pwd -P ; echo "$TMPDIR" "$HOME" "$SKILLS"`),
      exec(`head -1 ${join(stored, "SKILL.md")} ; echo ${join(root, "home")}`),
      // One unbroken line far longer than the stream's hold-back.
      exec(`printf '%s' "$(printf 'x%.0s' $(seq 1 6000))" ; pwd`),
      { kind: "reply", text: "done" },
    );
    const events = await h.run(
      h.body({
        chatId: "code1",
        skills: [{ sha256: PO_SHA, slug: "po-check" }],
      }),
    );
    const done = completed(events);
    assert.equal(done.status, "completed");
    const shown = JSON.stringify([
      events.filter((e) => e.type.startsWith("command.")),
      done.items,
    ]);
    for (const secret of ["tenant1", "/c/code1", h.stateDir, PO_SHA])
      assert.ok(!shown.includes(secret), `shown text names ${secret}`);
    const items = done.items as Array<{ command?: string; output?: string }>;
    const commands = items.filter((i) => i.command !== undefined);
    assert.match(commands[0]!.output!, /^\$WORKSPACE\n\$WORKSPACE\n/);
    assert.match(commands[0]!.output!, /\$TMPDIR \$TMPDIR \$SKILLS/);
    assert.match(
      commands[1]!.command!,
      /^head -1 \$SKILLS\/po-check\/SKILL\.md ; echo <chat>\/home$/,
    );
    assert.match(commands[1]!.output!, /<chat>\/home\n$/);
    assert.match(commands[2]!.output!, /^x{6000}\$WORKSPACE\n$/);
    // The model still sees the real paths; masking is display only.
    assert.ok(toolOutputs(h).includes(join(root, "workspace")));
  });

  test("a chat without skills gets no $SKILLS and no skill instructions", async () => {
    h.model.script.push(exec(`echo "[$SKILLS]"`), {
      kind: "reply",
      text: "ok",
    });
    const events = await h.run(h.body({ chatId: "code3" }));
    assert.equal(completed(events).status, "completed");
    const body = h.model.lastRequest().body;
    const outputs = (body.input as Array<Record<string, unknown>>)
      .filter((item) => item.type === "function_call_output")
      .map((item) => String(item.output));
    assert.match(outputs.at(-1)!, /\[\]/);
    assert.ok(!JSON.stringify(body).includes("$SKILLS/<skill name>/"));
    assert.ok(
      !existsSync(join(h.stateDir, "t", "tenant1", "c", "code3", "skills")),
    );
  });
});
