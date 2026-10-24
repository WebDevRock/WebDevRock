// Works out when each retry happens for an exponential backoff policy

export type Jitter = 'none' | 'full' | 'equal';

export type RetryScheduleOptions = {
  retries: number;
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  timeoutMs: number; // per attempt, 0 if not limited
  jitter: Jitter;
};

export type ScheduleRow = {
  attempt: number;
  minDelayMs: number; // wait before this attempt
  maxDelayMs: number;
  earliestStartMs: number; // every earlier attempt failed instantly, shortest waits
  latestStartMs: number; // every earlier attempt timed out, longest waits
};

export type RetrySchedule = { rows: ScheduleRow[]; bestCaseMs: number; worstCaseMs: number };

export function buildSchedule(o: RetryScheduleOptions): RetrySchedule {
  if (!Number.isInteger(o.retries) || o.retries < 0 || o.retries > 50) throw new Error('Retries must be a whole number from 0 to 50.');
  if (!(o.baseDelayMs > 0)) throw new Error('Base delay must be greater than 0.');
  if (!(o.multiplier >= 1)) throw new Error('Multiplier must be 1 or more.');
  if (!(o.maxDelayMs > 0)) throw new Error('Maximum delay must be greater than 0.');
  if (!(o.timeoutMs >= 0)) throw new Error('Timeout cannot be negative.');

  const rows: ScheduleRow[] = [{ attempt: 1, minDelayMs: 0, maxDelayMs: 0, earliestStartMs: 0, latestStartMs: 0 }];
  let earliest = 0;
  let latest = 0;

  for (let retry = 0; retry < o.retries; retry++) {
    const cap = Math.min(o.maxDelayMs, o.baseDelayMs * o.multiplier ** retry);
    const min = o.jitter === 'full' ? 0 : o.jitter === 'equal' ? cap / 2 : cap;

    earliest += min;
    latest += o.timeoutMs + cap;
    rows.push({ attempt: retry + 2, minDelayMs: min, maxDelayMs: cap, earliestStartMs: earliest, latestStartMs: latest });
  }

  return { rows, bestCaseMs: earliest, worstCaseMs: latest + o.timeoutMs };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${+s.toFixed(1)} s`;

  const total = Math.round(s);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [days && `${days} d`, hours && `${hours} h`, minutes && `${minutes} min`, seconds && !days && `${seconds} s`];
  return parts.filter(Boolean).join(' ');
}

// Options object for fetchWithRetry in /snippets/ts-fetch-retry-backoff
export function toSnippetOptions(o: RetryScheduleOptions): string {
  const n = (v: number) => {
    const rounded = Math.round(v);
    return rounded >= 10000 ? rounded.toLocaleString('en-US').replace(/,/g, '_') : String(rounded);
  };
  return `{ retries: ${o.retries}, baseDelayMs: ${n(o.baseDelayMs)}, maxDelayMs: ${n(o.maxDelayMs)}, timeoutMs: ${n(o.timeoutMs)} }`;
}
