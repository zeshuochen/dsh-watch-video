import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import process from 'node:process';
import { run } from '../dist/index.js';

const fake = path.resolve('tests/fake-output.mjs');
const invoke = (args, options = {}) => run(process.execPath, [fake, ...args], process.cwd(), options);

test('retains stdout prefix and stderr tail by byte cap', async () => {
  const result = await invoke(['--stdout=prefix-中文-😀-suffix', '--stderr=error-tail-中文-😀', '--repeat=1'], { outputLimitBytes: 13, timeoutMs: 1000 });
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdoutBytes, Buffer.byteLength('prefix-中文-😀-suffix'));
  assert.equal(result.stderrBytes, Buffer.byteLength('error-tail-中文-😀'));
  assert.equal(result.stdoutStrategy, 'prefix'); assert.equal(result.stderrStrategy, 'tail');
  assert.equal(result.stdout, 'prefix-中文');
  assert.match(result.stderr, /中文-😀$/); assert.match(result.diagnosticMessage, /exceeded limit/);
});

test('cumulative flood exceeds cap while streams continue draining', async () => {
  const result = await invoke(['--stdout=x', '--stderr=y', '--repeat=10000', '--continued'], { outputLimitBytes: 32, timeoutMs: 1000 });
  assert.equal(result.outputLimitExceeded, true);
  assert.ok(result.stdoutBytes > 32); assert.ok(result.stderrBytes > 32);
  assert.equal(result.terminationReason, 'outputLimitExceeded');
});

test('handles UTF-8 boundaries, timeout and cancellation safely', async () => {
  const utf = await invoke(['--stdout=中文😀'], { outputLimitBytes: 100, timeoutMs: 1000 });
  assert.equal(utf.stdout, '中文😀');
  const timeout = await invoke(['--sleep=1000'], { timeoutMs: 20 });
  assert.equal(timeout.timedOut, true); assert.equal(timeout.terminationReason, 'timeout');
  const controller = new AbortController(); const task = invoke(['--sleep=1000'], { timeoutMs: 1000, signal: controller.signal }); controller.abort();
  const cancelled = await task; assert.equal(cancelled.cancelled, true); assert.equal(cancelled.terminationReason, 'cancel');
});

test('reports ENOENT, nonzero and signal without unsafe command details', async () => {
  const missing = await run('definitely-not-a-real-command-dsh', [], process.cwd(), { timeoutMs: 1000 });
  assert.equal(missing.ok, false); assert.ok(missing.errorCode); assert.equal('command' in missing, false); assert.equal('env' in missing, false);
  const nonzero = await invoke(['--stderr=bad', '--exit=7'], { timeoutMs: 1000 });
  assert.equal(nonzero.exitCode, 7); assert.equal(nonzero.ok, false); assert.equal(nonzero.stderr, 'bad');
  const signalled = await invoke(['--signal=SIGTERM'], { timeoutMs: 1000 });
  assert.equal(signalled.ok, false); assert.ok(signalled.signal === 'SIGTERM' || signalled.exitCode !== 0);
});
