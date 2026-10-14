import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] ?? '.');
const frozen = process.argv[3] ?? '/tmp/truex-send-fix-before-20261006';
process.env.PROJECT_ROOT = repo;
const imported = async (file, name) => { const m = await import(pathToFileURL(file).href); return m[name] ?? m.default[name]; };
const Manager = await imported(path.join(frozen, 'agent-core/src/manager.ts'), 'ThreadManager');
const Business = await imported(path.join(frozen, 'agent-core/src/business-runtime.ts'), 'BusinessRuntime');
const OldClient = await imported(path.join(frozen, 'agent-core/src/client.ts'), 'CodexClient');
const Client = await imported(path.join(repo, 'agent-core/src/runtime/client.ts'), 'CodexClient');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'truex-prepare-compat-'));
const productionHome = path.join(temporary, 'business');
const original = OldClient.prototype.request;
let manager;
let client;
try {
  await mkdir(path.join(productionHome, 'business-threads'), { recursive: true });
  await mkdir(path.join(productionHome, 'workspace'), { recursive: true });
  await writeFile(path.join(productionHome, 'business-threads/thread.json'), JSON.stringify({ cwd: path.join(productionHome, 'workspace'), tenantId: 'tenant-a' }));
  const forwarded = [];
  OldClient.prototype.request = async function(method, params) {
    forwarded.push({ method, parameterKeys: Object.keys(params), includesResponse: Object.hasOwn(params, 'response') });
    return method === 'thread/resume' ? { thread: { id: 'thread', turns: [] } } : {};
  };
  const runtime = new Business('unused-fixture-binary', productionHome);
  manager = new Manager(runtime, productionHome);
  const cold = await manager.resume('thread', { tenantId: 'tenant-a', response: 'operational', approvalMode: 'ask' });
  assert.equal(cold.approvalMode, 'ask');
  assert.deepEqual(forwarded.map(x => x.method), ['thread/resume', 'thread/goal/get']);
  assert.equal(forwarded[0].includesResponse, false);
  OldClient.prototype.request = original;
  manager.close(); manager = undefined;

  // Missing history probes parameter decoding only; never starts a model turn.
  const binary = path.join(repo, 'vendor/codex/codex-rs/target/debug/codex');
  const binaryHome = path.join(temporary, 'binary');
  await mkdir(binaryHome);
  client = new Client(binary, binaryHome, 10000);
  const threadId = randomUUID();
  const binaryResults = [];
  for (const response of [undefined, 'operational']) {
    try {
      await client.request('thread/resume', { threadId, ...(response ? { response } : {}) });
      throw new Error('Expected missing-history error');
    } catch (error) {
      const result = { extraResponse: response !== undefined, rpcCode: error.rpcCode, missingHistory: /not found|does not exist|no rollout|unable to find.*thread/i.test(error.rpcMessage ?? ''), rejectsUnknownField: /unknown field|unexpected field|unrecognized field/i.test(error.rpcMessage ?? '') };
      assert.equal(result.missingHistory, true);
      assert.equal(result.rejectsUnknownField, false);
      binaryResults.push(result);
    }
  }
  assert.equal(binaryResults[0].rpcCode, binaryResults[1].rpcCode);
  process.stdout.write(JSON.stringify({ frozenProductionPath: 'original ThreadManager → original BusinessRuntime → captured CodexClient.request', forwarded, approvalAcknowledged: cold.approvalMode === 'ask', pinnedBinary: { relativePath: 'vendor/codex/codex-rs/target/debug/codex', requests: binaryResults, modelTurnsStarted: 0 }, conclusion: 'Frozen production BusinessRuntime strips the opt-in field before thread/resume; the pinned binary also tolerates it on a direct missing-history resume.' }, null, 2) + '\n');
} finally {
  OldClient.prototype.request = original;
  manager?.close();
  client?.stop();
  await new Promise(resolve => setTimeout(resolve, 300));
  await rm(temporary, { recursive: true, force: true });
}
