import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolvePlatformSource } from '../../../platform/scripts/source-paths.mjs';

const repo = path.resolve(process.argv[2] ?? '.');
process.env.PROJECT_ROOT = repo;
const evidence = path.join(repo, 'docs/performance/t3-chat');
const sourcePath = resolvePlatformSource(repo, 'agent-core/src/manager.ts');
const baselineSourcePath = path.join(repo, 'agent-core/src/manager.ts');
const frozenPath = path.join(evidence, 'send-prepare-manager-baseline.txt');
const hash = source => createHash('sha256').update(source).digest('hex');
if (process.argv.includes('--freeze')) {
  const source = await readFile(sourcePath, 'utf8');
  await writeFile(frozenPath, source, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ frozenPath, sha256: hash(source) }) + '\n');
} else {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'truex-send-prepare-'));
  const before = await readFile(frozenPath, 'utf8');
  const after = await readFile(sourcePath, 'utf8');
  const baselinePath = path.join(temporary, 'manager-baseline.ts');
  const rewritten = before.replace(/(from\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (_m, prefix, quote, relative) => {
    const requested = path.resolve(path.dirname(baselineSourcePath), relative);
    const file = /\.(?:ts|json)$/.test(requested) ? requested : `${requested}.ts`;
    const absolute = resolvePlatformSource(repo, path.relative(repo, file));
    return `${prefix}${quote}${/\.(?:ts|json)$/.test(absolute) ? absolute : `${absolute}.ts`}${quote}`;
  });
  await writeFile(baselinePath, rewritten);
  const results = [];
  try {
    for (const [mode, modulePath] of [['frozen-baseline', baselinePath], ['working-tree', sourcePath]]) {
      const imported = await import(pathToFileURL(modulePath).href);
      const Manager = imported.ThreadManager ?? imported.default.ThreadManager;
      for (const messageCount of [100, 1000, 10000]) {
        class FakeRuntime extends EventEmitter {
          async request(method) { return method === 'thread/start' ? { thread: { id: 'thread' } } : {}; }
          respond() {}
        }
        const runtime = new FakeRuntime();
        const manager = new Manager(runtime, path.join(temporary, `${mode}-${messageCount}`), 20, 500);
        try {
          manager.generation = 'fixture';
          await manager.create({});
          for (let i = 0; i < messageCount; i++) runtime.emit('notification', {
            method: 'item/completed', params: { threadId: 'thread', turnId: `turn-${i}`, item: { id: `message-${i}`, type: 'agentMessage', text: `answer-${i}:` + 'x'.repeat(2048) } },
          });
          let snapshotCalls = 0;
          const snapshot = manager.snapshot.bind(manager);
          manager.snapshot = (...args) => { snapshotCalls++; return snapshot(...args); };
          for (const response of [undefined, 'operational']) {
            const samples = [];
            let responseBytes;
            snapshotCalls = 0;
            for (let run = 0; run < 35; run++) {
              const start = performance.now();
              const result = await manager.resume('thread', response ? { response } : {});
              const serialized = JSON.stringify(result);
              const elapsed = performance.now() - start;
              const size = Buffer.byteLength(serialized);
              if (responseBytes !== undefined) assert.equal(size, responseBytes);
              responseBytes = size;
              if (run >= 5) samples.push(elapsed);
            }
            samples.sort((a, b) => a - b);
            results.push({ mode, messageInputs: messageCount, retainedMessages: manager.threads.get("thread").messages.length, response: response ?? 'default-full', samples: samples.length, medianMs: samples[15], p95Ms: samples[28], responseBytes, snapshotCalls });
          }
        } finally { manager.close(); }
      }
    }
    process.stdout.write(JSON.stringify({ fixture: 'actual ThreadManager warm resume plus JSON serialization; synthetic 2048-character completed messages; no model/database/network', beforeSha256: hash(before), afterSha256: hash(after), results }, null, 2) + '\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
