// Thin wrapper around Umami custom events (see ops/umami/README.md).
// Safe to call anywhere: a no-op in dev, before the tracker loads, or when it's blocked.

type EventData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: { track: (name: string, data?: EventData) => void };
  }
}

export function trackEvent(name: string, data?: EventData) {
  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the page
  }
}

let toolUseMuted = false;

// Call from a tool's main action, e.g. trackToolUse('json-formatter', 'format')
export function trackToolUse(tool: string, action: string) {
  // use: both values in one property, so the health report can count copies per tool (npm run report)
  if (!toolUseMuted) trackEvent('tool-use', { tool, action, use: `${action} | ${tool}` });
}

// Runs a tool action without counting it as a use, e.g. showing the result of a shared link as it opens
export function withoutToolUseTracking(action: () => void) {
  toolUseMuted = true;
  try {
    action();
  } finally {
    toolUseMuted = false;
  }
}

// Call from an experiment's controls, e.g. trackExperiment('flocking', 'reset')
export function trackExperiment(experiment: string, action: string) {
  trackEvent('experiment-interact', { experiment, action });
}
