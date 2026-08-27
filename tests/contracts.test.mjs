import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { apply, cancelToolDefinition, cleanupArtifacts, getJobStatus, listJobs, readTranscript, understand, validateResourceConfig, validateTranscript } from '../dist/index.js';

test('registers strict video job tool contracts', async () => {
  const cancel = cancelToolDefinition;
  assert.equal(cancel.name, 'dsh_video_understand_cancel'); assert.deepEqual(Object.keys(cancel.parameters), ['jobId']);
  assert.equal(cancel.parameters.jobId.required, true);
  assert.equal(cancel.output.schema.additionalProperties, false);
  assert.ok(Object.values(cancel.output.schema.properties).every((property) => property.required === true));
  assert.doesNotThrow(() => defineTool(cancel));
  assert.throws(() => cancel.execute({ jobId: '00000000-0000-4000-8000-000000000000', extra: true }), /only allow jobId/);
  const registered = []; assert.doesNotThrow(() => apply({ tools: { register: (tool) => registered.push(tool) } }, {}));
  assert.deepEqual(registered.map((tool) => tool.name), ['dsh_video_understand', 'dsh_video_understand_cancel', 'dsh_video_understand_status', 'dsh_video_understand_list']);
  const status = registered.find((tool) => tool.name === 'dsh_video_understand_status');
  assert.deepEqual(Object.keys(status.parameters.properties), ['jobId']);
  assert.deepEqual(status.parameters.required, ['jobId']);
  assert.equal(status.output.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(status.output.schema.properties), ['jobId', 'status', 'phase', 'createdAt', 'updatedAt', 'method', 'progress', 'message', 'found']);
  await assert.rejects(() => status.execute({ jobId: 'x', extra: true }), /only allow jobId/);
  const list = registered.find((tool) => tool.name === 'dsh_video_understand_list');
  assert.deepEqual(Object.keys(list.parameters.properties), []);
  await assert.rejects(() => list.execute({ extra: true }), /must be empty/);
});

test('job status is process-local and exposes only safe summaries', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'dsh-video-status-'));
  const yt = path.resolve('tests/fake-ytdlp.mjs');
  const config = { outputDir: out, ytDlpPath: process.execPath, ytDlpPrefixArgs: [yt, '--delay-ms=120'], device: 'cpu', timeoutMs: 2000, maxDurationSeconds: 90, maxFileBytes: 100, maxOutputBytes: 1024 };
  const task = understand({ url: 'https://example.test/video' }, config);
  const waitFor = async (predicate) => { const end = Date.now() + 1000; while (!(await predicate())) { if (Date.now() >= end) throw new Error('condition timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); } };
  await waitFor(() => listJobs().some((job) => job.status === 'running'));
  const running = listJobs(); const jobId = running.find((job) => job.status === 'running').jobId;
  await waitFor(() => getJobStatus(jobId).phase === 'probing_subtitles');
  const status = getJobStatus(jobId);
  assert.equal(status.found, true); assert.equal(status.phase, 'probing_subtitles');
  assert.deepEqual(Object.keys(status), ['jobId', 'status', 'phase', 'createdAt', 'updatedAt', 'method', 'progress', 'message', 'found']);
  await task;
  const completed = getJobStatus(jobId); assert.equal(completed.status, 'completed'); assert.equal(completed.phase, 'completed'); assert.equal(completed.progress, 100);
  assert.equal(JSON.stringify(completed).includes(out), false); assert.equal(JSON.stringify(completed).includes('Promise'), false);
  const missing = getJobStatus('00000000-0000-4000-8000-000000000000'); assert.equal(missing.found, false); assert.equal(missing.status, 'not_found');
  await rm(out, { recursive: true, force: true });
});

test('rejects invalid resource configuration before starting a job', () => {
  for (const key of ['timeoutMs', 'outputLimitBytes', 'maxDurationSeconds', 'maxFileBytes', 'maxOutputBytes', 'retentionDays', 'maxTotalBytes']) {
    assert.throws(() => validateResourceConfig({ [key]: 0 }), new RegExp('invalid configuration: ' + key));
    assert.throws(() => validateResourceConfig({ [key]: 1.5 }), new RegExp('invalid configuration: ' + key));
    assert.throws(() => validateResourceConfig({ [key]: Number.MAX_SAFE_INTEGER + 1 }), new RegExp('invalid configuration: ' + key));
  }
  assert.doesNotThrow(() => validateResourceConfig({ timeoutMs: 1, outputLimitBytes: 1, maxDurationSeconds: 1, maxFileBytes: 1, maxOutputBytes: 1 }));
});

test('understand rejects invalid configuration before creating a job', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-video-config-'));
  await assert.rejects(
    () => understand({ url: 'https://example.test/video' }, { outputDir, timeoutMs: 0 }),
    /invalid configuration: timeoutMs/,
  );
  assert.deepEqual(await readdir(outputDir), []);
});

test('cleans TTL and capacity oldest-first while protecting running, current, and linked jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-video-retention-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dsh-video-outside-'));
  const { access, mkdir, rm, symlink, utimes } = await import('node:fs/promises');
  const makeJob = async (id, status, ageMs, bytes) => {
    const dir = path.join(root, id); await mkdir(dir);
    await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ jobId: id, status }));
    await writeFile(path.join(dir, 'artifact.bin'), Buffer.alloc(bytes));
    const time = new Date(Date.now() - ageMs); await utimes(dir, time, time); return dir;
  };
  const expired = await makeJob('expired', 'completed', 3 * 86400000, 4);
  const oldest = await makeJob('oldest', 'completed', 80_000, 6);
  const newest = await makeJob('newest', 'completed', 40_000, 6);
  const running = await makeJob('running', 'running', 5 * 86400000, 20);
  const cancelling = await makeJob('cancelling', 'cancelling', 5 * 86400000, 20);
  await writeFile(path.join(outside, 'sentinel.txt'), 'safe');
  await symlink(outside, path.join(root, 'linked-job'), 'junction');
  const result = await cleanupArtifacts(root, { retentionDays: 2, maxTotalBytes: 40, currentJobId: 'newest' });
  assert.deepEqual(result.removed, ['expired', 'oldest']);
  await assert.rejects(() => access(expired));
  await assert.rejects(() => access(oldest));
  await access(newest); await access(running); await access(cancelling); await access(path.join(outside, 'sentinel.txt'));
  await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
});

test('validates transcript object and text contract', () => {
  assert.deepEqual(validateTranscript({ text: ' hello ' }), { text: 'hello' });
  assert.throws(() => validateTranscript(null), /must contain an object/);
  assert.throws(() => validateTranscript([]), /must contain an object/);
  assert.throws(() => validateTranscript({ text: '' }), /text must be a non-empty string/);
  assert.throws(() => validateTranscript({ text: '   ' }), /text must be a non-empty string/);
  assert.throws(() => validateTranscript({ text: 42 }), /text must be a non-empty string/);
});

test('rejects malformed transcript segments', () => {
  assert.deepEqual(validateTranscript({ text: 'ok', segments: [{ start: 0, end: 1, text: 'ok' }] }).segments?.length, 1);
  assert.throws(() => validateTranscript({ text: 'ok', segments: {} }), /segments must be an array/);
  assert.throws(() => validateTranscript({ text: 'ok', segments: [{ start: 0, text: 'missing end' }] }), /numeric start\/end and string text/);
  assert.throws(() => validateTranscript({ text: 'ok', segments: [{ start: 2, end: 1, text: 'backwards' }] }), /invalid start\/end range/);
});

test('reports missing and invalid transcript JSON explicitly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-video-test-'));
  const file = path.join(dir, 'transcript.json');
  await assert.rejects(() => readTranscript(file), /transcript.json is missing/);
  await writeFile(file, '{not json', 'utf8');
  await assert.rejects(() => readTranscript(file), /contains invalid JSON/);
  await writeFile(file, JSON.stringify({ text: '', segments: [] }), 'utf8');
  await assert.rejects(() => readTranscript(file), /text must be a non-empty string/);
});
