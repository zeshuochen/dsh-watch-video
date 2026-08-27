import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoverInterruptedJobs, DEFAULT_STALE_JOB_AFTER_MS, getJobStatus, listJobs, cancelJob } from '../dist/index.js';

const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const now = Date.parse('2026-01-01T00:00:00.000Z');

async function makeJob(root, jobId, metadata, files = {}) {
  const dir = path.join(root, jobId);
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ jobId, ...metadata }));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  return dir;
}

test('recovers stale running jobs without starting external processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-test-'));
  try {
    const jobId = id(1);
    const dir = await makeJob(root, jobId, { status: 'running', phase: 'transcribing', method: 'whisper', instanceId: 'old-instance', startedAt: '2025-12-31T00:00:00.000Z', jobCreatedAt: '2025-12-31T00:00:00.000Z', heartbeatAt: '2025-12-31T00:00:00.000Z' }, { 'audio.wav': 'audio', 'transcript.txt': 'partial', 'summary.md': 'partial', 'transcript.srt': 'partial', 'transcript.json': '{}' });
    const result = await recoverInterruptedJobs(root, { staleJobAfterMs: 5 * 60 * 1000, now });
    assert.deepEqual(result.recovered, [jobId]);
    assert.equal(getJobStatus(jobId).status, 'interrupted');
    assert.equal(listJobs().find((job) => job.jobId === jobId)?.status, 'interrupted');
    const cancel = await cancelJob(jobId);
    assert.equal(cancel.cancelled, false);
    assert.equal(cancel.status, 'interrupted');
    const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.status, 'interrupted');
    assert.equal(metadata.phase, 'interrupted');
    assert.equal(metadata.reason, 'stale_running_job');
    assert.equal(metadata.message, 'Previous process stopped before the job completed');
    assert.deepEqual(await readdir(dir).then((items) => items.sort()), ['metadata.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conservatively skips missing, invalid, future, and fresh heartbeats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-test-'));
  try {
    const cases = [['missing', {}], ['invalid', { heartbeatAt: 'nope' }], ['future', { heartbeatAt: '2026-01-02T00:00:00.000Z' }], ['fresh', { heartbeatAt: '2025-12-31T23:59:00.000Z' }]];
    for (const [name, extra] of cases) await makeJob(root, id(cases.indexOf(cases.find((item) => item[0] === name)) + 2), { status: 'running', ...extra });
    const result = await recoverInterruptedJobs(root, { staleJobAfterMs: 5 * 60 * 1000, now });
    assert.equal(result.recovered.length, 0);
    assert.equal(result.skipped.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers only beyond the stale threshold and skips non-running status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-test-'));
  try {
    await makeJob(root, id(10), { status: 'completed', heartbeatAt: '2025-01-01T00:00:00.000Z' });
    await makeJob(root, id(11), { status: 'running', heartbeatAt: new Date(now - DEFAULT_STALE_JOB_AFTER_MS).toISOString() });
    await makeJob(root, id(12), { status: 'running', heartbeatAt: new Date(now - DEFAULT_STALE_JOB_AFTER_MS - 1).toISOString() });
    const result = await recoverInterruptedJobs(root, { now });
    assert.deepEqual(result.recovered, [id(12)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not follow a symlinked job directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-test-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-outside-'));
  try {
    await makeJob(outside, id(20), { status: 'running', heartbeatAt: '2025-01-01T00:00:00.000Z' }, { 'audio.wav': 'keep' });
    try { await (await import('node:fs/promises')).symlink(path.join(outside, id(20)), path.join(root, id(20)), 'junction'); }
    catch { return; }
    await recoverInterruptedJobs(root, { staleJobAfterMs: 5 * 60 * 1000, now });
    assert.equal(await readFile(path.join(outside, id(20), 'audio.wav'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
