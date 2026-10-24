// Saves a tool's inputs into a link and restores them when the link is opened. Link formats and the list
// of fields per tool are in src/lib/tool-links.ts.
import { trackEvent, trackToolUse, withoutToolUseTracking } from './analytics';
import { setStatus } from './tool-ui';
import { TOOL_FIELDS, toolPath } from '../lib/tool-links';

type Values = Record<string, string>;
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// Most chat tools and ticket systems cope with links this long; longer ones get a warning
const LONG_LINK = 2000;

// ---- Encoding: JSON, deflated when the browser supports it, then base64url

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); // chunks: big pastes overflow the call stack
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

async function encode(values: Values): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(values));
  if (typeof CompressionStream === 'undefined') return `j=${toBase64Url(json)}`;
  return `z=${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

async function decode(hash: string): Promise<Values | null> {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const packed = params.get('z') ?? params.get('j');
  if (packed === null) {
    // Readable form: the keys are the field names
    const values = Object.fromEntries(params);
    return Object.keys(values).length ? values : null;
  }
  let bytes = fromBase64Url(packed);
  if (params.has('z')) bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---- Reading and writing the form

function read(field: Field): string {
  return field instanceof HTMLInputElement && field.type === 'checkbox' ? (field.checked ? '1' : '0') : field.value;
}

function isDefault(field: Field): boolean {
  if (field instanceof HTMLInputElement) {
    return field.type === 'checkbox' ? field.checked === field.defaultChecked : field.value === field.defaultValue;
  }
  if (field instanceof HTMLSelectElement) {
    const initial = [...field.options].find((o) => o.defaultSelected) ?? field.options[0];
    return field.value === initial?.value;
  }
  return field.value === field.defaultValue;
}

// Returns false for a value the field can't take (e.g. an option that no longer exists)
function write(field: Field, value: string): boolean {
  if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = value === '1' || value === 'true';
  else if (field instanceof HTMLSelectElement && ![...field.options].some((o) => o.value === value)) return false;
  else field.value = value;
  // Let the tool react, e.g. the data fix script shows the options for the chosen mode
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Adds a "Copy share link" button to the tool and fills it in from the link it was opened with
export function wireToolState(root: HTMLElement, tool: string, status: HTMLElement) {
  const config = TOOL_FIELDS[tool];
  if (!config) throw new Error(`No TOOL_FIELDS entry for ${tool}`);

  const fields = new Map(
    config.fields.map((name) => {
      const el = root.querySelector<Field>(`[data-field="${name}"]`);
      if (!el) throw new Error(`Missing [data-field="${name}"] in ${tool}`);
      return [name, el];
    }),
  );
  const run = root.querySelector<HTMLButtonElement>(`[data-field="${config.run}"]`)!;

  // Share button, next to the tool's own buttons
  const share = document.createElement('button');
  share.type = 'button';
  share.textContent = 'Copy share link';
  root.querySelector('.tool-actions')?.append(share);

  share.addEventListener('click', async () => {
    const changed: Values = {};
    for (const [name, field] of fields) if (!isDefault(field)) changed[name] = read(field);

    try {
      const hash = Object.keys(changed).length ? `#${await encode(changed)}` : '';
      const link = `${location.origin}${toolPath(tool)}${hash}`;
      await navigator.clipboard.writeText(link);
      trackToolUse(tool, 'share');

      const message = hash
        ? "Share link copied. It contains what you've entered, so anyone with the link can see it. The data is in the link only: it isn't sent to webdevrock.uk."
        : 'Link copied. Everything is at its defaults, so the link just opens the tool.';
      const long = link.length > LONG_LINK ? ` The link is ${link.length.toLocaleString()} characters: some chat and ticket tools cut long links, so consider sharing fewer rows.` : '';
      setStatus(status, message + long, long ? 'warn' : 'info');
    } catch (err) {
      console.error('Failed to copy share link:', err);
      setStatus(status, "Couldn't copy the share link.", 'error');
    }
  });

  const restore = async () => {
    if (!location.hash || location.hash === '#') return;
    let values: Values | null;
    try {
      values = await decode(location.hash);
    } catch {
      setStatus(status, "This link's data couldn't be read. It may have been cut short when it was shared.", 'error');
      return;
    }
    if (!values) return;

    const skipped: string[] = [];
    let applied = 0;
    for (const [name, value] of Object.entries(values)) {
      const field = fields.get(name);
      if (field && write(field, String(value))) applied++;
      else skipped.push(name);
    }
    if (!applied) return;

    // Show the result straight away, without counting it as someone using the tool
    withoutToolUseTracking(() => run.click());
    trackEvent('tool-link-open', { tool, kind: /(^|[#&])[zj]=/.test(location.hash) ? 'share' : 'example' });
    if (skipped.length) setStatus(status, `Some of this link's settings no longer apply and were ignored: ${skipped.join(', ')}.`, 'warn');
  };

  restore();
  window.addEventListener('hashchange', restore);
}
