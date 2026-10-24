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
| `tool-use` | A tool's main action, via `trackToolUse(tool, action)`. Tools: `list-to-sql` (`temp`, `in`, `json`), `json-to-openjson` (`generate`), `data-fix-script` (`generate-join`, `generate-filter`, `generate-delete-join`, `generate-delete-filter`, `-batched` suffix), `retry-schedule` (`calculate`), `timestamp-converter` (`convert`, `now`); every tool also sends `copy`, and `share` for "Copy share link". Opening a link with inputs shows the result without counting a use | `tool`, `action` |
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
| `tag-click` | Tag links on pages, the tags index and related tags | `target` |
| `next-step-click` | Learning path previous/next links at the end of a page | `target` (`next-<slug>`, `previous-<slug>`, `path-complete`) |
| `related-click` | Related links at the end of a page | `target` (slug) |
| `toc-click` | "On this page" contents on pattern pages and AI guides | `target` (heading id) |
| `rss-click` | RSS feed links | `target` (`footer`, `sidebar`) |
| `not-found` | Every view of the 404 page | `path` (the missing URL), `referrer` (hostname or `direct`) |
| `not-found-click` | Section, home, tags and learning-path links on the 404 page | `target` |

| `feedback` | "Was this useful?" Yes/No at the end of every content page (`PageFeedback.astro`); once per page per browser | `page`, `useful` (`yes`, `no`) |
| `feedback-reason` | The optional follow-up after "No" | `page`, `reason` (`did-not-work`, `hard-to-follow`, `out-of-date`, `missing-something`) |
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

## Maintenance

```bash
cd /opt/umami
docker compose pull && docker compose up -d       # update
docker compose exec db pg_dump -U umami umami | gzip > umami-$(date +%F).sql.gz   # backup
```
