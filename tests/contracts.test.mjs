import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTranscript, understand, validateResourceConfig, validateTranscript } from '../dist/index.js';

test('rejects invalid resource configuration before starting a job', () => {
  for (const key of ['timeoutMs', 'outputLimitBytes', 'maxDurationSeconds', 'maxFileBytes', 'maxOutputBytes']) {
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
