import { execFile, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-video-understand';
export const inject = ['tools'];
export const Config = Schema.object({
  outputDir: Schema.string().required(), ytDlpPath: Schema.string(), pythonPath: Schema.string(),
  transcribeScript: Schema.string(), ytDlpPrefixArgs: Schema.array(String), pythonPrefixArgs: Schema.array(String),
  device: Schema.string().default('cuda'), computeType: Schema.string().default('int8_float16'), language: Schema.string(),
  timeoutMs: Schema.number().default(15 * 60 * 1000), outputLimitBytes: Schema.number(),
  maxDurationSeconds: Schema.number().default(60 * 60), maxFileBytes: Schema.number().default(500 * 1024 * 1024),
  maxOutputBytes: Schema.number().default(1024 * 1024),
});

const defaultTranscribeScript = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

function isBlockedIpv4(host: string) {
  const parts = host.split('.').map(Number);
  const n = parts.reduce((value, part) => value * 256 + part, 0);
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168)) ||
    (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) || parts[0] >= 224 ||
    n === 0x64400000 || (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) || n === 0xc0000200 || n === 0xc0000201 || n === 0xc0000202 || n === 0xc0000203;
}

function isBlockedIpv6(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('ff')) return true;
  if (normalized.startsWith('::ffff:')) {
    const hex = normalized.slice(7).split(':');
    if (hex.length === 2) return isBlockedIpv4([parseInt(hex[0].slice(0, 2), 16), parseInt(hex[0].slice(2), 16), parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2), 16)].join('.'));
  }
  const first = parseInt(normalized.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  const mapped = normalized.match(/^(?:0*:){5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i);
  return Boolean(mapped && isBlockedIpv4(mapped[1]));
}

export function validateUrl(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('url must not contain control characters');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url must use http or https');
  if (url.username || url.password) throw new Error('url must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = net.isIP(host);
  if ((ipVersion === 4 && isBlockedIpv4(host)) || (ipVersion === 6 && isBlockedIpv6(host))) {
    throw new Error('url host must not be localhost, loopback, private, link-local, metadata, or reserved IP');
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') throw new Error('url host must not be localhost or metadata');
  return url;
}

type RunResult = { ok: boolean; stdout: string; stderr: string; timedOut?: boolean; outputLimitExceeded?: boolean };

function terminateProcessTree(child: ReturnType<typeof spawn>) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

export function resolvePythonPath(pluginRoot = fileURLToPath(new URL('..', import.meta.url))) {
  const candidates = process.platform === 'win32'
    ? [path.join(pluginRoot, '.venv', 'Scripts', 'python.exe'), path.join(pluginRoot, '.venv', 'bin', 'python')]
    : [path.join(pluginRoot, '.venv', 'bin', 'python'), path.join(pluginRoot, '.venv', 'Scripts', 'python.exe')];
  return candidates.find((candidate) => existsSync(candidate)) || 'python';
}

export function run(file: string, args: string[], cwd: string, options: { timeoutMs?: number; outputLimitBytes?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise<RunResult>((resolve) => {
    let settled = false, stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, timedOut = false, outputLimitExceeded = false;
    const child = spawn(file, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (kind === 'stdout') { stdoutBytes += chunk.byteLength; stdout += text; } else { stderrBytes += chunk.byteLength; stderr += text; }
      if (stdoutBytes > outputLimitBytes || stderrBytes > outputLimitBytes) { outputLimitExceeded = true; terminateProcessTree(child); }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => finish({ ok: false, stdout, stderr: stderr || error.message, timedOut, outputLimitExceeded }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut && !outputLimitExceeded, stdout, stderr: timedOut ? (stderr || 'process timed out') : outputLimitExceeded ? (stderr || 'process output exceeded limit') : stderr, timedOut, outputLimitExceeded }));
    const timer = setTimeout(() => { timedOut = true; terminateProcessTree(child); }, timeoutMs);
  });
}

export function extractiveSummary(text: string, instruction = '') {
  return '# Video Summary\n\n<!-- summaryInstruction: ' + instruction.replace(/-->/g, '') + ' -->\n\n' + text.split(/\n+/).filter(Boolean).slice(0, 24).map((line) => '- ' + line).join('\n') + '\n';
}
const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function decodeEntities(text: string) { return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => HTML_ENTITIES[entity]); }
export function cleanSubtitle(source: string, format?: string) {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let skip = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) { skip = true; continue; }
    if (!line) { skip = false; continue; }
    if (skip || /^WEBVTT(?:\s|$)/i.test(line) || /^X-TIMESTAMP-MAP=/i.test(line)) continue;
    if (/^\d+$/.test(line) || /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(line) || /-->/.test(line)) continue;
    const cleaned = decodeEntities(line.replace(/<[^>]*>/g, '').replace(/\s+$/g, '').trim());
    if (cleaned && output[output.length - 1] !== cleaned) output.push(cleaned);
  }
  return output.join('\n').trim();
}
function languageMatches(candidate: string, requested?: string) {
  if (!requested) return false;
  const a = candidate.toLowerCase().replace(/_/g, '-'); const b = requested.toLowerCase().replace(/_/g, '-');
  return a === b || a.split('-')[0] === b.split('-')[0];
}
export type SubtitleFile = { name: string; manual?: boolean; language?: string };
export function selectSubtitle(files: SubtitleFile[], requested?: string) {
  return [...files].sort((a, b) => {
    const manual = Number(Boolean(b.manual)) - Number(Boolean(a.manual));
    if (manual) return manual;
    const language = Number(languageMatches(b.language || '', requested)) - Number(languageMatches(a.language || '', requested));
    if (language) return language;
    return a.name.localeCompare(b.name);
  })[0];
}
async function transcribe(audio: string, config: any, jobDir: string) {
  const transcriptPath = path.join(jobDir, 'transcript.json'); const device = config.device || 'cuda';
  return run(config.pythonPath || resolvePythonPath(), [...(config.pythonPrefixArgs || []), config.transcribeScript || defaultTranscribeScript, '--audio', audio, '--output', transcriptPath, '--device', device, '--compute-type', device === 'cpu' ? 'int8' : (config.computeType || 'int8_float16')], jobDir, { timeoutMs: config.timeoutMs, outputLimitBytes: config.maxOutputBytes ?? config.outputLimitBytes });
}
const tempNames = (name: string) => name.endsWith('.vtt') || name.endsWith('.srt') || name.startsWith('source.') || name === 'yt-args.json';

export async function understand(args: any, config: any) {
  const url = validateUrl(args.url); const jobId = crypto.randomUUID(); const jobDir = path.join(config.outputDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const metadata: any = { url: url.href, jobId, status: 'running', method: 'subtitles' }; const metadataPath = path.join(jobDir, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  const runOptions = { timeoutMs: config.timeoutMs, outputLimitBytes: config.maxOutputBytes ?? config.outputLimitBytes };
  const limits = ['--no-playlist', '--match-filter', 'duration <= ' + (config.maxDurationSeconds ?? 3600), '--max-filesize', String(config.maxFileBytes ?? 500 * 1024 * 1024)];
  try {
    const subtitleArgs = [...limits, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '-o', path.join(jobDir, 'source.%(ext)s'), url.href];
    let result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), ...subtitleArgs], jobDir, runOptions); let text = '';
    const subtitleNames = (await fs.readdir(jobDir)).filter((n) => /\.(?:vtt|srt)$/i.test(n));
    const subtitle = selectSubtitle(subtitleNames.map((name) => ({ name, manual: !/\.auto\./i.test(name), language: name.match(/\.([A-Za-z]{2,}(?:-[A-Za-z0-9]+)?)\.(?:vtt|srt)$/i)?.[1] })), config.language);
    if (subtitle) text = cleanSubtitle(await fs.readFile(path.join(jobDir, subtitle.name), 'utf8'), path.extname(subtitle.name));
    if (!result.ok || !text) {
      metadata.method = 'whisper'; const audio = path.join(jobDir, 'audio.wav');
      result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), ...limits, '-x', '--audio-format', 'wav', '-o', audio, url.href], jobDir, runOptions);
      if (!result.ok) throw new Error(result.stderr || 'yt-dlp audio extraction failed');
      const audioSize = (await fs.stat(audio)).size; if (audioSize > (config.maxFileBytes ?? 500 * 1024 * 1024)) throw new Error('audio output exceeded maxFileBytes');
      result = await transcribe(audio, config, jobDir); if (!result.ok) throw new Error(result.stderr || 'transcription failed');
      const parsed = JSON.parse(await fs.readFile(path.join(jobDir, 'transcript.json'), 'utf8')); text = typeof parsed.text === 'string' ? parsed.text.trim() : ''; if (!text) throw new Error('transcription produced empty text');
    }
    const transcriptPath = path.join(jobDir, 'transcript.txt'); const summaryPath = path.join(jobDir, 'summary.md');
    await fs.writeFile(transcriptPath, text); await fs.writeFile(summaryPath, extractiveSummary(text, args.summaryInstruction));
    for (const item of await fs.readdir(jobDir)) if (tempNames(item) || (!['audio.wav', 'transcript.txt', 'transcript.json', 'summary.md', 'metadata.json'].includes(item))) await fs.rm(path.join(jobDir, item), { recursive: true, force: true });
    metadata.status = 'completed'; await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    return { jobDir, method: metadata.method, transcriptPath, summaryPath, metadataPath, transcriptSummary: text.slice(0, 240) };
  } catch (error) {
    metadata.status = 'failed'; metadata.error = error instanceof Error ? error.message : String(error);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    throw error;
  } finally {
    for (const item of await fs.readdir(jobDir).catch(() => [])) if (tempNames(item) || item.startsWith('source.') || (metadata.status === 'failed' && ['audio.wav', 'transcript.json'].includes(item))) await fs.rm(path.join(jobDir, item), { recursive: true, force: true });
  }
}
const output = { schema: { type: 'object', additionalProperties: false, properties: { jobDir: { type: 'string' }, method: { type: 'string', enum: ['subtitles', 'whisper'] }, transcriptPath: { type: 'string' }, summaryPath: { type: 'string' }, metadataPath: { type: 'string' }, transcriptSummary: { type: 'string' } }, required: ['jobDir', 'method', 'transcriptPath', 'summaryPath', 'metadataPath', 'transcriptSummary'] }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
export function apply(ctx: any, config: any) { ctx.tools.register((defineTool as any)({ name: 'dsh_video_understand', description: 'Transcribe and summarize a video, preferring available subtitles.', parameters: { url: { type: 'string', required: true }, summaryInstruction: { type: 'string' } }, output, execute: (args: any) => understand(args, config) })); }
