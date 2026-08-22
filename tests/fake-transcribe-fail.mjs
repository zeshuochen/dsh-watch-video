import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const root = path.dirname(path.dirname(output));
fs.appendFileSync(path.join(root, 'fake-transcribe-events.log'), 'start failed\n');
setTimeout(() => {
  fs.appendFileSync(path.join(root, 'fake-transcribe-events.log'), 'end failed\n');
  process.exit(1);
}, 40);
