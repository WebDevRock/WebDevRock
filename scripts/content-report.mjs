// Monthly content health report from the site's Umami analytics: npm run report
//
//   npm run report                      the last 30 days
//   npm run report -- --month 2026-10   a calendar month
//   npm run report -- --days 90         the last 90 days
//   npm run report -- --min-views 5     the views a page needs before "read but not copied" lists it (default 10)
//
// Writes reports/content-health-<period>.md with: the pages readers found least useful and why, missing
// addresses (404s) and the sites linking to them, pages with code that are read but never copied, and
// searches that found nothing. Reads the Umami address and website id from .env.production and a login from
// .env.report (see .env.report.example). The event properties it reads are listed in ops/umami/README.md.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE_HOST = 'webdevrock.uk';
const PAGES_DIR = 'src/pages';
const OUT_DIR = 'reports';

// ---- Settings

function fail(message) {
  console.error(`\nContent report: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { days: 30, month: undefined, minViews: 10 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--days') args.days = Number(value), i++;
    else if (flag === '--month') args.month = value, i++;
    else if (flag === '--min-views') args.minViews = Number(value), i++;
    else fail(`unknown option ${flag}. Use --days N, --month YYYY-MM or --min-views N.`);
  }
  if (!(args.days > 0)) fail('--days needs a positive number.');
  if (args.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) fail('--month needs the form YYYY-MM, e.g. 2026-10.');
  if (!(args.minViews >= 0)) fail('--min-views needs a number.');
  return args;
}

function period({ days, month }) {
  if (month) {
    const [y, m] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1) - 1);
    return { start, end, label: month, title: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const day = (d) => d.toISOString().slice(0, 10);
  return { start, end, label: `${day(start)}_to_${day(end)}`, title: `the last ${days} days (${fmtDate(start)} to ${fmtDate(end)})` };
}

const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function settings() {
  const env = process.env;
  const base = env.UMAMI_URL ?? (env.PUBLIC_UMAMI_SRC ? new URL(env.PUBLIC_UMAMI_SRC).origin : undefined);
  const websiteId = env.UMAMI_WEBSITE_ID ?? env.PUBLIC_UMAMI_WEBSITE_ID;
  if (!base) fail('no Umami address. Set PUBLIC_UMAMI_SRC in .env.production, or UMAMI_URL in .env.report.');
  if (!websiteId) fail('no website id. Set PUBLIC_UMAMI_WEBSITE_ID in .env.production, or UMAMI_WEBSITE_ID in .env.report.');
  if (!env.UMAMI_API_KEY && !(env.UMAMI_USERNAME && env.UMAMI_PASSWORD)) {
    fail('no Umami login. Copy .env.report.example to .env.report and fill in UMAMI_USERNAME and UMAMI_PASSWORD (or UMAMI_API_KEY for Umami Cloud).');
  }
  return { base: base.replace(/\/$/, ''), websiteId, apiKey: env.UMAMI_API_KEY, username: env.UMAMI_USERNAME, password: env.UMAMI_PASSWORD };
}

// ---- Umami API (self-hosted v2 and v3, or Umami Cloud with an API key)

class ApiError extends Error {
  constructor(status, url, body) {
    super(`${status} from ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
  }
}

async function connect(config) {
  let headers;
  if (config.apiKey) {
    headers = { 'x-umami-api-key': config.apiKey, accept: 'application/json' };
  } else {
    let response;
    try {
      response = await fetch(`${config.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: config.username, password: config.password }),
      });
    } catch (err) {
      fail(`couldn't reach ${config.base} (${err.cause?.code ?? err.message}). Is the address right and the server up?`);
    }
    if (response.status === 401 || response.status === 403) fail('Umami rejected the login. Check UMAMI_USERNAME and UMAMI_PASSWORD in .env.report.');
    if (!response.ok) fail(`login failed: ${response.status} from ${config.base}/api/auth/login.`);
    const { token } = await response.json();
    headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  }

  const get = async (path, params) => {
    const url = `${config.base}/api/websites/${config.websiteId}${path}?${new URLSearchParams(params)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new ApiError(response.status, url, await response.text().catch(() => ''));
    return response.json();
  };

  // The first form the server accepts; Umami renamed some parameters between versions
  const first = async (attempts) => {
    let last;
    for (const [path, params] of attempts) {
      try {
        return await get(path, params);
      } catch (err) {
        if (!(err instanceof ApiError) || ![400, 404, 422].includes(err.status)) throw err;
        last = err;
      }
    }
    throw last;
  };

  return { get, first };
}

function umamiQueries(api, range) {
  const time = { startAt: String(range.start.getTime()), endAt: String(range.end.getTime()) };

  return {
    async stats() {
      const s = await api.get('/stats', time);
      const n = (v) => (typeof v === 'object' && v !== null ? v.value : v) ?? 0;
      return { pageviews: n(s.pageviews), visitors: n(s.visitors) };
    },

    // Views per page address: "url" in Umami 2, "path" in Umami 3
    async views() {
      const rows = await api.first([
        ['/metrics', { ...time, type: 'url', limit: '1000' }],
        ['/metrics', { ...time, type: 'path', limit: '1000' }],
      ]);
      const views = new Map();
      for (const { x, y } of rows) {
        const path = normalisePath(x);
        views.set(path, (views.get(path) ?? 0) + y);
      }
      return views;
    },

    // How often each value of one event property was sent, e.g. feedback → vote
    async values(eventName, propertyName) {
      const rows = await api.first([
        ['/event-data/values', { ...time, eventName, propertyName }],
        ['/event-data/values', { ...time, event: eventName, propertyName }],
        ['/event-data/values', { ...time, event: eventName, property: propertyName }],
      ]);
      return rows.map((r) => ({ value: String(r.value ?? r.x ?? ''), total: Number(r.total ?? r.y ?? 0) })).filter((r) => r.value);
    },
  };
}

// ---- The site's own pages: titles, and which ones have code to copy

function normalisePath(address) {
  let path = String(address).split(/[?#]/)[0] || '/';
  if (!path.startsWith('/')) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = `/${path}`;
    }
  }
  return /\.[a-z0-9]+$/i.test(path) || path.endsWith('/') ? path : `${path}/`;
}

function readSitePages() {
  const pages = new Map();
  for (const section of readdirSync(PAGES_DIR, { withFileTypes: true })) {
    if (!section.isDirectory() || section.name.startsWith('[')) continue;
    for (const file of readdirSync(join(PAGES_DIR, section.name))) {
      if (!file.endsWith('.mdx')) continue;
      const source = readFileSync(join(PAGES_DIR, section.name, file), 'utf8');
      const title = source.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? file;
      const path = `/${section.name}/${file.replace(/\.mdx$/, '')}/`;
      pages.set(path, { title, section: section.name, hasCode: /^\s*(```|~~~)/m.test(source), isTool: section.name === 'tools' });
    }
  }
  return pages;
}

// ---- Markdown helpers

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');

function table(headers, rows) {
  if (rows.length === 0) return '';
  const align = headers.map((h) => (/^(views|no|yes|times|count|copies|share|visits|searches)/i.test(h) ? '---:' : '---'));
  return [`| ${headers.join(' | ')} |`, `| ${align.join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

const pageLink = (path, pages) => {
  const page = pages.get(path);
  return page ? `[${page.title}](https://${SITE_HOST}${path})` : `\`${path}\``;
};

// Values sent as "first | second" (the report's paired properties)
function splitPairs(rows) {
  return rows
    .map(({ value, total }) => {
      const at = value.indexOf(' | ');
      return at === -1 ? null : { a: value.slice(0, at), b: value.slice(at + 3), total };
    })
    .filter(Boolean);
}

const REASONS = {
  'did-not-work': "Didn't work for me",
  'hard-to-follow': 'Hard to follow',
  'out-of-date': 'Out of date',
  'missing-something': 'Missing something',
};

// ---- Sections

function feedbackSection(votes, reasons, usefulTotals, pages) {
  const byPage = new Map();
  for (const { a: answer, b: path, total } of splitPairs(votes)) {
    const row = byPage.get(normalisePath(path)) ?? { yes: 0, no: 0, reasons: new Map() };
    if (answer === 'yes') row.yes += total;
    if (answer === 'no') row.no += total;
    byPage.set(normalisePath(path), row);
  }
  for (const { a: reason, b: path, total } of splitPairs(reasons)) {
    const row = byPage.get(normalisePath(path)) ?? { yes: 0, no: 0, reasons: new Map() };
    row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + total);
    byPage.set(normalisePath(path), row);
  }

  const noRows = [...byPage.entries()]
    .filter(([, r]) => r.no > 0)
    .sort(([, a], [, b]) => b.no - a.no || b.no / (b.no + b.yes) - a.no / (a.no + a.yes))
    .slice(0, 15)
    .map(([path, r]) => [
      pageLink(path, pages),
      r.no,
      r.yes,
      pct(r.no, r.no + r.yes),
      [...r.reasons.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${REASONS[k] ?? k} (${n})`).join(', ') || '–',
    ]);

  const totalYes = usefulTotals.find((r) => r.value === 'yes')?.total ?? 0;
  const totalNo = usefulTotals.find((r) => r.value === 'no')?.total ?? 0;
  const reasonTotals = new Map();
  for (const { a: reason, total } of splitPairs(reasons)) reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + total);

  const lines = ['## Pages readers found least useful', ''];
  lines.push(`"Was this useful?" got **${totalYes} yes** and **${totalNo} no** in this period${totalYes + totalNo ? ` (${pct(totalNo, totalYes + totalNo)} no)` : ''}.`, '');
  if (noRows.length) {
    lines.push(table(['Page', 'No', 'Yes', 'Share no', 'Reasons given'], noRows), '');
    const matched = [...byPage.values()].reduce((sum, r) => sum + r.no, 0);
    if (totalNo > matched) {
      lines.push(`*${totalNo - matched} of the "No" answers came before per-page tracking was added, so they aren't in the table.*`, '');
    }
    if (reasonTotals.size) {
      lines.push('Reasons across all pages: ' + [...reasonTotals.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${REASONS[k] ?? k} ${n}`).join(' · ') + '.', '');
    }
    lines.push('*Start with the pages at the top: "Out of date" and "Didn\'t work for me" usually mean the code needs checking; "Hard to follow" and "Missing something" mean the explanation does.*');
  } else if (totalNo > 0) {
    lines.push('*There were "No" answers, but none from after the per-page tracking was added, so they can\'t be matched to pages yet.*');
  } else {
    lines.push('*No "No" answers in this period.*');
  }
  return lines.join('\n');
}

function notFoundSection(paths, links, referrers) {
  const lines = ['## Missing pages (404)', ''];
  const total = paths.reduce((sum, r) => sum + r.total, 0);
  if (!total) return [...lines, '*No visits to missing pages in this period.*'].join('\n');

  lines.push(`${total} visits ended on the "page not found" page.`, '');
  lines.push(table(['Missing address', 'Visits'], [...paths].sort((a, b) => b.total - a.total).slice(0, 15).map((r) => [`\`${r.value}\``, r.total])), '');

  const external = splitPairs(links)
    .filter(({ a: host }) => host !== 'direct' && !host.endsWith(SITE_HOST))
    .sort((x, y) => y.total - x.total)
    .slice(0, 15);
  const internal = splitPairs(links).filter(({ a: host }) => host.endsWith(SITE_HOST));

  lines.push('### Broken links from other sites', '');
  if (external.length) {
    lines.push(table(['Linking site', 'Missing address', 'Visits'], external.map((r) => [r.a, `\`${r.b}\``, r.total])), '');
    lines.push('*A redirect in nginx (or asking the site to fix its link) recovers these visitors.*');
  } else {
    lines.push('*None: missing pages were typed in or came from bookmarks.*');
  }
  if (internal.length) {
    lines.push('', `**${internal.reduce((s, r) => s + r.total, 0)} came from links on webdevrock.uk itself**, which means a broken internal link: ` +
      internal.map((r) => `\`${r.b}\``).filter((v, i, all) => all.indexOf(v) === i).slice(0, 10).join(', ') + '.');
  }
  const sources = referrers.filter((r) => r.value !== 'direct').length;
  if (!external.length && sources) lines.push('', `*${sources} referring site(s) were recorded before per-link tracking was added.*`);
  return lines.join('\n');
}

function notCopiedSection(views, codeCopies, markdownCopies, toolUses, pages, minViews) {
  const copies = new Map();
  const add = (path, n) => copies.set(path, (copies.get(path) ?? 0) + n);
  for (const { value, total } of codeCopies) add(normalisePath(value), total);
  for (const { value, total } of markdownCopies) add(normalisePath(value), total);
  for (const { a: action, b: tool, total } of splitPairs(toolUses)) if (action === 'copy' || action === 'share') add(`/tools/${tool}/`, total);

  const candidates = [...pages.entries()].filter(([, p]) => p.hasCode || p.isTool);
  const read = candidates
    .map(([path, page]) => ({ path, page, views: views.get(path) ?? 0, copies: copies.get(path) ?? 0 }))
    .filter((r) => r.views > 0);

  const never = read.filter((r) => r.copies === 0 && r.views >= minViews).sort((a, b) => b.views - a.views).slice(0, 15);
  const lowest = read
    .filter((r) => r.copies > 0 && r.views >= minViews)
    .sort((a, b) => a.copies / a.views - b.copies / b.views)
    .slice(0, 5);

  const lines = ['## Read but never copied', ''];
  lines.push(`Pages with code or a tool, read at least ${minViews} times in this period, where nobody used Copy, Copy as Markdown or a tool's copy or share button.`, '');
  if (never.length) {
    lines.push(table(['Page', 'Views', 'Section'], never.map((r) => [pageLink(r.path, pages), r.views, r.page.section])), '');
    lines.push('*Readers may be finding the page but not the answer: check the code is near the top, matches the title, and works as pasted.*');
  } else {
    lines.push(`*None: every page with code read ${minViews}+ times was copied from at least once.*`);
  }
  if (lowest.length) {
    lines.push('', '### Lowest copy rates', '');
    lines.push(table(['Page', 'Views', 'Copies', 'Rate'], lowest.map((r) => [pageLink(r.path, pages), r.views, r.copies, pct(r.copies, r.views)])));
  }
  return lines.join('\n');
}

function emptySearchSection(terms, sources) {
  const lines = ['## Searches that found nothing', ''];
  const total = terms.reduce((s, r) => s + r.total, 0);
  if (!total) return [...lines, '*None in this period.*'].join('\n');
  const where = sources.map((r) => `${r.value} ${r.total}`).join(' · ');
  lines.push(`${total} searches found nothing${where ? ` (${where})` : ''}. Repeated terms are topics readers expect to find here.`, '');
  lines.push(table(['Search', 'Times'], [...terms].sort((a, b) => b.total - a.total).slice(0, 25).map((r) => [r.value, r.total])));
  lines.push('', '*Words are recorded only when a search finds nothing, lower-cased, with email addresses and long numbers removed.*');
  return lines.join('\n');
}

// ---- Run

const args = parseArgs(process.argv.slice(2));
const range = period(args);
const config = settings();
const api = await connect(config);
const q = umamiQueries(api, range);
const pages = readSitePages();

// Each query on its own, so one missing event (nothing sent yet) doesn't stop the report
const notes = [];
const safe = async (label, fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && [400, 404, 422].includes(err.status)) {
      notes.push(`${label}: Umami had no data or didn't accept the query (${err.status}).`);
      return fallback;
    }
    throw err;
  }
};

let data;
try {
  data = {
    stats: await safe('Totals', () => q.stats(), { pageviews: 0, visitors: 0 }),
    views: await safe('Page views', () => q.views(), new Map()),
    votes: await safe('Feedback per page', () => q.values('feedback', 'vote'), []),
    useful: await safe('Feedback totals', () => q.values('feedback', 'useful'), []),
    reasons: await safe('Feedback reasons', () => q.values('feedback-reason', 'pageReason'), []),
    notFound: await safe('404 addresses', () => q.values('not-found', 'path'), []),
    links: await safe('404 links', () => q.values('not-found', 'link'), []),
    referrers: await safe('404 referrers', () => q.values('not-found', 'referrer'), []),
    codeCopies: await safe('Code copies', () => q.values('code-copy', 'page'), []),
    markdownCopies: await safe('Markdown copies', () => q.values('markdown-copy', 'page'), []),
    toolUses: await safe('Tool copies', () => q.values('tool-use', 'use'), []),
    emptyTerms: await safe('Empty searches', () => q.values('search-empty', 'term'), []),
    emptyFrom: await safe('Empty search sources', () => q.values('search-empty', 'from'), []),
  };
} catch (err) {
  fail(err instanceof ApiError ? `Umami returned ${err.message}` : `couldn't read from Umami: ${err.message}`);
}

const report = [
  `# Content health report: ${range.title}`,
  '',
  `${data.stats.pageviews.toLocaleString('en-GB')} page views from ${data.stats.visitors.toLocaleString('en-GB')} visitors on ${SITE_HOST}. ` +
    `Generated ${fmtDate(new Date())} by \`npm run report\` from ${config.base}.`,
  '',
  feedbackSection(data.votes, data.reasons, data.useful, pages),
  '',
  notFoundSection(data.notFound, data.links, data.referrers),
  '',
  notCopiedSection(data.views, data.codeCopies, data.markdownCopies, data.toolUses, pages, args.minViews),
  '',
  emptySearchSection(data.emptyTerms, data.emptyFrom),
  ...(notes.length ? ['', '---', '', '**Notes**', '', ...notes.map((n) => `- ${n}`)] : []),
  '',
].join('\n');

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `content-health-${range.label}.md`);
writeFileSync(file, report);
console.log(`Wrote ${file}`);
