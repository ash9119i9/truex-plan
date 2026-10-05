import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const readJson = async (name) => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
const before = await readJson('send-fix-http-before.json');
const after = await readJson('send-fix-http-after.json');
const manifest = await readJson('send-fix-before-manifest.json');
assert.equal(before.node, 'v24.21.0');
assert.equal(after.node, before.node);
assert.ok(Date.parse(before.capturedAt) < Date.parse(after.capturedAt));
for (const [file, hash] of Object.entries(before.sources)) assert.equal(hash, manifest.sourceSha256[file], `frozen manifest ${file}`);
for (const [file, hash] of Object.entries(after.sources)) {
  const actual = createHash('sha256').update(await readFile(resolve(after.root, file))).digest('hex');
  assert.equal(hash, actual, `final working source ${file}`);
}
const counts = (commands) => Object.fromEntries([...new Set(commands)].sort().map((value) => [value, commands.filter((entry) => entry === value).length]));
const rows = before.reports.map((baseline, index) => {
  const current = after.reports[index];
  assert.deepEqual(baseline.scenario, current.scenario);
  assert.equal(baseline.samples.length, 5);
  assert.equal(current.samples.length, 5);
  for (let sampleIndex = 0; sampleIndex < 5; sampleIndex++) {
    const b = baseline.samples[sampleIndex], a = current.samples[sampleIndex];
    assert.deepEqual(counts(b.mongoCommands), counts(a.mongoCommands), `${baseline.scenario.name} Mongo command counts`);
    assert.deepEqual(b.runtimeRequests.map((request) => request.path), a.runtimeRequests.map((request) => request.path));
    assert.equal(b.runtimeRequests.find((request) => request.path.endsWith('/resume')).responseMode, 'default-full');
    assert.equal(a.runtimeRequests.find((request) => request.path.endsWith('/resume')).responseMode, 'operational');
    assert.equal(b.serverTiming, null);
    const fields = Object.fromEntries(a.serverTiming.split(', ').map((entry) => {
      const [phase, value] = entry.split(';dur=');
      return [phase, Number(value)];
    }));
    for (const [key, value] of Object.entries(a.platformTiming)) {
      assert.ok(Number.isFinite(value) && value >= 0);
      assert.ok(Math.abs(fields[key.replace(/Ms$/, '')] - value) <= 0.00501);
    }
    const timing = a.platformTiming;
    assert.ok(Math.abs(timing.totalMs - timing.authorizationMs - timing.preparationMs - timing.dispatchMs - timing.receiptMs) < 0.000001);
  }
  const resumes = (report) => report.samples.map((sample) => sample.runtimeRequests.find((request) => request.path.endsWith('/resume')).responseBytes);
  return {
    scenario: baseline.scenario.name,
    beforeMedianMs: baseline.medianTotalMs,
    afterMedianMs: current.medianTotalMs,
    medianDifferenceMs: baseline.medianTotalMs - current.medianTotalMs,
    beforeP95Ms: baseline.p95TotalMs,
    afterP95Ms: current.p95TotalMs,
    beforeMessageMedianMs: baseline.medianMessageHttpMs,
    afterMessageMedianMs: current.medianMessageHttpMs,
    beforeResumeBytes: resumes(baseline),
    afterResumeBytes: resumes(current),
  };
});
const result = { capturedAt: new Date().toISOString(), checks: { baselineMatchesFrozenManifest: true, afterMatchesFinalWorkingSources: true, matchedNode: true, sequentialCapture: true, fiveMeasuredSamplesEach: true, matchedMongoCommandCounts: true, matchedRuntimePaths: true, operationalResumeOptIn: true, actualServerTimingMatchesJson: true, phasesSumToTotal: true }, scope: after.fixture, rows };
await writeFile(resolve(directory, 'send-fix-http-comparison.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
