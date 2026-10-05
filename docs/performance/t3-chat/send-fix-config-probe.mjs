// Actual configuration() + isolated Mongo. Synthetic DB/DNS delays only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || new URL('../../../', import.meta.url).pathname);
const require = createRequire(resolve(root, 'platform/package.json'));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { PlatformService } = await import(pathToFileURL(resolve(root, 'platform/src/service.ts')));
const { Store } = await import(pathToFileURL(resolve(root, 'platform/src/store.ts')));
const { insertFixtures } = await import(pathToFileURL(resolve(root, 'platform/test/fixtures.ts')));
const { mcpNetwork } = await import(pathToFileURL(resolve(root, 'platform/src/mcp.ts')));
const source = await readFile(resolve(root, 'platform/src/service.ts'), 'utf8');
const configurationSource = source.slice(source.indexOf('  async configuration('), source.indexOf('  // Catalog skills'));
const configurationSha256 = createHash('sha256').update(configurationSource).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mongo = await MongoMemoryServer.create();
const store = await new Store(mongo.getUri(), 'configuration_probe').connect();
let measuring = false;
let delayMs = 0;
let dnsDelayMs = 0;
let reads = 0;
let dnsCalls = 0;
for (const name of ['agents', 'profiles', 'mcp', 'skills']) {
  const getter = Object.getOwnPropertyDescriptor(Store.prototype, name).get;
  Object.defineProperty(store, name, { get() {
    return new Proxy(getter.call(store), { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'findOne') return async (...args) => {
        if (measuring) { reads++; if (delayMs) await sleep(delayMs); }
        return value.apply(target, args);
      };
      if (key === 'find') return (...args) => {
        const cursor = value.apply(target, args);
        let proxy;
        proxy = new Proxy(cursor, { get(item, method) {
          const fn = item[method];
          if (typeof fn !== 'function') return fn;
          if (method === 'toArray') return async (...params) => {
            if (measuring) { reads++; if (delayMs) await sleep(delayMs); }
            return fn.apply(item, params);
          };
          return (...params) => { const result = fn.apply(item, params); return result === item ? proxy : result; };
        } });
        return proxy;
      };
      return value.bind(target);
    } });
  } });
}
mcpNetwork.lookup = async () => {
  if (measuring) { dnsCalls++; if (dnsDelayMs) await sleep(dnsDelayMs); }
  return ['203.0.113.11'];
};
const scenarios = [
  { name: 'owner-no-connectors-225ms-db', db: 225, dns: 0, skills: false, ownerConnector: false, tenantConnectors: 0 },
  { name: 'owner-skills-reservation-225ms-db', db: 225, dns: 0, skills: true, ownerConnector: true, tenantConnectors: 1 },
  { name: 'three-connectors-25ms-dns', db: 0, dns: 25, skills: false, ownerConnector: false, tenantConnectors: 3 },
];
const report = [];
try {
  await insertFixtures(store);
  await store.skills.insertOne({ _id: 'fixture-skill', name: 'fixture-skill', description: 'fixture', body: 'fixture', version: 1 });
  for (const scenario of scenarios) {
    await store.mcp.deleteMany({});
    await store.agents.updateOne({ _id: 'assistant' }, { $set: { skillIds: scenario.skills ? ['fixture-skill'] : [] } });
    const connector = (name, scope) => ({ _id: name, name, scope, ...(scope === 'user' ? { ownerId: 'fixture-owner' } : {}), agentIds: ['assistant'], enabled: true, transport: 'http', url: `https://fixture.example/${name}`, auth: { kind: 'none' } });
    const connectors = Array.from({ length: scenario.tenantConnectors }, (_, i) => connector(`tenant${i}`, 'tenant'));
    if (scenario.ownerConnector) connectors.push(connector('owned', 'user'));
    if (connectors.length) await store.mcp.insertMany(connectors);
    const service = new PlatformService(store);
    const expected = await service.configuration('assistant', { ownerId: 'fixture-owner', cwd: '/fixture-workspace' });
    delayMs = scenario.db;
    dnsDelayMs = scenario.dns;
    const samples = [];
    for (let iteration = -1; iteration < 3; iteration++) {
      reads = 0; dnsCalls = 0; measuring = true;
      const start = performance.now();
      const config = await service.configuration('assistant', { ownerId: 'fixture-owner', cwd: '/fixture-workspace' });
      const elapsedMs = performance.now() - start;
      measuring = false;
      assert.deepEqual(config, expected);
      if (iteration >= 0) samples.push({ elapsedMs, reads, dnsCalls });
    }
    const times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
    const outputSha256 = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
    report.push({ scenario, p50Ms: times[1], samples, outputEquivalent: true, outputSha256 });
  }
  process.stdout.write(JSON.stringify({ configurationSha256, measuredBoundary: 'configuration only; actual isolated Mongo and production service with imposed delay; no live send/provider/paint claim', warmups: 1, repeats: 3, results: report }, null, 2) + '\n');
} finally {
  await store.client.close();
  await mongo.stop();
}
