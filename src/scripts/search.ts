// Loads Pagefind's search UI on demand. The index is built by `pagefind --site dist` after `astro build`.
import { trackEvent } from './analytics';

type PagefindUIInstance = { triggerSearch: (term: string) => void };

declare global {
  interface Window {
    PagefindUI?: new (options: Record<string, unknown>) => PagefindUIInstance;
  }
}

let loading: Promise<void> | undefined;

function loadPagefindUI(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/pagefind/pagefind-ui.css';
    document.head.append(css);

    const script = document.createElement('script');
    script.src = '/pagefind/pagefind-ui.js';
    script.onload = () => resolve();
    script.onerror = () => {
      loading = undefined; // allow a retry
      reject(new Error('Pagefind UI not found'));
    };
    document.head.append(script);
  });
  return loading;
}

// Mounts the search UI into `selector` once; later calls just focus the input
export async function mountSearch(selector: string, source: string, initialTerm = ''): Promise<void> {
  const container = document.querySelector<HTMLElement>(selector);
  if (!container) return;

  if (container.dataset.mounted === 'true') {
    container.querySelector('input')?.focus();
    return;
  }
  container.dataset.mounted = 'true';

  try {
    await loadPagefindUI();
    const ui = new window.PagefindUI!({
      element: selector,
      showSubResults: true,
      showImages: false,
      autofocus: true,
      translations: { placeholder: 'Search patterns, snippets and tools' },
    });
    if (initialTerm) ui.triggerSearch(initialTerm);

    container.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
      if (link) trackEvent('search', { action: 'result', target: new URL(link.href).pathname, from: source });
    });
  } catch {
    container.dataset.mounted = 'false';
    container.innerHTML =
      '<p class="search-unavailable">Search isn\'t available here. The index is created by <code>npm run build</code>, so it doesn\'t exist in <code>astro dev</code>.</p>';
  }
}
