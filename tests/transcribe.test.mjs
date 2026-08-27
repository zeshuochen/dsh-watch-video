import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('scripts/transcribe.py');

async function runWithFakeWhisper(source, args) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-transcribe-protocol-'));
  const moduleDir = path.join(root, 'fake');
  const output = path.join(root, 'transcript.json');
  await (await import('node:fs/promises')).mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, 'faster_whisper.py'), source, 'utf8');
  const result = spawnSync(process.env.PYTHON || 'python', [script, '--audio', path.join(root, 'audio.wav'), '--output', output, ...args], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: moduleDir },
    encoding: 'utf8',
  });
  return { root, output, result };
}

test('reports bounded CUDA fallback context as parseable JSON', async () => {
  const run = await runWithFakeWhisper(
    String.raw`class Info:
    language = 'en'
class Segment:
    start = 0
    end = 1
    text = 'offline fallback'
class WhisperModel:
    def __init__(self, model, device, compute_type):
        if device == 'cuda':
            raise RuntimeError('CUDA initialization failed at C:/private/token-abcdefghijklmnopqrstuvwxyz123456')
    def transcribe(self, audio):
        return [Segment()], Info()
`,
    ['--model', 'large-v3'],
  );
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const events = run.result.stderr.trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.code), ['CUDA_INIT_FAILED', 'CPU_FALLBACK_SUCCEEDED']);
    assert.deepEqual(events[0], { event: 'transcription', code: 'CUDA_INIT_FAILED', context: 'cuda', from_device: 'cuda', to_device: 'cpu', compute_type: 'int8' });
    assert.deepEqual(events[1], { event: 'transcription', code: 'CPU_FALLBACK_SUCCEEDED', context: 'cpu_fallback', device: 'cpu', compute_type: 'int8' });
    assert.equal(run.result.stderr.includes('C:/private'), false);
    assert.equal(run.result.stderr.includes('token-'), false);
    assert.deepEqual(JSON.parse(await readFile(run.output, 'utf8')).text, 'offline fallback');
  } finally { await rm(run.root, { recursive: true, force: true }); }
});

test('reports final fallback failure without traceback and preserves existing output', async () => {
  const run = await runWithFakeWhisper(
    String.raw`class WhisperModel:
    def __init__(self, model, device, compute_type):
        if device == 'cuda':
            raise RuntimeError('CUDA initialization failed')
        raise RuntimeError('CPU failed with secret=super-secret-token')
`,
    [],
  );
  try {
    await writeFile(run.output, '{\"text\":\"old\"}\n', 'utf8');
    // Re-run after creating the sentinel so a failed transcription cannot replace it.
    run.result = spawnSync(process.env.PYTHON || 'python', [script, '--audio', path.join(run.root, 'audio.wav'), '--output', run.output], {
      cwd: run.root,
      env: { ...process.env, PYTHONPATH: path.join(run.root, 'fake') },
      encoding: 'utf8',
    });
    assert.equal(run.result.status, 1);
    const events = run.result.stderr.trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.code), ['CUDA_INIT_FAILED', 'TRANSCRIPTION_FAILED']);
    assert.equal(events[1].context, 'cpu_fallback');
    assert.ok(events[1].message.length <= 240);
    assert.equal(run.result.stderr.includes('Traceback'), false);
    assert.equal(run.result.stderr.includes('super-secret-token'), false);
    assert.equal(await readFile(run.output, 'utf8'), '{\"text\":\"old\"}\n');
  } finally { await rm(run.root, { recursive: true, force: true }); }
});
