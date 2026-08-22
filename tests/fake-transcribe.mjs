import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const root = path.dirname(path.dirname(output));
const controlPath = path.join(root, 'fake-transcribe-control.json');
if (fs.existsSync(controlPath)) {
  const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
  fs.appendFileSync(path.join(root, 'fake-transcribe-events.log'), 'start ' + path.basename(path.dirname(output)) + '\n');
  setTimeout(() => {
    fs.appendFileSync(path.join(root, 'fake-transcribe-events.log'), 'end ' + path.basename(path.dirname(output)) + '\n');
    fs.writeFileSync(output, JSON.stringify({ text: 'Fallback transcript.', language: 'en', segments: [] }));
  }, control.delayMs || 0);
} else {
  fs.writeFileSync(output, JSON.stringify({ text: 'Fallback transcript.', language: 'en', segments: [] }));
}
