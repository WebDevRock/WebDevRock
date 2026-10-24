// Renders the default social share image: node ops/og-image/render.mjs
// Headless Chrome draws og-default.html at 1200×630 with the site's real web fonts (an SVG renderer would fall back
// to system fonts), then sharp, which Astro already installs, compresses the PNG.
// Chrome or Edge is found in the usual Windows/macOS/Linux places; set CHROME_PATH to use another browser.
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('./og-default.html', import.meta.url));
const target = fileURLToPath(new URL('../../public/og-default.png', import.meta.url));

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((path) => existsSync(path));
if (!browser) throw new Error('Chrome or Edge not found: set CHROME_PATH to its executable');

// A throwaway profile, so the render never touches your normal browser profile
const profile = mkdtempSync(join(tmpdir(), 'og-render-'));
const shot = join(profile, 'og.png');

try {
  execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1200,630',
    '--virtual-time-budget=8000', // time for the web fonts to load
    `--user-data-dir=${profile}`,
    `--screenshot=${shot}`,
    pathToFileURL(source).href,
  ], { stdio: 'ignore' });

  const { width, height } = await sharp(shot).metadata();
  if (width !== 1200 || height !== 630) throw new Error(`Expected 1200×630, got ${width}×${height}`);

  await sharp(shot).png({ compressionLevel: 9, palette: false }).toFile(target);
  console.log(`Wrote ${target}`);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
