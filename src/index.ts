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
});

const defaultTranscribeScript = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));

export function validateUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('url must use http or https');
  if (url.username || url.password) throw new Error('url must not contain credentials');
  return url;
}

function run(file: string, args: string[], cwd: string) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

export function extractiveSummary(text: string, instruction = '') {
  return '# Video Summary\n\n<!-- summaryInstruction: ' + instruction.replace(/-->/g, '') + ' -->\n\n' +
    text.split(/\n+/).filter(Boolean).slice(0, 24).map((line) => '- ' + line).join('\n') + '\n';
}

export async function understand(args: any, config: any) {
  const url = validateUrl(args.url);
  const jobId = crypto.randomUUID();
  const jobDir = path.join(config.outputDir, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const metadata: any = { url: url.href, jobId, method: 'subtitles' };
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata));

  const subtitleArgs = ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'vtt', '-o', path.join(jobDir, 'source.%(ext)s'), url.href];
  let result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), ...subtitleArgs], jobDir);
  const names = await fs.readdir(jobDir);
  const subtitle = names.find((name) => name.endsWith('.vtt') || name.endsWith('.srt'));
  let text = '';

  if (result.ok && subtitle) {
    text = (await fs.readFile(path.join(jobDir, subtitle), 'utf8'))
      .replace(/<[^>]+>/g, '')
      .replace(/^WEBVTT.*?\n/s, '')
      .replace(/^\d+\s*$/gm, '')
      .replace(/^.*-->.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    metadata.method = 'whisper';
    const audio = path.join(jobDir, 'audio.wav');
    result = await run(config.ytDlpPath || 'yt-dlp', [...(config.ytDlpPrefixArgs || []), '-x', '--audio-format', 'wav', '-o', audio, url.href], jobDir);
    if (!result.ok) throw new Error(result.stderr || 'yt-dlp audio extraction failed');
    result = await run(config.pythonPath || 'python', [...(config.pythonPrefixArgs || []), config.transcribeScript || defaultTranscribeScript, '--audio', audio, '--output', path.join(jobDir, 'transcript.json'), '--device', config.device || 'cuda', '--compute-type', (config.device || 'cuda') === 'cpu' ? 'int8' : (config.computeType || 'int8_float16')], jobDir);
    if (!result.ok) throw new Error(result.stderr || 'transcription failed');
    text = JSON.parse(await fs.readFile(path.join(jobDir, 'transcript.json'), 'utf8')).text;
  }

  await fs.writeFile(path.join(jobDir, 'transcript.txt'), text);
  await fs.writeFile(path.join(jobDir, 'summary.md'), extractiveSummary(text, args.summaryInstruction));
  for (const name of await fs.readdir(jobDir)) {
    if (!['audio.wav', 'transcript.txt', 'transcript.json', 'summary.md', 'metadata.json'].includes(name)) {
      await fs.rm(path.join(jobDir, name), { recursive: true, force: true });
    }
  }
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  return { jobDir, method: metadata.method, transcript: text, summaryPath: path.join(jobDir, 'summary.md'), metadataPath: path.join(jobDir, 'metadata.json') };
}

const output: any = { schema: { type: 'json' }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] };
export function apply(ctx: any, config: any) {
  ctx.tools.register((defineTool as any)({
    name: 'dsh_video_understand',
    description: 'Transcribe and summarize a video, preferring available subtitles.',
    parameters: { url: { type: 'string', required: true }, summaryInstruction: { type: 'string' } },
    output,
    execute: (args: any) => understand(args, config),
  }));
}
