#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const filesOnly = process.argv.includes('--files-only');
const requiredFiles = ['package.json', 'package-lock.json', 'requirements.txt', 'scripts/bootstrap.ps1', 'scripts/transcribe.py'];

async function exists(relativePath) {
  try {
    await access(join(root, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function version(command, args) {
  try {
    const result = await execFileAsync(command, args, { windowsHide: true, timeout: 10000 });
    return result.stdout.trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

const missingFiles = (await Promise.all(requiredFiles.map(async (file) => (await exists(file) ? null : file)))).filter(Boolean);
if (missingFiles.length) {
  console.error('Missing required files:');
  for (const file of missingFiles) console.error(' - ' + file);
  process.exitCode = 1;
}
if (filesOnly) {
  if (!missingFiles.length) console.log('Required bootstrap and dependency files are present.');
  process.exit();
}

const checks = [
  ['Node.js', process.execPath, ['--version'], 'Install Node.js 20+ from https://nodejs.org/.'],
  ['Python', process.platform === 'win32' ? 'py' : 'python', process.platform === 'win32' ? ['-3', '--version'] : ['--version'], 'Install Python 3.10+ from https://www.python.org/downloads/.'],
  ['yt-dlp', 'yt-dlp', ['--version'], 'Install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation.'],
  ['ffmpeg', 'ffmpeg', ['-version'], 'Install ffmpeg: https://ffmpeg.org/download.html.']
];
let failed = missingFiles.length > 0;
for (const [label, command, args, hint] of checks) {
  const output = await version(command, args);
  if (output) console.log('OK ' + label + ': ' + output);
  else {
    failed = true;
    console.error('Missing ' + label + '. ' + hint);
  }
}
if (!failed) console.log('Doctor checks passed. No media or Whisper model was downloaded.');
process.exitCode = failed ? 1 : 0;
