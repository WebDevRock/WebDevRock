// Tell Bing (and so Copilot), Yandex, Seznam and Naver about changed pages through IndexNow: npm run indexnow
//
//   npm run indexnow               the pages added, changed or removed since the last submission
//   npm run indexnow -- --all      every page in the sitemap
//   npm run indexnow -- --dry-run  list what would be sent without sending it
//
// deploy.ps1 runs it after each deploy. It reads the page list from dist/sitemap-0.xml, so run it after a build
// that matches what is live. A page counts as changed when its title, description or <main> content differs from
// the last submission, so a stylesheet change doesn't resubmit every page. What was sent is kept in
// .indexnow-state.json (not committed: a fresh clone just submits everything once). The key is public by design:
// search engines fetch https://webdevrock.uk/<key>.txt to check the submission came from this site.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = 'https://webdevrock.uk';
const DIST_DIR = 'dist';
const STATE_FILE = '.indexnow-state.json';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function fail(message) {
  console.error(`\nIndexNow: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
for (const flag of argv) if (!['--all', '--dry-run'].includes(flag)) fail(`unknown option ${flag}. Use --all or --dry-run.`);
const all = argv.includes('--all');
const dryRun = argv.includes('--dry-run');

// ---- The key: the one <32 hex>.txt file in public/

const keyFile = readdirSync('public').find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) fail('no key file in public/ (a file named <32 hex characters>.txt containing the same characters).');
const key = keyFile.replace(/\.txt$/, '');
const keyLocation = `${SITE}/${keyFile}`;

// ---- What each page looks like now

const sitemapPath = join(DIST_DIR, 'sitemap-0.xml');
if (!existsSync(sitemapPath)) fail(`${sitemapPath} not found. Run npm run build first.`);
const urls = [...readFileSync(sitemapPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

function fingerprint(url) {
  const file = join(DIST_DIR, new URL(url).pathname, 'index.html');
  if (!existsSync(file)) return undefined;
  const html = readFileSync(file, 'utf8');
  const parts = [
    html.match(/<title>[\s\S]*?<\/title>/)?.[0],
    html.match(/<meta name="description"[^>]*>/)?.[0],
    html.match(/<main[\s\S]*<\/main>/)?.[0] ?? html,
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

const current = Object.fromEntries(urls.map((url) => [url, fingerprint(url)]));
const previous = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

// Removed pages are sent too: the search engine fetches them, gets a 404 and drops them
const changed = all ? urls : urls.filter((url) => current[url] !== previous[url]);
const removed = Object.keys(previous).filter((url) => !(url in current));
const toSend = [...changed, ...removed];

if (toSend.length === 0) {
  console.log('IndexNow: no pages changed since the last submission.');
  process.exit(0);
}

console.log(`IndexNow: ${changed.length} changed${removed.length ? `, ${removed.length} removed` : ''}:`);
for (const url of toSend) console.log(`  ${url}`);
if (dryRun) process.exit(0);

// ---- Check the key file is live before submitting, or the submission is rejected (403)

const keyResponse = await fetch(keyLocation).catch(() => undefined);
const liveKey = keyResponse?.ok ? (await keyResponse.text()).trim() : undefined;
if (liveKey !== key) fail(`${keyLocation} doesn't serve the key yet. Deploy first, then run npm run indexnow.`);

// ---- Submit (up to 10,000 URLs per request, far more than this site has)

const response = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: new URL(SITE).host, key, keyLocation, urlList: toSend }),
});

// 200 means accepted, 202 means accepted while the key is still being checked
if (response.status !== 200 && response.status !== 202) {
  fail(`submission refused: ${response.status} ${response.statusText} ${(await response.text()).trim()}`);
}

writeFileSync(STATE_FILE, `${JSON.stringify(current, null, 2)}\n`);
console.log(`IndexNow: sent ${toSend.length} URLs (${response.status}).`);
