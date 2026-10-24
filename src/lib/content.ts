// One index of the site's MDX content pages, used by the homepage and the llms.txt files.
// New pages are picked up automatically from src/pages/<section>/*.mdx.

export type Frontmatter = {
  title: string;
  description?: string;
  tags?: string[];
  updated?: string;
  sqlVersion?: string; // earliest SQL Server version the page's SQL runs on, e.g. "2016" (see SQL_VERSIONS)
  sqlNote?: string;    // extra requirement shown with the version, e.g. a compatibility level
};

export type ContentPage = {
  section: string;
  slug: string;
  path: string; // site-relative, e.g. /snippets/sql-bulk-update-join/
  frontmatter: Frontmatter;
};

export type Section = {
  key: string;
  name: string;
  singular: string;
  description: string;
  accent: string; // CSS colour from global.css
  glyph: string;  // short mono label used on tiles
};

export const SITE = (import.meta.env.SITE ?? 'https://webdevrock.uk').replace(/\/$/, '');

// Same order as the site navigation
export const SECTIONS: Section[] = [
  { key: 'patterns', name: 'Patterns', singular: 'Pattern', description: 'Higher-level engineering approaches: integration pipelines, data fixes, audit trails, and operational design.', accent: 'var(--accent-coral)', glyph: '##' },
  { key: 'snippets', name: 'Snippets', singular: 'Snippet', description: 'Small copy/paste solutions with short explanations, mostly SQL Server.', accent: 'var(--accent-amber)', glyph: '{}' },
  { key: 'tools', name: 'Tools', singular: 'Tool', description: 'Browser-based utilities for SQL Server and integration work.', accent: 'var(--accent-cyan)', glyph: '>_' },
  { key: 'ai', name: 'AI & LLMs', singular: 'AI guide', description: 'Practical guides on AI agents, local LLMs, and automation workflows.', accent: 'var(--accent-violet)', glyph: 'AI' },
  { key: 'experiments', name: 'Experiments', singular: 'Experiment', description: 'Visual and technical experiments.', accent: 'var(--accent-lime)', glyph: '~/' },
];

// Guided reading orders, shown on the homepage and as "next step" links on each page in them
export const LEARNING_PATHS = [
  {
    title: 'Fix production data safely',
    summary: 'From a one-off correction to a change across millions of rows, with a way back at every step.',
    steps: [
      '/patterns/sql-reversible-data-fix/',
      '/snippets/sql-output-into-audit/',
      '/tools/data-fix-script/',
      '/patterns/large-data-changes-without-outage/',
      '/snippets/sql-batch-update-delete/',
    ],
  },
  {
    title: "Build integrations that don't break",
    summary: 'Stages, safe reruns, sensible retries, and what to do when the other system is down.',
    steps: [
      '/patterns/integration-pipelines-fail-safely/',
      '/patterns/integration-jobs-safe-to-rerun/',
      '/patterns/handling-unreliable-external-apis/',
      '/snippets/ts-fetch-retry-backoff/',
      '/tools/retry-schedule/',
    ],
  },
];

// Raw source, not the compiled MDX modules: importing those would make Astro treat every page using
// this index as containing every component the MDX pages import (three.js demos, tools) and bundle
// all of their scripts into it.
const sources = import.meta.glob<string>('/src/pages/*/*.mdx', { eager: true, query: '?raw', import: 'default' });

function parseValue(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => parseValue(item) as string)
      .filter(Boolean);
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

// Reads the simple "key: value" front matter these pages use (strings and one-line [lists])
export function parseFrontmatter(source: string, file: string): Frontmatter {
  const block = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const data: Record<string, string | string[]> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) data[m[1]] = parseValue(m[2]);
  }
  if (typeof data.title !== 'string' || !data.title) throw new Error(`${file}: front matter needs a title`);
  return {
    title: data.title,
    description: typeof data.description === 'string' ? data.description : undefined,
    tags: Array.isArray(data.tags) ? data.tags : undefined,
    updated: typeof data.updated === 'string' ? data.updated : undefined,
    sqlVersion: typeof data.sqlVersion === 'string' ? checkSqlVersion(data.sqlVersion, file) : undefined,
    sqlNote: typeof data.sqlNote === 'string' ? data.sqlNote : undefined,
  };
}

// Sorted by section order, then title
export function getContentPages(): (ContentPage & { file: string })[] {
  const order = SECTIONS.map((s) => s.key);

  return Object.entries(sources)
    .map(([file, source]) => {
      const [, section, slug] = file.match(/^\/src\/pages\/([^/]+)\/([^/]+)\.mdx$/)!;
      return { file, section, slug, path: `/${section}/${slug}/`, frontmatter: parseFrontmatter(source, file) };
    })
    .filter((page) => order.includes(page.section))
    .sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.frontmatter.title.localeCompare(b.frontmatter.title));
}

export function getSection(key: string): Section {
  return SECTIONS.find((s) => s.key === key)!;
}

// Same trailing-slash form as the generated pages and the sitemap
export function normalisePath(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

// Newest first, then by title
export function byUpdated(a: ContentPage, b: ContentPage): number {
  return (b.frontmatter.updated ?? '').localeCompare(a.frontmatter.updated ?? '') || a.frontmatter.title.localeCompare(b.frontmatter.title);
}

// ---- SQL Server versions

// Releases a snippet can be labelled with, oldest first. 2008 is the floor: anything older is long out of
// support, so SQL that also runs on 2005 is still labelled 2008+. Add new releases at the end.
export const SQL_VERSIONS = ['2008', '2012', '2014', '2016', '2017', '2019', '2022', '2025'];

function checkSqlVersion(version: string, file: string): string {
  if (!SQL_VERSIONS.includes(version)) throw new Error(`${file}: sqlVersion must be one of ${SQL_VERSIONS.join(', ')}`);
  return version;
}

export const sqlVersionLabel = (version: string) => `SQL Server ${version}+`;

// Every release a snippet runs on: its minimum version and everything newer
export function sqlVersionsFrom(version: string): string[] {
  return SQL_VERSIONS.slice(SQL_VERSIONS.indexOf(version));
}

// ---- Reading time

const WORDS_PER_MINUTE = 220;

// Minutes to read a page's prose and code, ignoring front matter, imports, style blocks and HTML tags.
// Code is counted at half speed: it is read more slowly than prose.
export function readingMinutes(path: string): number | undefined {
  const page = getContentPages().find((p) => p.path === path);
  if (!page) return undefined;

  const body = sources[page.file]
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/<style\b[\s\S]*?<\/style>/g, '')
    .replace(/^import\s.+$/gm, '');

  let words = 0;
  body.split(/^(`{3,}|~{3,}).*$/m).forEach((part, i, parts) => {
    if (/^(`{3,}|~{3,})$/.test(part)) return; // fence markers
    const inCode = parts.slice(0, i).filter((p) => /^(`{3,}|~{3,})$/.test(p)).length % 2 === 1;
    const count = part.replace(/<\/?[A-Za-z][^>]*>/g, ' ').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
    words += inCode ? count * 2 : count;
  });

  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

// ---- Tags

export function tagSlug(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function tagPath(tag: string): string {
  return `/tags/${tagSlug(tag)}/`;
}

export type TagInfo = { slug: string; label: string; pages: ContentPage[] };

// Every tag with the pages that use it, most used first
export function getTags(): TagInfo[] {
  const tags = new Map<string, TagInfo>();
  for (const page of getContentPages()) {
    for (const tag of page.frontmatter.tags ?? []) {
      const slug = tagSlug(tag);
      if (!slug) continue;
      if (!tags.has(slug)) tags.set(slug, { slug, label: tag.trim(), pages: [] });
      tags.get(slug)!.pages.push(page);
    }
  }
  return [...tags.values()].sort((a, b) => b.pages.length - a.pages.length || a.slug.localeCompare(b.slug));
}

// ---- End-of-page navigation

export type PathPosition = {
  title: string;
  step: number; // 1-based
  total: number;
  previous?: ContentPage;
  next?: ContentPage;
};

// Where a page sits in each learning path it belongs to
export function getPathPositions(path: string): PathPosition[] {
  const byPath = new Map(getContentPages().map((p) => [p.path, p]));
  return LEARNING_PATHS.flatMap((learningPath) => {
    const steps = learningPath.steps.map((s) => byPath.get(s)).filter((s) => s !== undefined);
    const index = steps.findIndex((s) => s.path === path);
    if (index === -1) return [];
    return [{ title: learningPath.title, step: index + 1, total: steps.length, previous: steps[index - 1], next: steps[index + 1] }];
  });
}

// Pages sharing the most distinctive tags with this one: a tag used by few pages counts for more
export function getRelatedPages(path: string, limit = 3, exclude: string[] = []): ContentPage[] {
  const pages = getContentPages();
  const current = pages.find((p) => p.path === path);
  if (!current) return [];

  const usage = new Map(getTags().map((t) => [t.slug, t.pages.length]));
  const currentTags = new Set((current.frontmatter.tags ?? []).map(tagSlug));

  return pages
    .filter((p) => p.path !== path && !exclude.includes(p.path))
    .map((page) => {
      const shared = (page.frontmatter.tags ?? []).map(tagSlug).filter((t) => currentTags.has(t));
      const score = shared.reduce((sum, t) => sum + 1 / (usage.get(t) ?? 1), 0);
      return { page, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || byUpdated(a.page, b.page))
    .slice(0, limit)
    .map((r) => r.page);
}
