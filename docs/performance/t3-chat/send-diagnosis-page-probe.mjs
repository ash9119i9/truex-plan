// Reuse the existing actual-handler AST fixture without modifying source/tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const root = resolve(new URL('../../../', import.meta.url).pathname);
const testUrl = pathToFileURL(resolve(root, 'frontend/test/composer-dispatch.test.ts')).href;
const require = createRequire(testUrl);
const ts = require('typescript');
const fixtureSource = readFileSync(new URL(testUrl), 'utf8').split('\ntest(')[0]
  .replaceAll('import.meta.url', JSON.stringify(testUrl)) + '\nmodule.exports = { harness };';
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fixtureSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, { module, exports: module.exports, require, URL, console, process, Buffer });
const { harness } = module.exports;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
for (const scenario of [
  { name: 'new-configured-session', createMs: 80, modeMs: 0, acceptanceMs: 60 },
  { name: 'existing-session', createMs: 0, modeMs: 0, acceptanceMs: 60 },
  { name: 'legacy-platform-mode-confirmation', createMs: 80, modeMs: 40, acceptanceMs: 60 },
]) {
  const samples = [];
  for (let iteration = -2; iteration < 20; iteration++) {
    const session = { _id: 'fixture-session', approvalMode: 'ask' };
    const calls = [];
    const events = [];
    let begin;
    const { context: c } = harness({
      draftModeRef: { current: 'ask' },
      sessionRef: { current: scenario.createMs ? null : session },
      api: async () => {
        calls.push('create');
        await sleep(scenario.createMs);
        return { ...session, approvalMode: scenario.modeMs ? 'readOnly' : 'ask' };
      },
      setApprovalMode: async () => {
        calls.push('mode');
        await sleep(scenario.modeMs);
        return 'ask';
      },
      transport: { send: async () => {
        calls.push('send');
        events.push({ phase: 'transport-start', ms: performance.now() - begin });
        await sleep(scenario.acceptanceMs);
        return { turnId: 'fixture-turn', steer: false };
      } },
    });
    const originalEntries = c.setEntries;
    c.setEntries = (next) => {
      originalEntries(next);
      if (c.entries.some((x) => x.delivery === 'pending') && !events.some((x) => x.phase === 'optimistic-setter'))
        events.push({ phase: 'optimistic-setter', ms: performance.now() - begin });
    };
    begin = performance.now();
    const pending = c.send();
    assert.equal(c.entries.length, 1, 'optimistic user appears before first async creation/acceptance');
    assert.equal(c.text, '');
    assert.equal(c.sending.current, true);
    await c.send('duplicate while waiting');
    assert.equal(c.entries.length, 1);
    c.setText('New draft while sending');
    await pending;
    const elapsedMs = performance.now() - begin;
    assert.equal(c.sending.current, false);
    assert.equal(c.entries[0].delivery, 'accepted');
    assert.equal(c.text, 'New draft while sending');
    assert.equal(calls.filter((x) => x === 'send').length, 1);
    if (iteration >= 0) samples.push({ elapsedMs, optimisticSetterMs: events.find((x) => x.phase === 'optimistic-setter').ms, transportStartMs: events.find((x) => x.phase === 'transport-start').ms, calls });
  }
  const quantile = (key, q) => samples.map((x) => x[key]).sort((a,b) => a-b)[Math.ceil(q * samples.length)-1];
  results.push({ scenario, repeats: 20, warmups: 2, p50: { optimisticSetterMs: quantile('optimisticSetterMs', .5), transportStartMs: quantile('transportStartMs', .5), elapsedMs: quantile('elapsedMs', .5) }, p95ElapsedMs: quantile('elapsedMs', .95), samples });
}
console.log(JSON.stringify({ node: process.version, scope: 'Actual page handlers extracted by existing fixture, fake create/mode/acceptance. Measures synchronous setter and lock, not React paint/browser latency.', results }, null, 2));
