// Read-only production source; isolated actual PlatformService/Store with fake runtime/DNS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
const root = resolve(new URL('../../../', import.meta.url).pathname);
const require = createRequire(resolve(root, 'platform/package.json'));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { PlatformService } = await import(pathToFileURL(resolve(root, 'platform/src/service.ts')));
const { Store } = await import(pathToFileURL(resolve(root, 'platform/src/store.ts')));
const { insertFixtures } = await import(pathToFileURL(resolve(root, 'platform/test/fixtures.ts')));
const { mcpNetwork } = await import(pathToFileURL(resolve(root, 'platform/src/mcp.ts')));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mongo = await MongoMemoryServer.create();
const store = new Store(mongo.getUri(), 'send_diagnosis', 'send_diagnosis');
Object.defineProperty(store, 'client', { value: new MongoClient(mongo.getUri(), { monitorCommands: true, serverSelectionTimeoutMS: 3000 }) });
await store.connect();
let commandNames = null;
let injectedDbDelayMs = 0;
let dbMeasuring = false;
store.client.on('commandStarted', (event) => {
  // Count command and collection names only, never filters, results, or credentials.
  if (commandNames && ['find', 'insert', 'update', 'findAndModify', 'aggregate', 'getMore'].includes(event.commandName))
    commandNames.push(`${event.commandName}:${event.command[event.commandName]}`);
});
const flags = { enabled: true, defaultMode: 'ask', autopilot: true, nameHeuristic: false };
// Optional delay at real collection await boundaries, only during measured message.
// Preserve real driver calls and synchronous cursor construction/chaining.
for (const name of ['sessions', 'messages', 'agents', 'profiles', 'mcp', 'skills']) {
  const getter = Object.getOwnPropertyDescriptor(Store.prototype, name).get;
  const cursorProxy = (cursor) => {
    let proxy;
    proxy = new Proxy(cursor, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'toArray') return async (...args) => {
        if (dbMeasuring && injectedDbDelayMs) await sleep(injectedDbDelayMs);
        return value.apply(target, args);
      };
      return (...args) => { const result = value.apply(target, args); return result === target ? proxy : result; };
    } });
    return proxy;
  };
  Object.defineProperty(store, name, { configurable: true, get() {
    const collection = getter.call(store);
    return new Proxy(collection, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'find') return (...args) => cursorProxy(value.apply(target, args));
      if (['findOne', 'insertOne', 'updateOne', 'findOneAndUpdate'].includes(key)) return async (...args) => {
        if (dbMeasuring && injectedDbDelayMs) await sleep(injectedDbDelayMs);
        return value.apply(target, args);
      };
      return value.bind(target);
    } });
  } });
}
const repeats = 20;
const reports = [];
try {
  await insertFixtures(store);
  const cases = [
    { name: 'warm-existing-zero-injected-delay', runtimeDelayMs: 0, dnsDelayMs: 0, connectors: 0 },
    { name: 'warm-existing-20ms-runtime-hop', runtimeDelayMs: 20, dnsDelayMs: 0, connectors: 0 },
    { name: 'warm-existing-settings-20ms-runtime-hop', runtimeDelayMs: 20, dnsDelayMs: 0, connectors: 0, settings: { model: 'fixture-model', effort: 'medium' } },
    { name: 'warm-existing-3-connectors-25ms-DNS', runtimeDelayMs: 20, dnsDelayMs: 25, connectors: 3 },
    { name: 'duplicate-accepted-20ms-runtime-hop', runtimeDelayMs: 20, dnsDelayMs: 0, connectors: 0, duplicate: true },
    { name: 'warm-existing-225ms-per-Mongo-await', runtimeDelayMs: 20, dnsDelayMs: 0, connectors: 0, dbDelayMs: 225, repeats: 3, warmups: 1 },
  ];
  for (const scenario of cases) {
    injectedDbDelayMs = scenario.dbDelayMs ?? 0;
    const scenarioRepeats = scenario.repeats ?? repeats;
    const scenarioWarmups = scenario.warmups ?? 2;
    await store.mcp.deleteMany({});
    for (let index = 0; index < scenario.connectors; index++)
      await store.mcp.insertOne({ _id: `fixture-mcp-${index}`, name: `fixture${index}`, scope: 'tenant', transport: 'http', auth: { kind: 'none' }, url: `https://fixture${index}.example/mcp`, agentIds: ['assistant'], enabled: true });
    let phases;
    let dnsCalls = 0;
    mcpNetwork.lookup = async () => {
      dnsCalls++;
      if (scenario.dnsDelayMs) await sleep(scenario.dnsDelayMs);
      return ['203.0.113.11'];
    };
    const samples = [];
    for (let iteration = -scenarioWarmups; iteration < scenarioRepeats; iteration++) {
      const service = new PlatformService(store, ['http://fixture.invalid'], flags);
      let measuring = false;
      let paths = [];
      const conf = service.configuration.bind(service);
      service.configuration = async (...args) => {
        const begin = performance.now();
        const value = await conf(...args);
        if (measuring) phases.configurationMs = performance.now() - begin;
        return value;
      };
      const originalResume = service.resume.bind(service);
      service.resume = async (...args) => {
        const begin = performance.now();
        const value = await originalResume(...args);
        if (measuring) phases.resumeTotalMs = performance.now() - begin;
        return value;
      };
      service.call = async (_owner, path, _method, body) => {
        if (measuring) paths.push(path.replace(/thread-[^/]+/, 'fixture-thread'));
        if (measuring && scenario.runtimeDelayMs) await sleep(scenario.runtimeDelayMs);
        if (path === '/threads') return { threadId: `thread-${scenario.name}-${iteration}`, approvalMode: body.approvalMode };
        if (path.endsWith('/resume')) return { approvalMode: body.approvalMode, items: [], pending: [] };
        if (path.endsWith('/turns')) return { turnId: `turn-${iteration}`, steer: false };
        if (path.endsWith('/capabilities')) return {};
        throw new Error(`Unexpected fake runtime path ${path}`);
      };
      const session = await service.create('assistant', undefined, undefined, 'ask');
      const clientId = `fixture-${scenario.name}-${iteration}`;
      await store.sessions.updateOne({ _id: session._id }, { $set: { title: 'Already titled', userId: 'fixture-owner', ...(scenario.settings ? { settings: scenario.settings } : {}) } });
      if (scenario.duplicate) await service.message(session._id, 'Synthetic diagnostic text', clientId);
      phases = {};
      dnsCalls = 0;
      measuring = true;
      dbMeasuring = true;
      commandNames = [];
      const begin = performance.now();
      const result = await service.message(session._id, 'Synthetic diagnostic text', clientId);
      const totalMs = performance.now() - begin;
      measuring = false;
      dbMeasuring = false;
      const mongoCommands = commandNames;
      commandNames = null;
      assert.equal(result.turnId, `turn-${iteration}`);
      assert.equal(Boolean(result.duplicate), Boolean(scenario.duplicate));
      const receipt = await store.messages.findOne({ sessionId: session._id, clientId });
      assert.equal(receipt.delivery, 'accepted');
      if (iteration >= 0) samples.push({ totalMs, ...phases, platformRoundTripMs: result.platformRoundTripMs ?? null, dnsCalls, runtimePaths: paths, mongoCommands });
    }
    const quantile = (key, q) => {
      const sorted = samples.map((x) => x[key]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
      return sorted.length ? sorted[Math.ceil(q * sorted.length) - 1] : null;
    };
    reports.push({ scenario, repeats: scenarioRepeats, warmups: scenarioWarmups, p50: { totalMs: quantile('totalMs', .5), configurationMs: quantile('configurationMs', .5), resumeTotalMs: quantile('resumeTotalMs', .5), platformRoundTripMs: quantile('platformRoundTripMs', .5) }, p95TotalMs: quantile('totalMs', .95), samples });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, scope: 'Actual service/configuration/isolated Mongo. Fake DNS and runtime, no client network/provider/paint. Injected delays characterize serial gates, not production latency.', reports }, null, 2));
} finally {
  await store.client.close();
  await mongo.stop();
}
