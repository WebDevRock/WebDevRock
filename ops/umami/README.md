# Self-hosted Umami

Umami runs on the droplet at `https://stats.webdevrock.uk`, separate from the static site.
`deploy.ps1` only copies `dist/`, so nothing in this folder is ever published.

## 1. DNS

Add an `A` record: `stats.webdevrock.uk` → `167.172.53.49`.

## 2. Install Docker (once)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards
```

## 3. Copy the files and create secrets

From this folder on Windows:

```powershell
ssh chris@167.172.53.49 "sudo mkdir -p /opt/umami && sudo chown chris /opt/umami"
scp docker-compose.yml stats.webdevrock.uk.nginx.conf chris@167.172.53.49:/opt/umami/
```

On the droplet:

```bash
cd /opt/umami
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
APP_SECRET=$(openssl rand -hex 32)
TWO_FACTOR_ENCRYPTION_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env
docker compose up -d
docker compose ps                         # both services should become "healthy"
curl -s http://127.0.0.1:3000/api/heartbeat
```

## 4. nginx + HTTPS

```bash
sudo cp /opt/umami/stats.webdevrock.uk.nginx.conf /etc/nginx/sites-available/stats.webdevrock.uk
sudo ln -s /etc/nginx/sites-available/stats.webdevrock.uk /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d stats.webdevrock.uk
```

## 5. Log in and add the site

1. Open `https://stats.webdevrock.uk` and log in as `admin` / `umami`.
2. **Change the password immediately** (Settings → Profile) — the login page is public.
   Then log out and back in: the old session gets "Unauthorized" errors after a password change.
3. Settings → Websites → Add website: name `WebDevRock`, domain `webdevrock.uk`.
4. Copy the **Website ID** (a UUID).

## 6. Wire up the site

In the project root, copy `.env.example` to `.env.production` (gitignored) and fill in the ID:

```
PUBLIC_UMAMI_SRC=https://stats.webdevrock.uk/script.js
PUBLIC_UMAMI_WEBSITE_ID=<website id from step 5>
```

Then `npm run deploy`. `BaseLayout.astro` only emits the tracker in production builds
when both values are set, and `data-domains` stops localhost/preview traffic being counted.
`data-exclude-hash` keeps everything after `#` out of recorded URLs: tool share links carry the
reader's pasted data there.

## Custom events

Helpers live in `src/scripts/analytics.ts` and are no-ops when the tracker isn't loaded.

| Event | Fired from | Data |
|---|---|---|
| `code-copy` | Copy button on any code block (`ContentLayout.astro`) | `page`, `section` (snippets, patterns, ai…), `language`, `block` (1-based index on the page) |
| `tool-use` | A tool's main action, via `trackToolUse(tool, action)`. Tools: `list-to-sql` (`temp`, `in`, `json`), `json-to-openjson` (`generate`), `data-fix-script` (`generate-join`, `generate-filter`, `generate-delete-join`, `generate-delete-filter`, `-batched` suffix), `retry-schedule` (`calculate`), `timestamp-converter` (`convert`, `now`); every tool also sends `copy`, and `share` for "Copy share link". Opening a link with inputs shows the result without counting a use | `tool`, `action`, `use` (`<action> \| <tool>`, for the health report) |
| `experiment-interact` | Experiment controls, via `trackExperiment(experiment, action)`: flocking Reset button (`flocking` / `reset`), first orbit/zoom of the node graph per page view (`node-graph` / `orbit`) | `experiment`, `action` |

When adding a tool, either call the helper from its script:

```ts
import { trackToolUse } from '../../scripts/analytics';
formatButton.addEventListener('click', () => { /* ... */ trackToolUse('json-formatter', 'format'); });
```

or, for a plain button, use Umami's data attributes (no JS needed):

```html
<button data-umami-event="tool-use" data-umami-event-tool="json-formatter" data-umami-event-action="format">Format</button>
```

Navigation events, sent with `data-umami-event` attributes or from the search script:

| Event | Fired from | Data |
|---|---|---|
| `nav-click` | Section links in the sidebar | `target` (section key, e.g. `patterns`) |
| `home-click` | Homepage palette (tasks, and pages it finds), learning paths, tools and section tiles | `target` (e.g. `task-list-to-sql`, `palette-sql-pass-id-list`, `section-patterns`) |
| `page-list-click` | Page lists: homepage "Recently updated" and tag pages | `target` (`recent-<slug>`, `tag-<tag>-<slug>`) |
| `search` | Search dialog and `/search/` | `action` (`open`, `result`), `from` (`button`, `shortcut`, `dialog`, `page`), `target` (result path) |
| `search-empty` | A search in the dialog, `/search/` or the 404 page that finds nothing, once the results settle; once per term per page view | `term` (lower case, at most 60 characters, email addresses and long numbers removed), `from` (`dialog`, `page`, `not-found`) |
| `tag-click` | Tag links on pages, the tags index and related tags | `target` |
| `next-step-click` | Learning path previous/next links at the end of a page | `target` (`next-<slug>`, `previous-<slug>`, `path-complete`) |
| `related-click` | Related links at the end of a page | `target` (slug) |
| `toc-click` | "On this page" contents on pattern pages and AI guides | `target` (heading id) |
| `rss-click` | RSS feed links | `target` (`footer`, `sidebar`) |
| `not-found` | Every view of the 404 page | `path` (the missing URL), `referrer` (hostname or `direct`), `link` (`<referrer> \| <path>`) |
| `not-found-click` | Section, home, tags and learning-path links on the 404 page | `target` |

| `feedback` | "Was this useful?" Yes/No at the end of every content page (`PageFeedback.astro`); once per page per browser | `page`, `useful` (`yes`, `no`), `vote` (`<useful> \| <page>`) |
| `feedback-reason` | The optional follow-up after "No" | `page`, `reason` (`did-not-work`, `hard-to-follow`, `out-of-date`, `missing-something`), `pageReason` (`<reason> \| <page>`) |
| `markdown-copy` | "Copy as Markdown" under each content page title (`CopyMarkdown.astro`), after a successful copy | `page` |
| `markdown-view` | The "View .md" link next to it | `page` |

| `snippet-customise` | First edit of each field in a snippet's "Your values" panel, per page view (`PlaceholderPanel.astro`) | `page`, `placeholder` (the stand-in name, e.g. `target_table`) |
| `checklist` | The tick list under "Checks" on patterns (`ChecksChecklist.astro`) | `page`, `action` (`tick` once per page view, `complete`, `copy`, `clear`) |
| `version-filter` | "My SQL Server" filter on the snippets page | `version` (`2008`…`2025`, `azure`, `any`), `from` (`snippets`) |
| `open-in-tool` | "Open in tool" links on snippets (`OpenInTool.astro`) | `tool` |
| `tool-link-open` | A tool opened from a link with inputs in it | `tool`, `kind` (`example` from a snippet, `share` from a share link) |

For a page's usefulness, filter `feedback` by `page` and compare `useful` = `yes` against `no`; the `feedback-reason` counts show what to fix.

Searches from the 404 page send `search` with `from` = `not-found`. Filter `not-found` by `referrer` to find broken links on other sites.

View them in Umami under **Events**; filter `code-copy` by `section = snippets` for snippet copies.

## Monthly content health report

`npm run report` reads this Umami instance through its API and writes `reports/content-health-<period>.md`
(git-ignored, as it includes search terms):

- **Least useful pages**: "No" answers per page with the reasons given (`feedback` → `vote`, `feedback-reason` → `pageReason`)
- **Missing pages**: the most visited 404 addresses, and which other sites link to them (`not-found` → `path`, `link`)
- **Read but never copied**: pages with code or a tool, read at least 10 times, that nobody copied from
  (page views, plus `code-copy` and `markdown-copy` → `page` and `tool-use` → `use`)
- **Searches that found nothing** (`search-empty` → `term`)

Umami reports one event property at a time, so events carry the pairs the report needs as a single
`<first> | <second>` property. Events sent before those were added (24 Oct 2026) can't be matched to pages.

Setup, once:

1. In Umami, create a user with the **View only** role and give it access to the WebDevRock website.
   The report only reads, so it doesn't need your admin login.
2. Copy `.env.report.example` (project root) to `.env.report` and fill in that user's name and password.
   The Umami address and website id come from `.env.production`.

Then:

```bash
npm run report                      # the last 30 days
npm run report -- --month 2026-11   # a calendar month
npm run report -- --min-views 5     # list pages in "read but never copied" from 5 views (default 10)
```

It works with self-hosted Umami 2 and 3 (it tries both forms of the API where they differ) and with
Umami Cloud (`UMAMI_API_KEY` and `UMAMI_URL=https://api.umami.is/v1` in `.env.report`). If a query isn't
accepted, the report still gets written, with a note at the end naming what's missing.

## Maintenance

```bash
cd /opt/umami
docker compose pull && docker compose up -d       # update
docker compose exec db pg_dump -U umami umami | gzip > umami-$(date +%F).sql.gz   # backup
```
