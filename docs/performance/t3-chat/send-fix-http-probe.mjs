import { resolvePlatformSource } from "../../../platform/scripts/source-paths.mjs";
// Matched localhost HTTP evidence. No production .env, runtime binary, or provider.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(process.argv[2] || '.');
process.env.PROJECT_ROOT = root;
process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
process.env.MCP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const require = createRequire(join(root, 'platform/package.json'));
const coreRequire = createRequire(join(root, 'agent-core/package.json'));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const express = coreRequire('express');
const typescript = coreRequire('typescript');
const executable = (statement) => typescript.transpileModule(statement, { compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.CommonJS } }).outputText;
const imported = async (file) => import(pathToFileURL(resolvePlatformSource(root, file)).href);
const { PlatformService } = await imported('platform/src/service.ts');
const { Store } = await imported('platform/src/store.ts');
const { ThreadManager } = await imported('agent-core/src/manager.ts');
const { insertFixtures } = await imported('platform/test/fixtures.ts');
const { requestIdMiddleware, tenantMiddleware, userMiddleware, route, errorHandler } = await imported('platform/src/http.ts');
const { devUserResolver } = await imported('platform/src/user.ts');
const { devTenantResolver } = await imported('platform/src/tenant.ts');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sources = {};
const coreRoutesPath = resolvePlatformSource(root, 'agent-core/src/http/routes/threads.ts', 'agent-core/src/index.ts');
for (const file of ['platform/src/service.ts', 'platform/src/store.ts', 'platform/src/runtime-transport.ts', 'platform/src/http.ts', 'platform/src/index.ts', 'agent-core/src/manager.ts', 'agent-core/src/index.ts', 'shared/runtime-read-options.ts']) {
  const actual = resolvePlatformSource(root, file);
  sources[relative(root, actual)] = sha256(await readFile(actual, 'utf8'));
}
sources[relative(root, coreRoutesPath)] = sha256(await readFile(coreRoutesPath, 'utf8'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const temporary = await mkdtemp(join(tmpdir(), 'truex-send-http-'));
let mongo, store, coreServer, apiServer, manager;
const listen = (app) => new Promise((done) => {
  const server = app.listen(0, '127.0.0.1', () => done(server));
});
const close = (server) => server && new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
const address = (server) => `http://127.0.0.1:${server.address().port}`;
// Mount exact source route statements, avoiding the production index's startup
// side effects (dotenv, real runtime, ingestion, configured database).
const extractRoute = (text, marker, ending) => {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `route marker ${marker}`);
  const end = text.indexOf(ending, start);
  assert.ok(end >= start);
  return text.slice(start, end + ending.length);
};
let dbDelayMs = 0, measuring = false, operations = [], runtimeRequests = [], phaseTimes = {};
try {
  mongo = await MongoMemoryServer.create();
  store = new Store(mongo.getUri(), 'send_http_fixture', 'send_http_fixture');
  Object.defineProperty(store, 'client', { value: new MongoClient(mongo.getUri(), { monitorCommands: true, serverSelectionTimeoutMS: 3000 }) });
  await store.connect();
  await insertFixtures(store);
  store.client.on('commandStarted', (event) => {
    if (measuring && ['find', 'insert', 'update', 'findAndModify', 'aggregate', 'getMore'].includes(event.commandName)) operations.push(`${event.commandName}:${event.command[event.commandName]}`);
  });
  for (const name of ['sessions', 'messages', 'agents', 'profiles', 'mcp', 'skills']) {
    const getter = Object.getOwnPropertyDescriptor(Store.prototype, name).get;
    const proxyCursor = (cursor) => {
      let proxy;
      proxy = new Proxy(cursor, { get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (key === 'toArray') return async (...args) => {
          if (measuring && dbDelayMs) await sleep(dbDelayMs);
          return value.apply(target, args);
        };
        return (...args) => { const result = value.apply(target, args); return result === target ? proxy : result; };
      } });
      return proxy;
    };
    Object.defineProperty(store, name, { get() {
      return new Proxy(getter.call(store), { get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (key === 'find') return (...args) => proxyCursor(value.apply(target, args));
        if (['findOne', 'insertOne', 'updateOne', 'findOneAndUpdate'].includes(key)) return async (...args) => {
          if (measuring && dbDelayMs) await sleep(dbDelayMs);
          return value.apply(target, args);
        };
        return value.bind(target);
      } });
    } });
  }
  class FakeRuntime extends EventEmitter {
    sequence = 0;
    async request(method, params) {
      if (method === 'thread/start') return { thread: { id: `fixture-thread-${++this.sequence}` } };
      if (method === 'turn/start') return { turn: { id: `fixture-turn-${++this.sequence}` } };
      if (method === 'thread/unsubscribe') return {};
      throw new Error(`Unexpected fake RPC ${method}`);
    }
    respond() {}
  }
  const runtime = new FakeRuntime();
  manager = new ThreadManager(runtime, temporary, 500, 500);
  manager.generation = 'fixture-generation';
  const core = express();
  core.use(express.json({ limit: '2mb' }));
  // A deterministic 20 ms runtime HTTP boundary, identical in both versions.
  core.use(async (req, res, next) => {
    await sleep(20);
    if (measuring) {
      const event = { path: req.path.replace(/fixture-thread-\d+/, 'fixture-thread'), responseMode: req.body?.response ?? 'default-full', responseBytes: null };
      runtimeRequests.push(event);
      const json = res.json.bind(res);
      res.json = (body) => { event.responseBytes = Buffer.byteLength(JSON.stringify(body)); return json(body); };
    }
    next();
  });
  const coreSource = await readFile(coreRoutesPath, 'utf8');
  const coreRouteEnding = coreRoutesPath.endsWith('/http/routes/threads.ts') ? '\n  );' : '\n);';
  const mountedRouteHashes = {};
  for (const marker of ['app.post("/threads",', 'app.post("/threads/:id/resume",', 'app.post("/threads/:id/turns",']) {
    const statement = extractRoute(coreSource, marker, coreRouteEnding);
    mountedRouteHashes[marker] = sha256(statement);
    new Function('app', 'manager', 'client', executable(statement))(core, manager, { spawnMs: 0, initializeMs: 0 });
  }
  core.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  coreServer = await listen(core);
  const service = new PlatformService(store, [address(coreServer)], { enabled: true, defaultMode: 'ask', autopilot: true, nameHeuristic: false });
  for (const name of ['configuration', 'resume']) {
    const original = service[name].bind(service);
    service[name] = async (...args) => {
      const started = performance.now();
      const result = await original(...args);
      if (measuring) (phaseTimes[name] ||= []).push(performance.now() - started);
      return result;
    };
  }
  const api = express();
  api.use(requestIdMiddleware);
  api.use(express.json({ limit: '2mb' }));
  const env = { NODE_ENV: 'test', DEV_USER_ID: 'fixture-owner', DEV_USER_ROLE: 'user' };
  api.use('/api', tenantMiddleware(devTenantResolver(env), (id) => store.resolveTenant(id)));
  api.use('/api', userMiddleware(devUserResolver(env)));
  const apiSource = await readFile(resolvePlatformSource(root, 'platform/src/conversations/routes.ts', 'platform/src/index.ts'), 'utf8');
  for (const marker of ['http.post(\n    "/api/sessions",', 'http.post(\n    "/api/sessions/:id/messages",']) {
    const statement = extractRoute(apiSource, marker, '\n  );');
    mountedRouteHashes[marker] = sha256(statement);
    new Function('http', 'service', 'route', executable(statement))(api, service, route);
  }
  api.use(errorHandler);
  apiServer = await listen(api);
  const post = async (path, body, status) => {
    const start = performance.now();
    const response = await fetch(address(apiServer) + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, status, text);
    return { value: JSON.parse(text), ms: performance.now() - start, responseBytes: Buffer.byteLength(text), serverTiming: response.headers.get('server-timing') };
  };
  const create = async () => {
    const result = await post('/api/sessions', { agentId: 'assistant', approvalMode: 'ask' }, 201);
    // Public session intentionally omits its private runtime thread id. Use
    // the synthetic manager fixture to inspect it without another Mongo gate.
    result.value.threadId = [...manager.threads.keys()].at(-1);
    return result;
  };
  const complete = (threadId, turnId) => runtime.emit('notification', { method: 'turn/completed', params: { threadId, turnId, turn: { id: turnId, status: 'completed' } } });
  const seed = (threadId, count) => {
    for (let i = 0; i < count; i++) runtime.emit('notification', { method: 'item/completed', params: { threadId, turnId: `history-${i}`, item: { id: `message-${i}`, type: 'agentMessage', text: `Synthetic-${i}:` + 'x'.repeat(2048) } } });
  };
  const reports = [];
  for (const scenario of [
    { name: 'new-create-plus-first-message', newSession: true, dbDelayMs: 0, history: 0 },
    { name: 'existing-followup', newSession: false, dbDelayMs: 0, history: 0 },
    { name: 'existing-followup-1000-messages', newSession: false, dbDelayMs: 0, history: 1000 },
    { name: 'new-create-plus-first-message-225ms-Mongo-await', newSession: true, dbDelayMs: 225, history: 0 },
    { name: 'existing-followup-225ms-Mongo-await', newSession: false, dbDelayMs: 225, history: 0 },
  ]) {
    dbDelayMs = scenario.dbDelayMs;
    const samples = [];
    for (let iteration = -1; iteration < 5; iteration++) {
      let session;
      if (!scenario.newSession) {
        session = (await create()).value;
        const prior = await post(`/api/sessions/${session._id}/messages`, { text: 'Synthetic prior message', clientId: `prior-${scenario.name}-${iteration}` }, 202);
        complete(session.threadId, prior.value.turnId);
        seed(session.threadId, scenario.history);
      }
      // Both variants start with the tenant cache hot. Its production five
      // second TTL would otherwise expire at different iterations because
      // baseline requests spend longer in the measured database gates.
      store.tenants.clear();
      await store.resolveTenant('default');
      operations = []; runtimeRequests = []; phaseTimes = {}; measuring = true;
      const started = performance.now();
      let createMs = null;
      if (scenario.newSession) {
        const created = await create(); session = created.value; createMs = created.ms;
      }
      const clientId = `send-${scenario.name}-${iteration}`;
      const accepted = await post(`/api/sessions/${session._id}/messages`, { text: 'Synthetic measured message', clientId }, 202);
      const totalMs = performance.now() - started;
      measuring = false;
      const receipt = await store.messages.findOne({ sessionId: session._id, clientId });
      assert.equal(receipt.delivery, 'accepted');
      assert.equal(receipt.turnId, accepted.value.turnId);
      assert.equal(accepted.value.steer, false);
      assert.equal(manager.threads.get(session.threadId).state.kind, 'running');
      complete(session.threadId, accepted.value.turnId);
      if (iteration >= 0) samples.push({ totalMs, createMs, messageHttpMs: accepted.ms, responseBytes: accepted.responseBytes, serverTiming: accepted.serverTiming, platformTiming: accepted.value.platformTiming ?? null, platformRoundTripMs: accepted.value.platformRoundTripMs, configurationMs: phaseTimes.configuration, resumeMs: phaseTimes.resume, mongoCommands: operations, runtimeRequests, retainedMessages: manager.threads.get(session.threadId).messages.length });
    }
    const quantile = (key, q) => samples.map((item) => item[key]).sort((a, b) => a - b)[Math.ceil(q * samples.length) - 1];
    reports.push({ scenario, repeats: 5, warmups: 1, medianTotalMs: quantile('totalMs', .5), p95TotalMs: quantile('totalMs', .95), medianMessageHttpMs: quantile('messageHttpMs', .5), samples });
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, root, sources, mountedRouteHashes, fixture: { database: 'actual isolated MongoMemoryServer; driver commands counted; fixed await delay injected only during measurement', runtime: 'actual ThreadManager and actual RuntimeTransport over localhost HTTP; fake runtime request; fixed20ms HTTP boundary', authentication: 'actual dev tenant/user resolvers and middleware; fixed synthetic owner; actual service authorization; tenant cache explicitly refreshed outside measurement; no OIDC/cookie auth', routes: 'exact create/message and create/resume/turns source statements extracted and mounted in Express; not production bootstrap', exclusions: ['browser', 'frontend route proxy', 'SSE delivery', 'provider', 'real model latency', 'remote Mongo', 'production CPU contention'], history: '1000 synthetic completed messages, each 2048 characters; actual serialization through runtime resume HTTP response', latency: 'acceptance only; first model response is not measured; 225ms fixed Mongo-await scenario characterizes serial gates, not production p50' }, reports }, null, 2));
} finally {
  manager?.close();
  await close(apiServer);
  await close(coreServer);
  await store?.client.close();
  await mongo?.stop();
  await rm(temporary, { recursive: true, force: true });
}
