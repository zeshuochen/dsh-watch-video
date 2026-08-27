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
  retentionDays: Schema.number().default(30), maxTotalBytes: Schema.number().default(10 * 1024 * 1024 * 1024),
  maxConcurrentTranscriptions: Schema.number().default(1),
});

const defaultTranscribeScript = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

const RESOURCE_LIMITS = {
  timeoutMs: [1, 24 * 60 * 60 * 1000],
  outputLimitBytes: [1, 64 * 1024 * 1024],
  maxDurationSeconds: [1, 24 * 60 * 60],
  maxFileBytes: [1, 10 * 1024 * 1024 * 1024],
  maxOutputBytes: [1, 64 * 1024 * 1024],
  retentionDays: [1, 3650],
  maxTotalBytes: [1, 100 * 1024 * 1024 * 1024],
  maxConcurrentTranscriptions: [1, 4],
} as const;

export function validateResourceConfig(config: Record<string, unknown>) {
  for (const [name, bounds] of Object.entries(RESOURCE_LIMITS)) {
    const value = config[name];
    if (value === undefined) continue;
    const [minimum, maximum] = bounds;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error('invalid configuration: ' + name + ' must be a finite positive integer between ' + minimum + ' and ' + maximum);
    }
  }
}

export type TranscriptSegment = { start: number; end: number; text: string };
export type Transcript = { text: string; segments?: TranscriptSegment[] };
export type SubtitleCue = TranscriptSegment;

function parseTimestamp(value: string): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match) throw new Error('invalid subtitle timestamp: ' + value);
  const hours = Number(match[1]); const minutes = Number(match[2]); const seconds = Number(match[3]); const milliseconds = Number(match[4]);
  if (minutes >= 60 || seconds >= 60 || !Number.isFinite(hours)) throw new Error('invalid subtitle timestamp: ' + value);
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function cleanCueText(lines: string[]) {
  return lines.map((line) => decodeEntities(line.replace(/<[^>]*>/g, '').trim())).join('\n').trim();
}

export function parseSubtitleCues(source: string): SubtitleCue[] {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: SubtitleCue[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index++; continue; }
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) { index++; while (index < lines.length && lines[index].trim()) index++; continue; }
    if (/^WEBVTT(?:\s|$)/i.test(line)) { index++; continue; }
    const match = /^(\d{2,}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/.exec(line);
    if (!match) { index++; continue; }
    const start = parseTimestamp(match[1]); const end = parseTimestamp(match[2]);
    const textLines: string[] = []; index++;
    while (index < lines.length && lines[index].trim()) { textLines.push(lines[index]); index++; }
    const text = cleanCueText(textLines);
    if (text) cues.push({ start, end, text });
    else if (end <= start) throw new Error('invalid subtitle cue time range');
  }
  return cues;
}

function formatSrtTimestamp(seconds: number) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('invalid SRT timestamp');
  const millisecondsTotal = Math.round(seconds * 1000);
  const hours = Math.floor(millisecondsTotal / 3_600_000); const minutes = Math.floor(millisecondsTotal / 60_000) % 60;
  const secs = Math.floor(millisecondsTotal / 1000) % 60; const milliseconds = millisecondsTotal % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':') + ',' + String(milliseconds).padStart(3, '0');
}

export function formatSrt(segments: TranscriptSegment[], jobPath = 'job') {
  const cues: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === null || typeof segment !== 'object' || typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0 || typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end <= segment.start || typeof segment.text !== 'string') {
      throw new Error('invalid subtitle segment for job ' + jobPath + ', segment ' + (index + 1));
    }
    const text = cleanCueText(segment.text.replace(/\r\n?/g, '\n').split('\n'));
    if (!text) continue;
    const start = formatSrtTimestamp(segment.start); const end = formatSrtTimestamp(segment.end);
    if (start === end) throw new Error('invalid subtitle segment for job ' + jobPath + ', segment ' + (index + 1) + ': rounded end must be greater than start');
    cues.push(String(cues.length + 1) + '\r\n' + start + ' --> ' + end + '\r\n' + text.replace(/\n/g, '\r\n'));
  }
  return cues.length ? cues.join('\r\n\r\n') + '\r\n' : '';
}

export type AtomicFileOps = {
  writeFile: (file: string, data: string, encoding: 'utf8') => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  copyFile?: (from: string, to: string) => Promise<void>;
  unlink: (file: string) => Promise<void>;
  platform?: NodeJS.Platform;
};

function isWindowsReplaceError(error: unknown, platform = process.platform) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return platform === 'win32' && (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY');
}

export function createDefaultAtomicFileOps(platform: NodeJS.Platform = process.platform): AtomicFileOps {
  return {
    platform,
    writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding),
    rename: (from, to) => fs.rename(from, to),
    copyFile: (from, to) => fs.copyFile(from, to),
    unlink: (file) => fs.rm(file, { force: true })
  };
}

/**
 * Replaces through rename first. Windows has no public Node binding for the
 * strict ReplaceFileW operation; its fallback copies over the target and is
 * therefore compatibility-only, not a strict atomic replacement.
 */
export async function writeFileAtomic(filePath: string, content: string, ops: AtomicFileOps = createDefaultAtomicFileOps()) {
  const temporary = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '-' + crypto.randomUUID() + '.tmp');
  try {
    await ops.writeFile(temporary, content, 'utf8');
    try {
      await ops.rename(temporary, filePath);
    } catch (error) {
      if (!isWindowsReplaceError(error, ops.platform) || !ops.copyFile) throw error;
      await ops.copyFile(temporary, filePath);
      await ops.unlink(temporary);
    }
  } catch (error) {
    await ops.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeSrtAtomic(filePath: string, content: string, ops?: AtomicFileOps) {
  return writeFileAtomic(filePath, content, ops);
}

type CleanupEntry = { name: string; fullPath: string; modifiedAt: number; size: number; running: boolean; deletable: boolean };

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(fullPath);
    else if (entry.isFile()) total += (await fs.stat(fullPath)).size;
  }
  return total;
}

/** Remove only safe, non-running job directories before starting a new job. */
export async function cleanupArtifacts(outputDir: string, options: { retentionDays?: number; maxTotalBytes?: number; currentJobId?: string; now?: number } = {}) {
  validateResourceConfig({ retentionDays: options.retentionDays, maxTotalBytes: options.maxTotalBytes });
  const root = path.resolve(outputDir);
  const now = options.now ?? Date.now();
  const retentionDays = options.retentionDays ?? 30;
  const maxTotalBytes = options.maxTotalBytes ?? 10 * 1024 * 1024 * 1024;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const entries: CleanupEntry[] = [];
  let total = 0;
  for (const item of await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const fullPath = path.resolve(root, item.name);
    if (path.dirname(fullPath) !== root) continue;
    let metadata: any;
    try {
      metadata = JSON.parse(await fs.readFile(path.join(fullPath, 'metadata.json'), 'utf8'));
      if (metadata.jobId !== item.name) continue;
    } catch { continue; }
    const stat = await fs.stat(fullPath);
    const size = await directorySize(fullPath);
    total += size;
    entries.push({ name: item.name, fullPath, modifiedAt: stat.mtimeMs, size, running: metadata.status === 'running' || metadata.status === 'cancelling', deletable: !['running', 'cancelling'].includes(metadata.status) && item.name !== options.currentJobId });
  }
  entries.sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name));
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.deletable || (entry.modifiedAt >= cutoff && total <= maxTotalBytes)) continue;
    await fs.rm(entry.fullPath, { recursive: true, force: true });
    total -= entry.size;
    removed.push(entry.name);
  }
  return { removed, totalBytes: total };
}

export function validateTranscript(value: unknown): Transcript {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('transcript protocol error: transcript.json must contain an object');
  const transcript = value as Record<string, unknown>;
  if (typeof transcript.text !== 'string' || !transcript.text.trim()) throw new Error('transcript protocol error: text must be a non-empty string');
  if (transcript.segments === undefined) return { text: transcript.text.trim() };
  if (!Array.isArray(transcript.segments)) throw new Error('transcript protocol error: segments must be an array');
  for (const [index, segment] of transcript.segments.entries()) {
    if (segment === null || typeof segment !== 'object' || Array.isArray(segment)) throw new Error('transcript protocol error: segments[' + index + '] must be an object with start, end, and text');
    const item = segment as Record<string, unknown>;
    if (typeof item.start !== 'number' || !Number.isFinite(item.start) || typeof item.end !== 'number' || !Number.isFinite(item.end) || typeof item.text !== 'string') throw new Error('transcript protocol error: segments[' + index + '] must contain numeric start/end and string text');
    if (item.start < 0 || item.end <= item.start) throw new Error('transcript protocol error: segments[' + index + '] has invalid start/end range');
  }
  return { text: transcript.text.trim(), segments: transcript.segments as Transcript['segments'] };
}

export async function readTranscript(transcriptPath: string) {
  let raw: string;
  try { raw = await fs.readFile(transcriptPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('transcript protocol error: transcript.json is missing'); throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('transcript protocol error: transcript.json contains invalid JSON'); }
  return validateTranscript(parsed);
}

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

type RunResult = { ok: boolean; stdout: string; stderr: string; timedOut?: boolean; outputLimitExceeded?: boolean; cancelled?: boolean };

export class JobCancelledError extends Error {
  constructor() { super('job cancelled by user'); this.name = 'JobCancelledError'; }
}

function throwIfCancelled(signal?: AbortSignal) { if (signal?.aborted) throw new JobCancelledError(); }

export type TerminationOps = { platform?: NodeJS.Platform; taskkill?: (pid: number) => void; killGroup?: (pid: number) => void; killChild?: () => void };
export function terminateProcessTree(child: ReturnType<typeof spawn>, ops: TerminationOps = {}) {
  if (child.pid === undefined) return;
  const platform = ops.platform ?? process.platform;
  if (platform === 'win32') {
    if (ops.taskkill) ops.taskkill(child.pid);
    else execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) child.kill('SIGKILL'); });
    return;
  }
  try { if (ops.killGroup) ops.killGroup(child.pid); else process.kill(-child.pid, 'SIGKILL'); }
  catch { if (ops.killChild) ops.killChild(); else child.kill('SIGKILL'); }
}

export function resolvePythonPath(pluginRoot = fileURLToPath(new URL('..', import.meta.url))) {
  const candidates = process.platform === 'win32'
    ? [path.join(pluginRoot, '.venv', 'Scripts', 'python.exe'), path.join(pluginRoot, '.venv', 'bin', 'python')]
    : [path.join(pluginRoot, '.venv', 'bin', 'python'), path.join(pluginRoot, '.venv', 'Scripts', 'python.exe')];
  return candidates.find((candidate) => existsSync(candidate)) || 'python';
}

export function run(file: string, args: string[], cwd: string, options: { timeoutMs?: number; outputLimitBytes?: number; signal?: AbortSignal } = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise<RunResult>((resolve) => {
    let settled = false, stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, timedOut = false, outputLimitExceeded = false, cancelled = false;
    if (options.signal?.aborted) { resolve({ ok: false, stdout, stderr: 'job cancelled by user', cancelled: true }); return; }
    const child = spawn(file, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => { cancelled = true; terminateProcessTree(child); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve(result); } };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (kind === 'stdout') { stdoutBytes += chunk.byteLength; stdout += text; } else { stderrBytes += chunk.byteLength; stderr += text; }
      if (stdoutBytes > outputLimitBytes || stderrBytes > outputLimitBytes) { outputLimitExceeded = true; terminateProcessTree(child); }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk)); child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => finish({ ok: false, stdout, stderr: stderr || error.message, timedOut, outputLimitExceeded }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut && !outputLimitExceeded && !cancelled, stdout, stderr: cancelled ? 'job cancelled by user' : timedOut ? (stderr || 'process timed out') : outputLimitExceeded ? (stderr || 'process output exceeded limit') : stderr, timedOut, outputLimitExceeded, cancelled }));
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
type SemaphoreWaiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; signal?: AbortSignal; onAbort?: () => void; settled: boolean };

export class FifoSemaphore {
  private available: number;
  private readonly queue: SemaphoreWaiter[] = [];
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw new Error('invalid semaphore capacity');
    this.available = capacity;
  }
  acquire(timeoutMs: number, signal?: AbortSignal) {
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, settled: false, signal };
      const rejectWaiter = (error: Error) => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(error);
        this.drain();
      };
      waiter.onAbort = () => rejectWaiter(new JobCancelledError());
      waiter.timer = setTimeout(() => rejectWaiter(new Error('transcription queue wait timed out')), timeoutMs);
      if (signal?.aborted) { rejectWaiter(new JobCancelledError()); return; }
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }
  private drain() {
    while (this.available > 0 && this.queue.length) {
      const waiter = this.queue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
      this.available--;
      let released = false;
      waiter.resolve(() => { if (!released) { released = true; this.available++; this.drain(); } });
    }
  }
}

const transcriptionSemaphores = new Map<number, FifoSemaphore>();
function getTranscriptionSemaphore(config: any) {
  const capacity = config.maxConcurrentTranscriptions ?? 1;
  let semaphore = transcriptionSemaphores.get(capacity);
  if (!semaphore) { semaphore = new FifoSemaphore(capacity); transcriptionSemaphores.set(capacity, semaphore); }
  return semaphore;
}

async function transcribe(audio: string, config: any, jobDir: string, signal?: AbortSignal) {
  const release = await getTranscriptionSemaphore(config).acquire(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
  try {
    const transcriptPath = path.join(jobDir, 'transcript.json'); const device = config.device || 'cuda';
    return await run(config.pythonPath || resolvePythonPath(), [...(config.pythonPrefixArgs || []), config.transcribeScript || defaultTranscribeScript, '--audio', audio, '--output', transcriptPath, '--device', device, '--compute-type', device === 'cpu' ? 'int8' : (config.computeType || 'int8_float16')], jobDir, { timeoutMs: config.timeoutMs, outputLimitBytes: config.maxOutputBytes ?? config.outputLimitBytes, signal });
  } finally {
    release();
  }
}
const tempNames = (name: string) => name.startsWith('source.') || name === 'yt-args.json' || /^\.(?:transcript\.json|transcript\.txt|summary\.md|transcript\.srt|metadata\.json)-[0-9a-f-]+\.tmp$/i.test(name);

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'not_found';
export type JobPhase = 'queued' | 'probing_subtitles' | 'downloading_audio' | 'transcribing' | 'writing_artifacts' | 'completed' | 'failed' | 'cancelled';
export type JobStatusSummary = {
  jobId: string; status: JobStatus; phase: JobPhase; createdAt: string; updatedAt: string;
  method: 'subtitles' | 'whisper' | null; progress: number | null; message: string; found: true;
};
type ActiveJob = { controller: AbortController; phase: 'running' | 'cancelling' | 'completing' | 'failing' | FinalJobPhase; done: Promise<void>; finish: () => void; summary: JobStatusSummary };
type FinalJobPhase = 'completed' | 'failed' | 'cancelled';
const activeJobs = new Map<string, ActiveJob>();
const finishedJobs = new Map<string, JobStatusSummary>();
const MAX_FINISHED_JOBS = 1000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getActiveJobIds() { return [...activeJobs.keys()]; }

function snapshot(summary: JobStatusSummary): JobStatusSummary { return { ...summary }; }
function notFoundStatus(jobId: string) {
  return { jobId, status: 'not_found' as JobStatus, phase: 'failed' as JobPhase, createdAt: '', updatedAt: '', method: null, progress: null, message: 'job not found', found: false };
}
export function getJobStatus(jobId: string): JobStatusSummary | (ReturnType<typeof notFoundStatus>) {
  if (!JOB_ID_PATTERN.test(jobId)) return notFoundStatus(jobId);
  const active = activeJobs.get(jobId); if (active) return snapshot(active.summary);
  const finished = finishedJobs.get(jobId); return finished ? snapshot(finished) : notFoundStatus(jobId);
}
export function listJobs() { return [...activeJobs.values()].map((job) => snapshot(job.summary)).concat([...finishedJobs.values()].map(snapshot)); }
function updateSummary(job: ActiveJob, patch: Partial<Pick<JobStatusSummary, 'phase' | 'status' | 'method' | 'progress' | 'message'>>) {
  Object.assign(job.summary, patch, { updatedAt: new Date().toISOString() });
}
function rememberFinished(jobId: string, summary: JobStatusSummary) {
  finishedJobs.set(jobId, snapshot(summary));
  while (finishedJobs.size > MAX_FINISHED_JOBS) finishedJobs.delete(finishedJobs.keys().next().value!);
}

function claimCompletion(job: ActiveJob) {
  if (job.phase !== 'running') return false;
  job.phase = 'completing';
  return true;
}

export async function cancelJob(jobId: string) {
  if (!JOB_ID_PATTERN.test(jobId)) return { jobId, status: 'not_found', cancelled: false, message: 'job not found' };
  const job = activeJobs.get(jobId);
  if (!job) {
    const summary = finishedJobs.get(jobId);
    if (summary) return { jobId, status: summary.status, cancelled: summary.status === 'cancelled', message: 'job is already ' + summary.status };
    return { jobId, status: 'not_found', cancelled: false, message: 'job not found or no longer running' };
  }
  if (job.phase === 'running') { job.phase = 'cancelling'; job.controller.abort(); }
  if (job.phase === 'cancelling' || job.phase === 'completing' || job.phase === 'failing') {
    await job.done;
    const status = finishedJobs.get(jobId)?.status ?? (job.phase === 'cancelling' ? 'cancelled' : job.phase === 'completing' ? 'completed' : 'failed');
    return { jobId, status, cancelled: status === 'cancelled', message: status === 'cancelled' ? 'job cancelled by user' : 'job is already ' + status };
  }
  return { jobId, status: job.phase, cancelled: false, message: 'job is already ' + job.phase };
}

export async function understand(args: any, config: any) {
  validateResourceConfig(config);
  const url = validateUrl(args.url);
  await cleanupArtifacts(config.outputDir, { retentionDays: config.retentionDays, maxTotalBytes: config.maxTotalBytes });
  const jobId = crypto.randomUUID(); const jobDir = path.join(config.outputDir, jobId);
  const controller = new AbortController();
  let finishJob!: () => void;
  const done = new Promise<void>((resolve) => { finishJob = resolve; });
  const now = new Date().toISOString();
  const summary: JobStatusSummary = { jobId, status: 'running', phase: 'queued', createdAt: now, updatedAt: now, method: 'subtitles', progress: null, message: 'Job queued', found: true };
  const job: ActiveJob = { controller, phase: 'running', done, finish: finishJob, summary };
  const metadata: any = { url: url.href, jobId, status: 'running', phase: 'queued', method: 'subtitles', createdAt: now, updatedAt: now };
  const metadataPath = path.join(jobDir, 'metadata.json');
  const runOptions = { timeoutMs: config.timeoutMs, outputLimitBytes: config.maxOutputBytes ?? config.outputLimitBytes, signal: controller.signal };
  const limits = ['--no-playlist', '--match-filter', 'duration <= ' + (config.maxDurationSeconds ?? 3600), '--max-filesize', String(config.maxFileBytes ?? 500 * 1024 * 1024)];
  activeJobs.set(jobId, job);
  try {
    await fs.mkdir(jobDir, { recursive: true });
    await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
    updateSummary(job, { phase: 'probing_subtitles', message: 'Probing subtitles' }); metadata.phase = job.summary.phase; metadata.updatedAt = job.summary.updatedAt; await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
    throwIfCancelled(controller.signal);
    const subtitleArgs = [...limits, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '-o', path.join(jobDir, 'source.%(ext)s'), url.href];
    let result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), ...subtitleArgs], jobDir, runOptions); let text = '';
    throwIfCancelled(controller.signal);
    const subtitleNames = (await fs.readdir(jobDir)).filter((n) => /\.(?:vtt|srt)$/i.test(n));
    const subtitle = selectSubtitle(subtitleNames.map((name) => ({ name, manual: !/\.auto\./i.test(name), language: name.match(/\.([A-Za-z]{2,}(?:-[A-Za-z0-9]+)?)\.(?:vtt|srt)$/i)?.[1] })), config.language);
    let srtSegments: SubtitleCue[] | undefined;
    if (subtitle) {
      const subtitleSource = await fs.readFile(path.join(jobDir, subtitle.name), 'utf8');
      text = cleanSubtitle(subtitleSource, path.extname(subtitle.name));
      srtSegments = parseSubtitleCues(subtitleSource);
    }
    if (!result.ok || !text) {
      updateSummary(job, { phase: 'downloading_audio', method: 'whisper', message: 'Downloading audio' }); metadata.method = 'whisper'; metadata.phase = job.summary.phase; metadata.updatedAt = job.summary.updatedAt; await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2)); const audio = path.join(jobDir, 'audio.wav');
      result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), ...limits, '-x', '--audio-format', 'wav', '-o', audio, url.href], jobDir, runOptions);
      throwIfCancelled(controller.signal);
      if (!result.ok) throw new Error(result.stderr || 'yt-dlp audio extraction failed');
      const audioSize = (await fs.stat(audio)).size; if (audioSize > (config.maxFileBytes ?? 500 * 1024 * 1024)) throw new Error('audio output exceeded maxFileBytes');
      updateSummary(job, { phase: 'transcribing', message: 'Transcribing audio', progress: null }); metadata.phase = job.summary.phase; metadata.updatedAt = job.summary.updatedAt; await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
      result = await transcribe(audio, config, jobDir, controller.signal);
      throwIfCancelled(controller.signal);
      if (!result.ok) throw new Error(result.stderr || 'transcription failed');
      const transcript = await readTranscript(path.join(jobDir, 'transcript.json')); text = transcript.text; srtSegments = transcript.segments;
    }
    throwIfCancelled(controller.signal);
    updateSummary(job, { phase: 'writing_artifacts', message: 'Writing artifacts' }); metadata.phase = job.summary.phase; metadata.updatedAt = job.summary.updatedAt; await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
    const transcriptPath = path.join(jobDir, 'transcript.txt'); const summaryPath = path.join(jobDir, 'summary.md'); const srtPath = path.join(jobDir, 'transcript.srt');
    await writeFileAtomic(transcriptPath, text);
    throwIfCancelled(controller.signal);
    await writeFileAtomic(summaryPath, extractiveSummary(text, args.summaryInstruction));
    throwIfCancelled(controller.signal);
    if (srtSegments?.length) { await writeFileAtomic(srtPath, formatSrt(srtSegments, jobDir)); metadata.srt = { generated: true, path: srtPath }; }
    else { metadata.srt = { generated: false, reason: 'no valid timestamps' }; await fs.rm(srtPath, { force: true }); }
    throwIfCancelled(controller.signal);
    for (const item of await fs.readdir(jobDir)) if (tempNames(item) || (!['audio.wav', 'transcript.txt', 'transcript.json', 'transcript.srt', 'summary.md', 'metadata.json'].includes(item))) await fs.rm(path.join(jobDir, item), { recursive: true, force: true });
    throwIfCancelled(controller.signal);
    if (!claimCompletion(job)) throw new JobCancelledError();
    job.phase = 'completed'; updateSummary(job, { status: 'completed', phase: 'completed', message: 'Job completed', progress: 100 }); metadata.status = 'completed'; metadata.phase = 'completed'; metadata.updatedAt = job.summary.updatedAt; await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
    return { jobDir, method: metadata.method, transcriptPath, srtPath: metadata.srt?.generated ? srtPath : undefined, summaryPath, metadataPath, transcriptSummary: text.slice(0, 240) };
  } catch (error) {
    if (job.phase === 'cancelling') {
      job.phase = 'cancelled'; updateSummary(job, { status: 'cancelled', phase: 'cancelled', message: 'Job cancelled' }); metadata.status = 'cancelled'; metadata.phase = 'cancelled'; metadata.updatedAt = job.summary.updatedAt; metadata.cancelReason = 'job cancelled by user'; delete metadata.error;
      await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
      throw error instanceof JobCancelledError ? error : new JobCancelledError();
    }
    job.phase = 'failing'; updateSummary(job, { status: 'failed', phase: 'failed', message: 'Job failed' }); metadata.status = 'failed'; metadata.phase = 'failed'; metadata.updatedAt = job.summary.updatedAt; metadata.error = error instanceof Error ? error.message : String(error);
    await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));
    job.phase = 'failed';
    throw error;
  } finally {
    try {
      const removeArtifacts = metadata.status === 'failed' || metadata.status === 'cancelled';
      for (const item of await fs.readdir(jobDir).catch(() => [])) if (tempNames(item) || item.startsWith('source.') || (removeArtifacts && ['audio.wav', 'transcript.json', 'transcript.txt', 'summary.md', 'transcript.srt'].includes(item))) await fs.rm(path.join(jobDir, item), { recursive: true, force: true }).catch(() => undefined);
    } finally {
      const finalPhase: FinalJobPhase = job.phase === 'completed' ? 'completed' : job.phase === 'cancelled' || job.phase === 'cancelling' ? 'cancelled' : 'failed';
      rememberFinished(jobId, job.summary);
      activeJobs.delete(jobId);
      job.finish();
    }
  }
}
const output = { schema: { type: 'object', additionalProperties: false, properties: { jobDir: { type: 'string', required: true }, method: { type: 'string', enum: ['subtitles', 'whisper'], required: true }, transcriptPath: { type: 'string', required: true }, srtPath: { type: 'string' }, summaryPath: { type: 'string', required: true }, metadataPath: { type: 'string', required: true }, transcriptSummary: { type: 'string', required: true } } }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
const statusOutput = { schema: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string', required: true }, status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled', 'not_found'], required: true }, phase: { type: 'string', enum: ['queued', 'probing_subtitles', 'downloading_audio', 'transcribing', 'writing_artifacts', 'completed', 'failed', 'cancelled'], required: true }, createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true }, method: { oneOf: [{ type: 'string', enum: ['subtitles', 'whisper'] }, { type: 'null' }], required: true }, progress: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true }, message: { type: 'string', required: true }, found: { type: 'boolean', required: true } } }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
const listOutput = { schema: { type: 'array', items: statusOutput.schema }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
export const cancelOutput = { schema: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string', required: true }, status: { type: 'string', enum: ['not_found', 'completed', 'failed', 'cancelled'], required: true }, cancelled: { type: 'boolean', required: true }, message: { type: 'string', required: true } } }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
export const cancelToolDefinition = { name: 'dsh_video_understand_cancel', description: 'Cancel a running video understanding job in this process.', parameters: { jobId: { type: 'string', required: true } }, output: cancelOutput, execute: (args: any) => { if (Object.keys(args).length !== 1) throw new Error('cancel parameters only allow jobId'); return cancelJob(args.jobId); } };
export const statusToolDefinition = { name: 'dsh_video_understand_status', description: 'Read one video understanding job status in this process.', parameters: { jobId: { type: 'string', required: true } }, output: statusOutput, execute: (args: any) => { if (Object.keys(args).length !== 1) throw new Error('status parameters only allow jobId'); return getJobStatus(args.jobId); } };
export const listToolDefinition = { name: 'dsh_video_understand_list', description: 'List video understanding jobs in this process.', parameters: {}, output: listOutput, execute: (args: any) => { if (Object.keys(args).length !== 0) throw new Error('list parameters must be empty'); return listJobs(); } };
export function apply(ctx: any, config: any) {
  ctx.tools.register((defineTool as any)({ name: 'dsh_video_understand', description: 'Transcribe and summarize a video, preferring available subtitles.', parameters: { url: { type: 'string', required: true }, summaryInstruction: { type: 'string' } }, output, execute: (args: any) => understand(args, config) }));
  ctx.tools.register((defineTool as any)(cancelToolDefinition));
  ctx.tools.register((defineTool as any)(statusToolDefinition));
  ctx.tools.register((defineTool as any)(listToolDefinition));
}
