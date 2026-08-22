import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { validateUrl, extractiveSummary, understand, run, cleanSubtitle, selectSubtitle } from '../dist/index.js';

const fake = path.resolve('tests/fake-ytdlp.mjs');
const base = (outputDir, extra = []) => ({ outputDir, ytDlpPath: process.execPath, ytDlpPrefixArgs: [fake, ...extra], pythonPath: process.execPath, transcribeScript: path.resolve('tests/fake-transcribe.mjs'), device: 'cpu', maxDurationSeconds: 90, maxFileBytes: 100, maxOutputBytes: 1024 });

test('run terminates a timed-out process tree', async () => {
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], process.cwd(), { timeoutMs: 25 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test('url rejects local and reserved IP literals', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '203.0.113.1', '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validateUrl('https://' + host + '/video'), /host/);
  }
  assert.throws(() => validateUrl('http://metadata.google.internal/video'), /metadata/);
  assert.throws(() => validateUrl('file:///x'));
  assert.throws(() => validateUrl('https://user:secret@example.test/video'), /credentials/);
  assert.equal(validateUrl('https://example.test/video').protocol, 'https:');
});

test('summary', () => assert.match(extractiveSummary('hello', 'focus'), /focus/));

test('subtitle selection prioritizes manual, requested language, then filename', () => {
  const files = [{ name: 'z.en.vtt', manual: false, language: 'en' }, { name: 'a.zh-CN.vtt', manual: false, language: 'zh-CN' }, { name: 'z.zh-Hans.vtt', manual: true, language: 'zh-Hans' }, { name: 'a.zh.vtt', manual: true, language: 'zh' }];
  assert.equal(selectSubtitle(files, 'zh-CN').name, 'a.zh.vtt');
  assert.equal(selectSubtitle(files.filter((file) => !file.manual), 'zh').name, 'a.zh-CN.vtt');
  assert.equal(selectSubtitle([{ name: 'b.en.vtt', language: 'en' }, { name: 'a.fr.vtt', language: 'fr' }], 'zh').name, 'a.fr.vtt');
});

test('subtitle parser handles VTT, SRT, metadata, tags, entities, and adjacent duplicates', () => {
  const vtt = 'WEBVTT\n\nNOTE comment\nignored\n\n1\n00:00:00,000 --> 00:00:01,000 align:start\n<b>Hello &amp; welcome</b>\n\n2\n00:00:01,000 --> 00:00:02,000\nHello &amp; welcome\n\nSTYLE\nignored';
  assert.equal(cleanSubtitle(vtt), 'Hello & welcome');
  assert.equal(cleanSubtitle('1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond'), 'First\nSecond');
  assert.equal(cleanSubtitle('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n'), '');
});

test('fake subtitle pipeline adds yt-dlp limits and cleans temporary subtitles', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-'));
  const result = await understand({ url: 'https://example.test/video', summaryInstruction: 'focus' }, base(out));
  assert.deepEqual((await fs.readdir(result.jobDir)).sort(), ['metadata.json', 'summary.md', 'transcript.txt']);
  assert.equal(JSON.parse(await fs.readFile(result.metadataPath, 'utf8')).status, 'completed');
  await fs.rm(out, { recursive: true, force: true });
});

test('fake whisper fallback keeps audio and transcript artifacts', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-'));
  const result = await understand({ url: 'https://example.test/video' }, base(out, ['--fail-subs']));
  assert.equal(result.method, 'whisper');
  assert.equal(await fs.readFile(result.transcriptPath, 'utf8'), 'Fallback transcript.');
  assert.deepEqual((await fs.readdir(result.jobDir)).sort(), ['audio.wav', 'metadata.json', 'summary.md', 'transcript.json', 'transcript.txt']);
  await fs.rm(out, { recursive: true, force: true });
});

test('failed task records metadata and removes partial files', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-'));
  await assert.rejects(() => understand({ url: 'https://example.test/video' }, base(out, ['--fail-subs', '--fail-audio'])));
  const [job] = await fs.readdir(out); const jobDir = path.join(out, job);
  const kept = await fs.readdir(jobDir); assert.deepEqual(kept, ['metadata.json']);
  const metadata = JSON.parse(await fs.readFile(path.join(jobDir, 'metadata.json'), 'utf8')); assert.equal(metadata.status, 'failed');
  await fs.rm(out, { recursive: true, force: true });
});

test('audio size is checked after yt-dlp', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-'));
  await assert.rejects(() => understand({ url: 'https://example.test/video' }, { ...base(out, ['--fail-subs', '--oversize']), maxFileBytes: 10 }), /maxFileBytes/);
  const [job] = await fs.readdir(out); assert.deepEqual(await fs.readdir(path.join(out, job)), ['metadata.json']);
  await fs.rm(out, { recursive: true, force: true });
});
