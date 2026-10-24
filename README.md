# webdevrock.uk

A personal engineering toolkit and knowledge base.

## Structure

- `src/pages/` — Page routes
  - `snippets/` — Copy/paste solutions with short explanations
  - `patterns/` — Higher-level engineering approaches
  - `tools/` — Browser-based utilities
  - `experiments/` — Visual or technical experiments
- `src/layouts/` — Page layouts
- `src/components/` — Reusable components
- `src/styles/` — Global styles

## Development

```bash
npm install
npm run dev
```

## Adding Content

Drop a new `.md` or `.mdx` file into the appropriate folder under `src/pages/`. 

Example MDX file:
```markdown
---
layout: ../../layouts/ContentLayout.astro
title: "Your Title"
tags: [tag1, tag2]
updated: "2026-02-08"
---

Your content here...
```

## Build

```bash
npm run build
```
