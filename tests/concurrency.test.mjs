import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { understand, cancelJob, getActiveJobIds } from '../dist/index.js';

const yt = path.resolve('tests/fake-ytdlp.mjs');
const transcribe = path.resolve('tests/fake-transcribe.mjs');
const failingTranscribe = path.resolve('tests/fake-transcribe-fail.mjs');
const config = (outputDir, maxConcurrentTranscriptions = 1, script = transcribe) => ({ outputDir, ytDlpPath: process.execPath, ytDlpPrefixArgs: [yt, '--fail-subs'], pythonPath: process.execPath, transcribeScript: script, device: 'cpu', maxDurationSeconds: 90, maxFileBytes: 100, maxOutputBytes: 1024, timeoutMs: 2000, maxConcurrentTranscriptions });
const maxActive = (events) => { let active = 0, maximum = 0; for (const line of events.trim().split('\n')) { active += line.startsWith('start ') ? 1 : -1; maximum = Math.max(maximum, active); } return maximum; };
const waitFor = async (predicate, timeoutMs = 1500) => { const end = Date.now() + timeoutMs; while (!(await predicate())) { if (Date.now() >= end) throw new Error('condition timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); } };
const startTracked = async (out, options = config(out, 1)) => { const before = new Set(getActiveJobIds()); const promise = understand({ url: 'https://example.test/video' }, options); await waitFor(() => getActiveJobIds().some((id) => !before.has(id))); return { promise, jobId: getActiveJobIds().find((id) => !before.has(id)) }; };

for (const limit of [1, 3]) test('fake runner respects transcription concurrency ' + limit, async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-concurrency-'));
  await fs.writeFile(path.join(out, 'fake-transcribe-control.json'), JSON.stringify({ delayMs: 80 }));
  await Promise.all(Array.from({ length: limit + 2 }, () => understand({ url: 'https://example.test/video' }, config(out, limit))));
  const events = await fs.readFile(path.join(out, 'fake-transcribe-events.log'), 'utf8');
  assert.ok(maxActive(events) <= limit, `observed ${maxActive(events)} concurrent transcriptions, limit was ${limit}`);
  assert.equal(events.trim().split('\n').length, 2 * (limit + 2));
  await fs.rm(out, { recursive: true, force: true });
});

test('subtitle jobs do not consume transcription slots', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-subtitle-slot-'));
  await fs.writeFile(path.join(out, 'fake-transcribe-control.json'), JSON.stringify({ delayMs: 150 }));
  const whisper = understand({ url: 'https://example.test/video' }, config(out, 1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const subtitleConfig = { ...config(out, 1), ytDlpPrefixArgs: [yt] };
  const subtitle = await understand({ url: 'https://example.test/video' }, subtitleConfig);
  assert.equal(subtitle.method, 'subtitles');
  await whisper;
  await fs.rm(out, { recursive: true, force: true });
});

test('cancelling a running transcribe process releases the FIFO slot', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-cancel-transcribe-'));
  await fs.writeFile(path.join(out, 'fake-transcribe-control.json'), JSON.stringify({ delayMs: 500 }));
  const current = await startTracked(out); const outcome = current.promise.catch((error) => error);
  await waitFor(async () => (await fs.readFile(path.join(out, 'fake-transcribe-events.log'), 'utf8').catch(() => '')).includes('start ' + current.jobId));
  const cancelled = await cancelJob(current.jobId); const error = await outcome;
  assert.match(error.message, /cancelled/); assert.equal(cancelled.status, 'cancelled');
  const jobDir = path.join(out, current.jobId); const metadata = JSON.parse(await fs.readFile(path.join(jobDir, 'metadata.json'), 'utf8'));
  assert.equal(metadata.status, 'cancelled'); assert.match(metadata.cancelReason, /user/); assert.deepEqual(await fs.readdir(jobDir), ['metadata.json']);
  const next = await understand({ url: 'https://example.test/video' }, { ...config(out, 1), timeoutMs: 2000 });
  assert.equal(next.method, 'whisper'); assert.equal(getActiveJobIds().includes(current.jobId), false);
  await fs.rm(out, { recursive: true, force: true });
});

test('cancelling a queued transcription removes it and lets the next task run', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-cancel-queued-'));
  await fs.writeFile(path.join(out, 'fake-transcribe-control.json'), JSON.stringify({ delayMs: 350 }));
  const first = await startTracked(out); const firstOutcome = first.promise.catch((error) => error);
  await waitFor(async () => (await fs.readFile(path.join(out, 'fake-transcribe-events.log'), 'utf8').catch(() => '')).includes('start ' + first.jobId));
  const second = await startTracked(out); const secondOutcome = second.promise.catch((error) => error);
  await waitFor(() => fs.access(path.join(out, second.jobId, 'audio.wav')).then(() => true, () => false));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeCancel = await fs.readFile(path.join(out, 'fake-transcribe-events.log'), 'utf8');
  assert.equal(beforeCancel.includes('start ' + second.jobId), false);
  const cancelResult = await cancelJob(second.jobId);
  const third = await startTracked(out);
  assert.match((await secondOutcome).message, /cancelled/); assert.equal(cancelResult.status, 'cancelled');
  assert.equal((await firstOutcome).method, 'whisper'); assert.equal((await third.promise).method, 'whisper');
  const events = await fs.readFile(path.join(out, 'fake-transcribe-events.log'), 'utf8');
  assert.equal(events.includes(second.jobId), false); assert.ok(events.includes(first.jobId)); assert.ok(events.includes(third.jobId));
  assert.deepEqual(await fs.readdir(path.join(out, second.jobId)), ['metadata.json']);
  await fs.rm(out, { recursive: true, force: true });
});

test('failed transcription releases the FIFO slot for the next task', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-release-'));
  await fs.writeFile(path.join(out, 'fake-transcribe-control.json'), JSON.stringify({ delayMs: 20 }));
  const failed = understand({ url: 'https://example.test/video' }, config(out, 1, failingTranscribe));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const next = understand({ url: 'https://example.test/video' }, config(out, 1));
  await assert.rejects(failed, /transcription failed/);
  assert.equal((await next).method, 'whisper');
  const events = await fs.readFile(path.join(out, 'fake-transcribe-events.log'), 'utf8');
  assert.deepEqual(events.trim().split('\n').map((line) => line.split(' ')[0]), ['start', 'end', 'start', 'end']);
  await fs.rm(out, { recursive: true, force: true });
});