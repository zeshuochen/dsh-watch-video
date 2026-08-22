import fs from 'node:fs';
const a = process.argv.slice(2);
fs.writeFileSync('yt-args.json', JSON.stringify(a));
if (!a.includes('--no-playlist') || !a.includes('--match-filter') || !a.includes('--max-filesize')) process.exit(2);
const oi = a.indexOf('-o');
const out = a[oi + 1];
if (a.includes('--skip-download')) {
  if (a.includes('--fail-subs')) process.exit(1);
  const fixture = fs.readFileSync(new URL('./fixture.vtt', import.meta.url), 'utf8');
  fs.writeFileSync(out.replace('%(ext)s', 'en.vtt'), fixture);
} else {
  if (a.includes('--fail-audio')) process.exit(1);
  fs.writeFileSync(out, a.includes('--oversize') ? '01234567890' : 'fake wav');
}
