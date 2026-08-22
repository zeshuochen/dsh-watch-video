import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-video-understand';
export const inject = ['tools'];
export const Config = Schema.object({
  outputDir: Schema.string().required(),
  ytDlpPath: Schema.string(),
  pythonPath: Schema.string(),
  transcribeScript: Schema.string(),
  ytDlpPrefixArgs: Schema.array(String),
  pythonPrefixArgs: Schema.array(String),
  device: Schema.string().default('cuda'),
  computeType: Schema.string().default('int8_float16'),
  timeoutMs: Schema.number().default(15 * 60 * 1000),
  outputLimitBytes: Schema.number().default(1024 * 1024),
});

const defaultTranscribeScript = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export function validateUrl(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('url must not contain control characters');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url must use http or https');
  if (url.username || url.password) throw new Error('url must not contain credentials');
  return url;
}

type RunResult = { ok: boolean; stdout: string; stderr: string; timedOut?: boolean; outputLimitExceeded?: boolean };

export function run(file: string, args: string[], cwd: string, options: { timeoutMs?: number; outputLimitBytes?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    const child = spawn(file, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (kind === 'stdout') { stdoutBytes += chunk.byteLength; stdout += text; } else { stderrBytes += chunk.byteLength; stderr += text; }
      if (stdoutBytes > outputLimitBytes || stderrBytes > outputLimitBytes) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => finish({ ok: false, stdout, stderr: stderr || error.message, timedOut, outputLimitExceeded }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut && !outputLimitExceeded, stdout, stderr: timedOut ? (stderr || 'process timed out') : outputLimitExceeded ? (stderr || 'process output exceeded limit') : stderr, timedOut, outputLimitExceeded }));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  });
}

export function extractiveSummary(text: string, instruction = '') {
  return '# Video Summary\n\n<!-- summaryInstruction: ' + instruction.replace(/-->/g, '') + ' -->\n\n' +
    text.split(/\n+/).filter(Boolean).slice(0, 24).map((line) => '- ' + line).join('\n') + '\n';
}

function cleanSubtitle(source: string) {
  return source.replace(/<[^>]+>/g, '').replace(/^WEBVTT.*?\n/s, '').replace(/^\d+\s*$/gm, '')
    .replace(/^.*-->.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function transcribe(audio: string, config: any, jobDir: string) {
  const transcriptPath = path.join(jobDir, 'transcript.json');
  const device = config.device || 'cuda';
  return run(config.pythonPath || 'python', [...(config.pythonPrefixArgs || []), config.transcribeScript || defaultTranscribeScript,
    '--audio', audio, '--output', transcriptPath, '--device', device,
    '--compute-type', device === 'cpu' ? 'int8' : (config.computeType || 'int8_float16')], jobDir,
    { timeoutMs: config.timeoutMs, outputLimitBytes: config.outputLimitBytes });
}

export async function understand(args: any, config: any) {
  const url = validateUrl(args.url);
  const jobId = crypto.randomUUID();
  const jobDir = path.join(config.outputDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const metadata: any = { url: url.href, jobId, method: 'subtitles' };
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata));
  const runOptions = { timeoutMs: config.timeoutMs, outputLimitBytes: config.outputLimitBytes };
  const subtitleArgs = ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '-o', path.join(jobDir, 'source.%(ext)s'), url.href];
  let result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), ...subtitleArgs], jobDir, runOptions);
  let text = '';
  for (const subtitle of (await fs.readdir(jobDir)).filter((n) => n.endsWith('.vtt') || n.endsWith('.srt'))) {
    text = cleanSubtitle(await fs.readFile(path.join(jobDir, subtitle), 'utf8'));
    if (text) break;
  }
  if (!result.ok || !text) {
    metadata.method = 'whisper';
    const audio = path.join(jobDir, 'audio.wav');
    result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), '-x', '--audio-format', 'wav', '-o', audio, url.href], jobDir, runOptions);
    if (!result.ok) throw new Error(result.stderr || 'yt-dlp audio extraction failed');
    result = await transcribe(audio, config, jobDir);
    if (!result.ok) throw new Error(result.stderr || 'transcription failed');
    const transcriptPath = path.join(jobDir, 'transcript.json');
    const parsed = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
    text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) throw new Error('transcription produced empty text');
  }
  const transcriptPath = path.join(jobDir, 'transcript.txt');
  const summaryPath = path.join(jobDir, 'summary.md');
  await fs.writeFile(transcriptPath, text);
  await fs.writeFile(summaryPath, extractiveSummary(text, args.summaryInstruction));
  for (const item of await fs.readdir(jobDir)) if (!['audio.wav', 'transcript.txt', 'transcript.json', 'summary.md', 'metadata.json'].includes(item)) await fs.rm(path.join(jobDir, item), { recursive: true, force: true });
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  return { jobDir, method: metadata.method, transcriptPath, summaryPath, metadataPath: path.join(jobDir, 'metadata.json'), transcriptSummary: text.slice(0, 240) };
}

const output = { schema: { type: 'object', additionalProperties: false, properties: {
  jobDir: { type: 'string' }, method: { type: 'string', enum: ['subtitles', 'whisper'] },
  transcriptPath: { type: 'string' }, summaryPath: { type: 'string' }, metadataPath: { type: 'string' }, transcriptSummary: { type: 'string' }
}, required: ['jobDir', 'method', 'transcriptPath', 'summaryPath', 'metadataPath', 'transcriptSummary'] }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
export function apply(ctx: any, config: any) {
  ctx.tools.register((defineTool as any)({ name: 'dsh_video_understand', description: 'Transcribe and summarize a video, preferring available subtitles.', parameters: {
    url: { type: 'string', required: true }, summaryInstruction: { type: 'string' }
  }, output, execute: (args: any) => understand(args, config) }));
}
