// Small DOM helpers shared by the tools in src/pages/tools/
import { trackToolUse } from './analytics';

// Look up a [data-field] element inside a tool, failing loudly if the markup changed
export function field<T extends HTMLElement>(root: HTMLElement, name: string): T {
  const el = root.querySelector<T>(`[data-field="${name}"]`);
  if (!el) throw new Error(`Missing [data-field="${name}"]`);
  return el;
}

export function setStatus(el: HTMLElement, message: string, kind: 'info' | 'warn' | 'error' = 'info') {
  el.textContent = message;
  el.classList.toggle('warn', kind === 'warn');
  el.classList.toggle('error', kind === 'error');
}

// Copies the current text and records a 'copy' use of the tool
export function wireCopyButton(button: HTMLButtonElement, getText: () => string, tool: string) {
  const label = button.textContent ?? 'Copy';

  button.addEventListener('click', async () => {
    const text = getText();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      trackToolUse(tool, 'copy');
      button.textContent = 'Copied!';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = label), 2000);
  });
}
