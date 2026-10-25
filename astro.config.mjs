import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const SITE = 'https://webdevrock.uk';

// Each content page's "updated" date from its front matter, by URL, for the sitemap's <lastmod>. Read from the
// files here because the config runs before Vite, so src/lib/content.ts can't be imported.
function updatedDates() {
  const dates = new Map();
  const pagesDir = new URL('./src/pages/', import.meta.url);
  for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(new URL(`${entry.name}/`, pagesDir))) {
      if (!file.endsWith('.mdx')) continue;
      const source = readFileSync(new URL(`${entry.name}/${file}`, pagesDir), 'utf8');
      const updated = source.match(/^updated:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1];
      if (updated) dates.set(`${SITE}/${entry.name}/${file.replace(/\.mdx$/, '')}/`, updated);
    }
  }
  // The homepage and each section's index change whenever a page in them does
  const newest = (prefix) => [...dates].filter(([url]) => url.startsWith(prefix)).map(([, d]) => d).sort().at(-1);
  const sections = new Set([...dates.keys()].map((url) => url.split('/')[3]));
  for (const section of sections) dates.set(`${SITE}/${section}/`, newest(`${SITE}/${section}/`));
  dates.set(`${SITE}/`, newest(`${SITE}/`));
  return dates;
}

const lastmod = updatedDates();

export default defineConfig({
  site: SITE,
  integrations: [
    mdx(),
    sitemap({
      serialize(item) {
        const date = lastmod.get(item.url);
        return date ? { ...item, lastmod: date } : item;
      },
    }),
  ],
  markdown: {
    shikiConfig: {
      // Colours come from the --syn-* tokens via src/styles/content.css
      theme: 'css-variables',
      wrap: true
    }
  }
});
