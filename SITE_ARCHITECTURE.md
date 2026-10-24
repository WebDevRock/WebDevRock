# webdevrock.uk — Site Architecture

## Technology Choice: Astro

**Why Astro:**
- **Static-first, zero JS by default** — Fast load times, no framework overhead
- **MDX support** — Write content in Markdown with embedded components when needed
- **File-based routing** — Drop a file in `src/pages/`, get a route. No configuration.
- **Component islands** — Add interactivity only where needed (e.g., Tools section)
- **Low maintenance** — No build complexity, no state management, no API routes to maintain
- **Excellent code rendering** — Built-in syntax highlighting with customizable themes

## Site Structure

```
d:\WebDev\WEBDEVROCK\
├── src/
│   ├── pages/               # Routes (file = URL)
│   │   ├── index.astro     # Homepage
│   │   ├── snippets/
│   │   │   ├── index.astro              # /snippets
│   │   │   └── sql-bulk-update-join.mdx # /snippets/sql-bulk-update-join
│   │   ├── patterns/
│   │   │   └── index.astro              # /patterns
│   │   ├── tools/
│   │   │   └── index.astro              # /tools
│   │   └── experiments/
│   │       ├── index.astro              # /experiments
│   │       └── threejs-node-graph.mdx   # /experiments/threejs-node-graph
│   ├── layouts/
│   │   ├── BaseLayout.astro    # HTML structure, nav, footer
│   │   └── ContentLayout.astro # MDX wrapper with metadata display
│   ├── components/
│   │   └── Card.astro          # Reusable card component for listings
│   └── styles/
│       └── global.css          # Dark-mode-first styling
├── public/                     # Static assets (favicon, etc.)
├── astro.config.mjs           # Astro configuration
├── package.json
└── README.md
```

## Navigation Structure

```
Home
├── Snippets     — Copy/paste solutions
├── Patterns     — Architectural approaches
├── Tools        — Browser utilities
└── Experiments  — Visual/technical exploration
```

## Adding New Content

### Add a Snippet
1. Create `src/pages/snippets/your-snippet-name.mdx`
2. Add frontmatter:
   ```markdown
   ---
   layout: ../../layouts/ContentLayout.astro
   title: "Your Snippet Title"
   description: "Brief description"
   tags: [tag1, tag2]
   updated: "2026-02-08"
   ---
   
   ## Your content here
   ```
3. Done. No build step, no index updates.

### Add an Experiment
Same as snippet, but in `src/pages/experiments/`.

For interactive experiments:
1. Create an Astro component in `src/components/` (e.g., `MyExperiment.astro`)
2. Add your JavaScript/TypeScript with imports in the component's `<script>` tag
3. Import the component in your MDX file:

```markdown
---
layout: ../../layouts/ContentLayout.astro
title: "My Experiment"
---

import MyExperiment from '../../components/MyExperiment.astro';

## Demo

<MyExperiment />

## Code
...
```

### Add a Tool
Create `src/pages/tools/your-tool.astro` with interactive components using Astro's client directives (`client:load`, `client:visible`, etc.)

## Design Principles

### Dark Mode First
- Background: `#0d0d0d`
- Surface: `#1a1a1a`
- Accent: `#4a9eff`
- Monospace font for code and logo

### Typography Hierarchy
- Headings: Sans-serif, clear weight distinction
- Body: Readable line height (1.7)
- Code: Monospace with syntax highlighting

### Layout
- Max-width: 1200px for listings, 800px for content
- Sticky nav
- Minimal footer
- No sidebars

## Content Philosophy

### Snippets
- **Problem → Solution → Notes** structure
- Show code first, explain after
- Include variations and gotchas
- Tag by language/domain

### Patterns
- Explain the problem domain
- Show architectural diagram or flow
- Provide implementation examples
- Link to related snippets

### Tools
- Single-purpose utilities
- No backend required
- Work offline
- Clear input/output

### Experiments
- Mark as "work in progress" if incomplete
- Show current state + next steps
- Include code snippets even if broken
- Document learnings and dead ends

## Example Content Templates

### Snippet Template
```markdown
---
layout: ../../layouts/ContentLayout.astro
title: "Your Snippet Title"
description: "Brief description"
tags: [tag1, tag2]
updated: "2026-02-08"
---

## Problem
[What you're trying to solve]

## Solution
[Code block with solution]

## Notes
- Platform-specific considerations
- Performance implications
- Common mistakes

## Variations
[Alternative approaches]
```

### Experiment Template
```markdown
---
layout: ../../layouts/ContentLayout.astro
title: "Your Experiment Title"
description: "Brief description"
tags: [tag1, tag2]
updated: "2026-02-08"
---

## Objective
[What you're exploring]

## Current State
[What works now]

## Demo
[Interactive component or screenshot]

## Code
[Key implementation details]

## Next Steps
- [ ] Todo items
- [ ] Known issues

## Notes
[Learnings, dead ends, references]
```

## Maintenance

### To Add Content
1. Drop an `.mdx` file in the appropriate `src/pages/` folder
2. Use `ContentLayout` wrapper
3. Write in Markdown
4. Deploy

### To Update Listings
Currently manual (cards on index pages). For automatic listing, use:
```javascript
const posts = await Astro.glob('./**/*.mdx');
```

### To Add Dependencies
```bash
npm install [package]
```
For client-side libraries (Three.js, D3, etc.), import directly in `<script>` tags.

## Deployment

Build command:
```bash
npm run build
```

Output: `dist/` folder (static files)

Deploy to:
- Netlify (recommended)
- Vercel
- Cloudflare Pages
- GitHub Pages
- Any static host

## Next Steps

1. Install dependencies: `npm install`
2. Start dev server: `npm run dev`
3. Add more content in `src/pages/`
4. Customize colors in `src/styles/global.css`
5. Deploy to your host of choice
