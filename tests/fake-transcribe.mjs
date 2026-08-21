import fs from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
fs.writeFileSync(output, JSON.stringify({ text: 'Fallback transcript.', language: 'en', segments: [] }));
