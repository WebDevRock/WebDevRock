// Rate limiters and a deterministic simulation of a client calling a rate-limited API.
// Every limiter enforces the same limit: 10 requests per 10 seconds, an average of 1 per second.
// The whole run is worked out up front, so the animation only plays it back.

export type LimiterId = 'fixed' | 'sliding' | 'token' | 'leaky';
export type RetryPolicy = 'none' | 'immediate' | 'retry-after';

export const LIMIT = 10;
export const WINDOW = 10; // seconds
export const RATE = LIMIT / WINDOW; // 1 request per second on average
export const TRAVEL = 0.5; // seconds for a request or response to cross the network in the animation
export const IMMEDIATE_RETRY = 0.2; // how soon a careless client resends
export const MAX_ATTEMPTS = 40; // a client gives up on a request after this many tries
export const DURATION = 32; // seconds of simulated time

export const NAMES: Record<LimiterId, string> = {
  fixed: 'Fixed window',
  sliding: 'Sliding window',
  token: 'Token bucket',
  leaky: 'Leaky bucket',
};

type Decision = { ok: true; startAt: number } | { ok: false; retryAfter: number };

interface Limiter {
  decide(t: number): Decision;
}

/** Fixed window: count requests in each 10-second window; the count resets at every boundary */
function fixedWindow(): Limiter {
  let window = -1;
  let count = 0;
  return {
    decide(t) {
      const w = Math.floor(t / WINDOW);
      if (w !== window) {
        window = w;
        count = 0;
      }
      if (count < LIMIT) {
        count++;
        return { ok: true, startAt: t };
      }
      return { ok: false, retryAfter: (w + 1) * WINDOW - t };
    },
  };
}

/** Sliding window log: allow a request if fewer than 10 were allowed in the last 10 seconds */
function slidingWindow(): Limiter {
  const log: number[] = [];
  return {
    decide(t) {
      while (log.length && log[0] <= t - WINDOW) log.shift();
      if (log.length < LIMIT) {
        log.push(t);
        return { ok: true, startAt: t };
      }
      return { ok: false, retryAfter: log[0] + WINDOW - t };
    },
  };
}

/** Token bucket: holds up to 10 tokens, adds 1 per second; each request spends one */
function tokenBucket(): Limiter {
  let tokens = LIMIT;
  let last = 0;
  return {
    decide(t) {
      tokens = Math.min(LIMIT, tokens + (t - last) * RATE);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true, startAt: t };
      }
      return { ok: false, retryAfter: (1 - tokens) / RATE };
    },
  };
}

/** Leaky bucket as a queue: requests wait in a queue of up to 10, and leave at exactly 1 per second */
function leakyBucket(): Limiter {
  const waiting: number[] = []; // when each queued request will be passed on
  let lastStart = -Infinity; // when the most recent request was passed on, which sets the pace
  return {
    decide(t) {
      while (waiting.length && waiting[0] <= t) waiting.shift();
      if (waiting.length < LIMIT) {
        const startAt = Math.max(t, lastStart + 1 / RATE);
        lastStart = startAt;
        if (startAt > t) waiting.push(startAt);
        return { ok: true, startAt };
      }
      return { ok: false, retryAfter: waiting[0] - t };
    },
  };
}

const MAKERS: Record<LimiterId, () => Limiter> = { fixed: fixedWindow, sliding: slidingWindow, token: tokenBucket, leaky: leakyBucket };

export interface Attempt {
  request: number; // which original request this is
  attempt: number; // 1 for the first try
  sendAt: number; // the client sends it
  gateAt: number; // it reaches the rate limiter
  ok: boolean;
  startAt: number; // ok: when the limiter passes it on (later than gateAt only for the leaky bucket)
  apiAt: number; // ok: when it reaches the API
  retryAfter: number; // rejected: the wait the limiter advertises in a Retry-After header
  gaveUp: boolean; // rejected and the client won't try again
}

export interface Run {
  limiter: LimiterId;
  attempts: Attempt[];
}

/** Simulate one limiter against the client's planned send times */
export function simulate(limiter: LimiterId, sends: number[], policy: RetryPolicy): Run {
  const lim = MAKERS[limiter]();
  const attempts: Attempt[] = [];
  // Pending arrivals at the limiter, kept in time order
  const queue: { gateAt: number; sendAt: number; request: number; attempt: number }[] = sends
    .map((s, i) => ({ gateAt: s + TRAVEL, sendAt: s, request: i, attempt: 1 }))
    .sort((a, b) => a.gateAt - b.gateAt || a.request - b.request);

  while (queue.length) {
    const next = queue.shift()!;
    if (next.gateAt > DURATION) break;
    const d = lim.decide(next.gateAt);
    if (d.ok) {
      attempts.push({ ...next, ok: true, startAt: d.startAt, apiAt: d.startAt + TRAVEL, retryAfter: 0, gaveUp: false });
      continue;
    }
    const canRetry = policy !== 'none' && next.attempt < MAX_ATTEMPTS;
    attempts.push({ ...next, ok: false, startAt: 0, apiAt: 0, retryAfter: d.retryAfter, gaveUp: !canRetry });
    if (!canRetry) continue;
    // The client hears back after the response crosses the network, then waits before resending:
    // briefly, or for the Retry-After time the response advertised plus a little random jitter
    const heardAt = next.gateAt + TRAVEL;
    const wait = policy === 'immediate' ? IMMEDIATE_RETRY : d.retryAfter + jitter(next.request, next.attempt);
    const sendAt = heardAt + wait;
    const item = { gateAt: sendAt + TRAVEL, sendAt, request: next.request, attempt: next.attempt + 1 };
    const at = queue.findIndex((q) => q.gateAt > item.gateAt);
    queue.splice(at < 0 ? queue.length : at, 0, item);
  }
  return { limiter, attempts };
}

// A small, repeatable random delay, so retries after the same Retry-After don't all land at once
function jitter(request: number, attempt: number) {
  const x = Math.sin(request * 12.9898 + attempt * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 0.4;
}

// ---------- Summaries ----------
export interface Summary {
  sent: number;
  accepted: number;
  rejected: number;
  completed: number; // original requests that eventually got through
  gaveUp: number;
  peakPerSecond: number; // most requests reaching the API within any 1-second span
  maxWait: number; // longest a request waited in the leaky bucket's queue
}

export function summarise(run: Run, until = Infinity): Summary {
  const seen = run.attempts.filter((a) => a.gateAt <= until);
  const ok = seen.filter((a) => a.ok);
  const api = run.attempts.filter((a) => a.ok && a.apiAt <= until).map((a) => a.apiAt).sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < api.length; i++) {
    while (api[i] - api[j] >= 1) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return {
    sent: run.attempts.filter((a) => a.sendAt <= until).length,
    accepted: ok.length,
    rejected: seen.length - ok.length,
    completed: new Set(ok.map((a) => a.request)).size,
    gaveUp: seen.filter((a) => a.gaveUp).length,
    peakPerSecond: peak,
    maxWait: ok.reduce((m, a) => Math.max(m, a.startAt - a.gateAt), 0),
  };
}

// ---------- Limiter state at a moment, for drawing ----------
export function tokensAt(run: Run, t: number) {
  let tokens = LIMIT;
  let last = 0;
  for (const a of run.attempts) {
    if (a.gateAt > t) break;
    if (!a.ok) continue;
    tokens = Math.min(LIMIT, tokens + (a.gateAt - last) * RATE) - 1;
    last = a.gateAt;
  }
  return Math.min(LIMIT, tokens + (t - last) * RATE);
}

export const fixedCountAt = (run: Run, t: number) => {
  const w = Math.floor(t / WINDOW);
  return run.attempts.filter((a) => a.ok && a.gateAt <= t && Math.floor(a.gateAt / WINDOW) === w).length;
};

export const slidingLogAt = (run: Run, t: number) => run.attempts.filter((a) => a.ok && a.gateAt <= t && a.gateAt > t - WINDOW).map((a) => a.gateAt);

export const leakyQueueAt = (run: Run, t: number) => run.attempts.filter((a) => a.ok && a.gateAt <= t && a.startAt > t);

// ---------- Traffic scenarios ----------
export interface Scenario {
  id: string;
  title: string;
  story: string;
  sends: number[];
  policy: RetryPolicy;
}

const every = (from: number, to: number, gap: number) => {
  const out: number[] = [];
  for (let t = from; t < to - 1e-9; t += gap) out.push(+t.toFixed(3));
  return out;
};
const burst = (at: number, count: number, spread: number) => Array.from({ length: count }, (_, i) => +(at + (i * spread) / count).toFixed(3));

export const SCENARIOS: Scenario[] = [
  {
    id: 'steady',
    title: 'Slightly too fast',
    story: 'A nightly integration job sends a request every 0.8 seconds: 75 a minute, against a limit of 60. It never bursts, it’s just a little over.',
    sends: every(0, 31, 0.8),
    policy: 'none',
  },
  {
    id: 'burst',
    title: 'Midnight burst',
    story: 'At midnight a batch of 30 orders is pushed to the API all at once, then nothing more.',
    sends: burst(1, 30, 0.6),
    policy: 'none',
  },
  {
    id: 'boundary',
    title: 'Either side of a window',
    story: 'Ten requests arrive just before the 10-second mark and ten just after it: twenty requests in about a second.',
    sends: [...burst(8.95, 10, 0.45), ...burst(9.55, 10, 0.45)],
    policy: 'none',
  },
  {
    id: 'storm',
    title: 'Retry storm',
    story: 'The same midnight burst of 30, but the client retries every rejected request straight away. Switch Rejected requests to “Wait for Retry-After” and run it again.',
    sends: burst(1, 30, 0.6),
    policy: 'immediate',
  },
];
