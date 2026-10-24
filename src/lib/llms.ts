// Builds the Markdown served to AI tools: /llms.txt, /llms-full.txt and a .md copy of every content page.
// The page list comes from src/lib/content.ts; this file adds each page's MDX source.
import { SECTIONS, SITE, getContentPages as getPages, sqlVersionLabel, type Frontmatter } from './content';

export type ContentPage = {
  section: string;
  slug: string;
  url: string;   // HTML page
  mdUrl: string; // Markdown copy
  frontmatter: Frontmatter;
  source: string;
};

export const SITE_SUMMARY =
  'A working knowledge base of SQL Server data-fix scripts, integration and operations patterns, browser tools, ' +
  'and hands-on AI guides, shaped by real constraints: messy data, limited schema control, and the need to be reliable.';

const sources = import.meta.glob<string>('/src/pages/*/*.mdx', { eager: true, query: '?raw', import: 'default' });

export function getContentPages(): ContentPage[] {
  return getPages().map((page) => ({
    section: page.section,
    slug: page.slug,
    url: `${SITE}${page.path}`,
    mdUrl: `${SITE}/${page.section}/${page.slug}.md`,
    frontmatter: page.frontmatter,
    source: sources[page.file],
  }));
}

// MDX page source to plain Markdown: drops front matter, imports, components, and style blocks,
// and unwraps inline HTML (tooltips, stage lists). Code blocks and inline code are left untouched.
export function toMarkdown(page: ContentPage): string {
  const { title, description, tags, updated, sqlVersion, sqlNote } = page.frontmatter;
  const body = page.source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  const out: string[] = [];
  let fence = '';
  let inStyle = false;

  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];

    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = '';
      continue;
    }
    if (inStyle) {
      if (line.includes('</style>')) inStyle = false;
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    if (/^\s*<style\b/.test(line)) {
      inStyle = !line.includes('</style>');
      continue;
    }
    if (/^import\s.+\sfrom\s+['"][^'"]+['"];?\s*$/.test(line)) continue;
    // "Open in tool" links become plain links to the tool (the example data isn't carried over)
    const openInTool = line.match(/^\s*<OpenInTool\s.*?\btool="([^"]+)".*\/>\s*$/);
    if (openInTool) {
      const label = line.match(/\blabel="([^"]+)"/)?.[1] ?? 'Open this in the tool';
      out.push(`[${label}](/tools/${openInTool[1]}/)`);
      continue;
    }
    if (/^\s*<[A-Z][A-Za-z0-9]*(\s[^>]*)?\/>\s*$/.test(line)) {
      out.push(`*This page includes an interactive component. Open ${page.url} in a browser to use it.*`);
      continue;
    }
    out.push(unwrapHtml(line));
  }

  const header = [
    `# ${title}`,
    '',
    ...(description ? [`> ${description}`, ''] : []),
    `- URL: ${page.url}`,
    ...(tags?.length ? [`- Tags: ${tags.join(', ')}`] : []),
    ...(updated ? [`- Updated: ${updated}`] : []),
    ...(sqlVersion ? [`- Requires: ${sqlVersionLabel(sqlVersion)}${sqlNote ? `. ${sqlNote}` : ''}`] : []),
    '',
  ];

  return (header.join('\n') + '\n' + out.join('\n'))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\]\(\/(?!\/)/g, `](${SITE}/`) // site-relative links to absolute
    .trim() + '\n';
}

// Strip HTML tags outside `inline code`, turning list items into Markdown bullets.
// Lines that held HTML lose their indentation too, or Markdown would read them as code blocks.
function unwrapHtml(line: string): string {
  let hadHtml = false;
  const text = line
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const stripped = part
        .replace(/<li[^>]*>(.*?)<\/li>/g, '- $1')
        .replace(/<\/?[A-Za-z][^>]*>/g, '');
      if (stripped !== part) hadHtml = true;
      return stripped;
    })
    .join('')
    .replace(/\s+$/, '');
  return hadHtml ? text.trimStart() : text;
}

export function llmsIndex(pages: ContentPage[]): string {
  const lines = [
    '# WebDevRock',
    '',
    `> ${SITE_SUMMARY}`,
    '',
    `Every page listed here is available as clean Markdown at the linked .md URL. The full content of the site in one file is at ${SITE}/llms-full.txt.`,
  ];

  for (const section of SECTIONS) {
    const inSection = pages.filter((p) => p.section === section.key);
    if (inSection.length === 0) continue;
    lines.push('', `## ${section.name}`, '', section.description, '');
    for (const page of inSection) {
      const { title, description } = page.frontmatter;
      lines.push(`- [${title}](${page.mdUrl})${description ? `: ${description}` : ''}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function llmsFull(pages: ContentPage[]): string {
  const intro = ['# WebDevRock: full content', '', `> ${SITE_SUMMARY}`, '', `Index: ${SITE}/llms.txt`].join('\n');
  return [intro, ...pages.map(toMarkdown)].join('\n\n---\n\n');
}
