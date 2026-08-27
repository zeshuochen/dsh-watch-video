#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageName = 'dsh-watch-video';
const requiredFiles = [
  'dist/index.js',
  'cordis.patch.yml',
  'requirements.txt',
  'scripts/bootstrap.ps1',
  'scripts/doctor.mjs',
  'scripts/transcribe.py',
  'README.md',
  'README.en.md',
  'README.zh.md',
  'LICENSE',
  'SECURITY.md',
  'CHANGELOG.md',
];
const forbiddenPathPatterns = [
  /^(?:src|tests|node_modules|\.git|\.venv)(?:\/|$)/,
  /(?:^|\/)(?:[^/]+\.(?:aac|flac|m4a|mp3|ogg|wav|webm|mkv|mp4|mov|avi)|[^/]*(?:model|whisper|cookie|token|api[-_]?key)[^/]*)$/i,
  /(?:^|\/)(?:[^/]+\.(?:tmp|temp|part|download|crdownload))$/i,
];

function check(condition, message) {
  assert.ok(condition, message);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function run(command, args, cwd) {
  const useWindowsShell = process.platform === 'win32' && command === 'npm';
  const executable = useWindowsShell ? (process.env.ComSpec || 'cmd.exe') : command;
  const executableArgs = useWindowsShell ? ['/d', '/s', '/c', 'npm ' + args.map((value) => value.includes(' ') ? '"' + value + '"' : value).join(' ')] : args;
  try {
    return await execFileAsync(executable, executableArgs, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    throw new Error('command failed (' + command + ' ' + args.join(' ') + '): ' + detail + (stderr ? ': ' + stderr : ''));
  }
}

async function installOfflinePeerStubs(packageRoot) {
  const modules = {
    '@deepseek-ai/dsh-tools': 'export function defineTool(value) { return value; }\n',
    '@deepseek-ai/schemastery': 'export default { object: (value) => value, string: () => ({ required() { return this; }, default() { return this; } }), number: () => ({ default() { return this; } }), array: () => ({}) };\n',
  };
  for (const [name, source] of Object.entries(modules)) {
    const moduleRoot = path.join(packageRoot, 'node_modules', name);
    await (await import('node:fs/promises')).mkdir(moduleRoot, { recursive: true });
    await writeFile(path.join(moduleRoot, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
    await writeFile(path.join(moduleRoot, 'index.js'), source);
  }
}

let tempRoot;
try {
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  check(rootPackage.name === packageName, 'root package name must remain dsh-watch-video');
  check(typeof rootPackage.version === 'string' && rootPackage.version.length > 0, 'root package version is required');

  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-watch-video-pack-'));
  const packResult = await run('npm', ['pack', '--json', '--pack-destination', tempRoot], repoRoot);
  const packInfo = JSON.parse(packResult.stdout);
  const tarballName = packInfo[0]?.filename;
  const expectedName = packageName + '-' + rootPackage.version + '.tgz';
  check(tarballName === expectedName, 'tarball filename must be ' + expectedName + ', got ' + tarballName);
  const tarballPath = path.join(tempRoot, tarballName);
  check(await exists(tarballPath), 'npm pack did not create ' + tarballName);

  const extractRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-watch-video-unpack-'));
  try {
    const tarExecutable = process.platform === 'win32' ? 'tar.exe' : 'tar';
    await run(tarExecutable, ['-xzf', tarballPath, '-C', extractRoot], repoRoot);
    const packageRoot = path.join(extractRoot, 'package');
    const entries = [];
    async function collect(current, relative = '') {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const childRelative = relative ? relative + '/' + entry.name : entry.name;
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) await collect(child, childRelative);
        else entries.push(childRelative.replaceAll('\\', '/'));
      }
    }
    await collect(packageRoot);
    for (const file of requiredFiles) check(entries.includes(file), 'missing from tarball: ' + file);
    for (const file of entries) for (const pattern of forbiddenPathPatterns) check(!pattern.test(file), 'forbidden tarball entry: ' + file);

    const packaged = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    check(packaged.name === packageName, 'packaged name mismatch');
    check(packaged.version === rootPackage.version, 'packaged version mismatch');
    for (const field of ['main', 'exports']) {
      const target = field === 'exports' ? packaged.exports['.'] : packaged.main;
      check(typeof target === 'string' && await exists(path.join(packageRoot, target)), field + ' target is missing');
    }
    const patchTarget = packaged.dsh?.bundle?.patch;
    check(typeof patchTarget === 'string' && await exists(path.join(packageRoot, patchTarget)), 'dsh.bundle.patch target is missing');
    check((await readFile(path.join(packageRoot, 'cordis.patch.yml'), 'utf8')).includes('dsh-watch-video'), 'cordis.patch.yml is unreadable');

    await run(process.execPath, ['--check', 'dist/index.js'], packageRoot);
    await writeFile(path.join(packageRoot, 'package-lock.json'), JSON.stringify({ name: packaged.name, version: packaged.version, lockfileVersion: 3, requires: true, packages: { '': { name: packaged.name, version: packaged.version } } }));
    await run(process.execPath, ['scripts/doctor.mjs', '--files-only'], packageRoot);
    await installOfflinePeerStubs(packageRoot);
    const imported = await import(pathToFileURL(path.join(packageRoot, 'dist/index.js')).href + '?clean-pack=' + Date.now());
    for (const key of ['name', 'inject', 'Config', 'apply']) check(key in imported, 'dist/index.js does not export ' + key);
    check(imported.name === packageName, 'dynamic import exported name mismatch');
    check(Array.isArray(imported.inject), 'dynamic import exported inject is not an array');
    check(typeof imported.apply === 'function', 'dynamic import exported apply is not a function');
    console.log('Clean package verification passed.');
    console.log('Tarball: ' + tarballName);
    console.log('Key files: ' + requiredFiles.join(', '));
    console.log('Dynamic import: name, inject, Config, apply verified; apply was not called.');
    console.log('No source, tests, dependencies, media, models, credentials, or temporary files were packaged.');
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
} catch (error) {
  console.error('Clean package verification failed: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
