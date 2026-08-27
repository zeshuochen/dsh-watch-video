import { Buffer } from 'node:buffer';
const args = new Map(process.argv.slice(2).map((arg) => { const i = arg.indexOf('='); return [i < 0 ? arg : arg.slice(0, i), i < 0 ? '' : arg.slice(i + 1)]; }));
const write = (stream, value) => stream.write(Buffer.from(value, 'utf8'));
const stdout = args.get('--stdout') || '';
const stderr = args.get('--stderr') || '';
const repeat = Number(args.get('--repeat') || 1);
for (let i = 0; i < repeat; i++) { if (stdout) write(process.stdout, stdout); if (stderr) write(process.stderr, stderr); }
if (args.has('--continued')) { setTimeout(() => { write(process.stdout, 'continued'); write(process.stderr, 'continued'); }, 15); }
if (args.has('--sleep')) await new Promise((resolve) => setTimeout(resolve, Number(args.get('--sleep'))));
if (args.has('--signal')) { process.kill(process.pid, args.get('--signal')); await new Promise(() => {}); }
process.exit(Number(args.get('--exit') || 0));
