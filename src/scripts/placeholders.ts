// Fill-in placeholders for snippets: the reader's own names replace stand-ins like target_table in every
// code block on the page. Defined per snippet in front matter (see PlaceholderPanel.astro).
// Shared by the panel and the "Copy as Markdown" button, so both use the same values.

export type Placeholder = { token: string; label: string; hint?: string };

const values = new Map<string, string>(); // token -> the reader's value; missing or empty means the default
let pattern: RegExp | undefined;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A token only matches a whole name, but an underscore is allowed either side so names built from it
// follow too: target_table also changes UX_target_table_email, some_column also changes new_some_column
function buildPattern(tokens: string[]): RegExp {
  const alternatives = [...tokens].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<![A-Za-z0-9@#])(${alternatives})(?![A-Za-z0-9])`, 'g');
}

// Inside a longer name only letters, digits and underscores are valid: dbo.Orders -> dbo_Orders
function valueFor(token: string, embedded: boolean): string {
  const value = values.get(token) || token;
  return embedded ? value.replace(/[[\]"`]/g, '').replace(/[^A-Za-z0-9_]+/g, '_') : value;
}

const isEmbedded = (text: string, start: number, end: number) => text[start - 1] === '_' || text[end] === '_';

export function setPlaceholders(placeholders: Placeholder[]) {
  pattern = placeholders.length ? buildPattern(placeholders.map((p) => p.token)) : undefined;
}

export function setValue(token: string, value: string) {
  values.set(token, value.trim());
}

export function hasCustomValues(): boolean {
  return [...values.values()].some(Boolean);
}

// Wraps every token inside the code elements under `root` in a span the panel can update
export function markTokens(root: HTMLElement) {
  if (!pattern) return;
  const regex = pattern;

  for (const code of root.querySelectorAll('code')) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);

    for (const node of nodes) {
      const text = node.data;
      // matchAll starts from the regex's lastIndex, so this must not follow a regex.test() call
      const matches = [...text.matchAll(regex)];
      if (matches.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of matches) {
        const start = match.index!;
        const end = start + match[0].length;
        fragment.append(text.slice(last, start));
        const span = document.createElement('span');
        span.className = 'ph';
        span.dataset.token = match[0];
        if (isEmbedded(text, start, end)) span.dataset.embedded = 'true';
        span.textContent = match[0];
        fragment.append(span);
        last = end;
      }
      fragment.append(text.slice(last));
      node.replaceWith(fragment);
    }
  }
}

// Shows the current values in the spans added by markTokens
export function renderValues(root: HTMLElement) {
  for (const span of root.querySelectorAll<HTMLElement>('.ph[data-token]')) {
    const token = span.dataset.token!;
    span.textContent = valueFor(token, span.dataset.embedded === 'true');
    span.classList.toggle('ph-custom', Boolean(values.get(token)));
  }

  // "Open in tool" links carry the example in readable form (#table=target_table&keys=id), so the reader's
  // names can be swapped in the same way
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-open-in-tool]')) {
    link.dataset.baseHref ??= link.getAttribute('href') ?? '';
    const [path, hash = ''] = link.dataset.baseHref.split('#');
    const params = new URLSearchParams(hash);
    for (const [key, value] of [...params]) params.set(key, replaceTokens(value));
    link.setAttribute('href', `${path}#${params}`);
  }
}

function replaceTokens(text: string): string {
  if (!pattern) return text;
  return text.replace(pattern, (token: string, _group: string, offset: number) =>
    valueFor(token, isEmbedded(text, offset, offset + token.length)),
  );
}

// Applies the reader's values to the page's Markdown copy: code blocks and `inline code` only, so ordinary
// words in the prose (status, email) are left alone
export function customiseMarkdown(markdown: string): string {
  if (!pattern || !hasCustomValues()) return markdown;

  let fence = '';
  return markdown
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = '';
        return fence ? replaceTokens(line) : line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return line.replace(/`[^`\n]+`/g, replaceTokens);
    })
    .join('\n');
}
