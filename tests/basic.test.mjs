import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { validateUrl, extractiveSummary, understand, run, cleanSubtitle, selectSubtitle, formatSrt, parseSubtitleCues, writeFileAtomic, writeSrtAtomic } from '../dist/index.js';

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

test('formats SRT timestamps across minutes, hours, rounding, multiline text, and blank cues', () => {
  const srt = formatSrt([{ start: 59.9996, end: 60.0014, text: '<i>跨分钟</i>\r\n第二行' }, { start: 3599.9996, end: 3600.5004, text: '跨小时' }, { start: 1, end: 2, text: '   ' }], 'job/example');
  assert.equal(srt, '1\r\n00:01:00,000 --> 00:01:00,001\r\n跨分钟\r\n第二行\r\n\r\n2\r\n01:00:00,000 --> 01:00:00,500\r\n跨小时\r\n');
});

test('parses cue settings and rejects invalid cue timestamps', () => {
  assert.deepEqual(parseSubtitleCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 position:10%\n<b>中文</b>'), [{ start: 1, end: 2, text: '中文' }]);
  assert.throws(() => parseSubtitleCues('00:61:00.000 --> 00:62:00.000\ntext'), /invalid subtitle timestamp/);
});

test('accepts overlapping and adjacent cues without changing their times', () => {
  const srt = formatSrt([{ start: 0, end: 2, text: 'first' }, { start: 1, end: 2, text: 'overlap' }, { start: 2, end: 3, text: 'adjacent' }], 'job/overlap');
  assert.match(srt, /00:00:01,000 --> 00:00:02,000/);
  assert.match(srt, /00:00:02,000 --> 00:00:03,000/);
});

test('rejects illegal timestamps and non-positive cue durations with job and segment', () => {
  for (const start of [-1, NaN, Infinity]) assert.throws(() => formatSrt([{ start, end: 2, text: 'bad' }], 'job/bad'), /job\/bad, segment 1/);
  assert.throws(() => formatSrt([{ start: 1, end: 1, text: 'bad' }], 'job/bad'), /segment 1/);
  assert.throws(() => formatSrt([{ start: 2, end: 1, text: 'bad' }], 'job/bad'), /segment 1/);
});

test('atomic artifact writes use same-directory UTF-8 temporary files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-atomic-'));
  for (const name of ['transcript.txt', 'transcript.srt', 'summary.md', 'metadata.json', 'transcript.json']) {
    const target = path.join(dir, name); const calls = [];
    await writeFileAtomic(target, '中文\r\ntext', {
      writeFile: async (file, data, encoding) => { calls.push(['write', file, data, encoding]); await fs.writeFile(file, data, encoding); },
      rename: async (from, to) => { calls.push(['rename', from, to]); await fs.rename(from, to); },
      unlink: async (file) => { calls.push(['unlink', file]); await fs.rm(file, { force: true }); }
    });
    assert.equal(await fs.readFile(target, 'utf8'), '中文\r\ntext');
    assert.equal(path.dirname(calls[0][1]), dir); assert.notEqual(calls[0][1], target);
    assert.match(path.basename(calls[0][1]), /^\.[^/]+-[0-9a-f-]+\.tmp$/i);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomic artifact write preserves rename error and suppresses cleanup error', async () => {
  const calls = [];
  await assert.rejects(() => writeFileAtomic('C:/job/summary.md', 'bad', {
    writeFile: async (file) => { calls.push(file); },
    rename: async () => { throw new Error('rename failed'); },
    unlink: async (file) => { calls.push('unlink:' + file); throw new Error('cleanup failed'); }
  }), /rename failed/);
  assert.match(calls[1], /^unlink:/);
});

test('atomic artifact write reports temporary write failure', async () => {
  await assert.rejects(() => writeFileAtomic('C:/job/metadata.json', 'bad', {
    writeFile: async () => { throw new Error('write failed'); },
    rename: async () => { throw new Error('must not rename'); },
    unlink: async () => undefined
  }), /write failed/);
});

test('fake subtitle pipeline adds yt-dlp limits and cleans temporary subtitles', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-'));
  const result = await understand({ url: 'https://example.test/video', summaryInstruction: 'focus' }, base(out));
  assert.deepEqual((await fs.readdir(result.jobDir)).sort(), ['metadata.json', 'summary.md', 'transcript.srt', 'transcript.txt']);
  assert.equal(JSON.parse(await fs.readFile(result.metadataPath, 'utf8')).srt.generated, true);
  assert.match(await fs.readFile(result.srtPath, 'utf8'), /00:01:59,500 --> 02:00:00,125/);
  await fs.rm(out, { recursive: true, force: true });
});

test('subtitle text without timestamps records the reason and omits SRT', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-no-timestamps-'));
  const result = await understand({ url: 'https://example.test/video' }, base(out, ['--no-timestamps']));
  const metadata = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'));
  assert.deepEqual(metadata.srt, { generated: false, reason: 'no valid timestamps' });
  assert.equal((await fs.readdir(result.jobDir)).includes('transcript.srt'), false);
  await fs.rm(out, { recursive: true, force: true });
});

test('fake whisper fallback keeps audio and transcript artifacts', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dvu-'));
  const result = await understand({ url: 'https://example.test/video' }, base(out, ['--fail-subs']));
  assert.equal(result.method, 'whisper');
  assert.equal(await fs.readFile(result.transcriptPath, 'utf8'), 'Fallback transcript.');
  assert.deepEqual((await fs.readdir(result.jobDir)).sort(), ['audio.wav', 'metadata.json', 'summary.md', 'transcript.json', 'transcript.srt', 'transcript.txt']);
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
