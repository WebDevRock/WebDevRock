// Parses and converts the timestamp formats that integrations exchange

export type TimeKind = 'unix-s' | 'unix-ms' | 'unix-us' | 'unix-ns' | 'ticks' | 'ms-json' | 'text';
export type InputKind = 'auto' | TimeKind;

export type ParsedTime = { ms: number; kind: TimeKind };

export type TimeOutput = { label: string; value: string };

export const KIND_LABELS: Record<TimeKind, string> = {
  'unix-s': 'Unix seconds',
  'unix-ms': 'Unix milliseconds',
  'unix-us': 'Unix microseconds',
  'unix-ns': 'Unix nanoseconds',
  ticks: '.NET ticks',
  'ms-json': 'Microsoft JSON date',
  text: 'Date text',
};

const TICKS_AT_UNIX_EPOCH = 621355968000000000n; // DateTime(1970, 1, 1).Ticks
const MAX_MS = 8.64e15; // JavaScript Date range
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?\d+\.\d+$/;
const MS_JSON_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

// Guess the unit of a whole number from its digit count (for dates within a few centuries of now)
function detectInteger(digits: number): TimeKind {
  if (digits <= 11) return 'unix-s';
  if (digits <= 14) return 'unix-ms';
  if (digits <= 16) return 'unix-us';
  if (digits <= 18) return 'ticks';
  return 'unix-ns';
}

function fromInteger(value: string, kind: TimeKind): number {
  const n = BigInt(value);
  switch (kind) {
    case 'unix-s':
      return Number(n) * 1000;
    case 'unix-ms':
      return Number(n);
    case 'unix-us':
      return Number(n / 1000n);
    case 'unix-ns':
      return Number(n / 1000000n);
    case 'ticks':
      return Number((n - TICKS_AT_UNIX_EPOCH) / 10000n);
    default:
      throw new Error(`${KIND_LABELS[kind]} must be a whole number.`);
  }
}

type DateParts = readonly [number, number, number, number, number, number, number];

// Date.UTC and new Date(y, ...) treat years 0-99 as 1900-1999, so set the year separately
function utcMs([y, mo, d, h, mi, s, ms]: DateParts): number {
  const date = new Date(0);
  date.setUTCFullYear(y, mo, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime();
}

function localMs([y, mo, d, h, mi, s, ms]: DateParts): number {
  const date = new Date(0);
  date.setFullYear(y, mo, d);
  date.setHours(h, mi, s, ms);
  return date.getTime();
}

function fromText(text: string, assumeUtc: boolean): number {
  const m = ISO_RE.exec(text);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '', offset] = m;
    const parts: DateParts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(fraction.padEnd(3, '0').slice(0, 3))];

    // Reject impossible dates such as 2026-02-30 rather than rolling them over
    const check = new Date(utcMs(parts));
    if (check.getUTCMonth() !== parts[1] || check.getUTCDate() !== parts[2] || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) {
      throw new Error(`${text} is not a valid date and time.`);
    }

    if (offset) {
      let offsetMinutes = 0;
      if (offset.toUpperCase() !== 'Z') {
        const sign = offset.startsWith('-') ? -1 : 1;
        const digits = offset.slice(1).replace(':', '');
        offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
      }
      return utcMs(parts) - offsetMinutes * 60000;
    }
    return assumeUtc ? utcMs(parts) : localMs(parts);
  }

  // Anything else the browser understands, e.g. HTTP dates: "Sat, 24 Oct 2026 14:03:05 GMT"
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`Could not read "${text}" as a date or timestamp.`);
  return parsed;
}

export function parseTimestamp(input: string, kind: InputKind, assumeUtc: boolean): ParsedTime {
  const text = input.trim();
  if (!text) throw new Error('Enter a timestamp or date.');

  let result: ParsedTime;
  const msJson = MS_JSON_RE.exec(text);

  if (msJson && (kind === 'auto' || kind === 'ms-json')) {
    result = { ms: Number(msJson[1]), kind: 'ms-json' };
  } else if (INTEGER_RE.test(text) && kind !== 'text' && kind !== 'ms-json') {
    const resolved = kind === 'auto' ? detectInteger(text.replace('-', '').length) : kind;
    result = { ms: fromInteger(text, resolved), kind: resolved };
  } else if (DECIMAL_RE.test(text) && (kind === 'auto' || kind === 'unix-s')) {
    result = { ms: Math.round(Number(text) * 1000), kind: 'unix-s' };
  } else if (kind === 'auto' || kind === 'text') {
    result = { ms: fromText(text, assumeUtc), kind: 'text' };
  } else {
    throw new Error(`"${text}" is not in ${KIND_LABELS[kind]} format.`);
  }

  if (!Number.isFinite(result.ms) || Math.abs(result.ms) > MAX_MS) throw new Error('That value is outside the supported date range.');
  return result;
}

const pad = (n: number, length = 2) => String(n).padStart(length, '0');

function localIso(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function sqlDateAdd(seconds: number): string {
  if (Math.abs(seconds) <= 2147483647) return `DATEADD(SECOND, ${seconds}, '1970-01-01')`;
  // DATEADD only takes an INT, so split very large values into days and seconds
  const days = Math.floor(seconds / 86400);
  return `DATEADD(SECOND, ${seconds - days * 86400}, DATEADD(DAY, ${days}, '1970-01-01'))`;
}

function relative(ms: number, now: number): string {
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000000], ['month', 2592000000], ['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000],
  ];
  const diff = ms - now;
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size || unit === 'second') return rtf.format(Math.round(diff / size), unit);
  }
  return '';
}

export function formatOutputs(ms: number, now = Date.now()): TimeOutput[] {
  const d = new Date(ms);
  const iso = d.toISOString();
  const year = d.getUTCFullYear();
  const inSqlRange = year >= 1 && year <= 9999;
  const sqlLocal = iso.slice(0, 23); // yyyy-mm-ddThh:mm:ss.fff
  const seconds = Math.floor(ms / 1000);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const outOfRange = 'outside the SQL Server range (years 0001 to 9999)';

  return [
    { label: 'ISO 8601 (UTC)', value: iso },
    { label: `ISO 8601 (local, ${zone})`, value: localIso(d) },
    { label: 'Unix seconds', value: String(seconds) },
    { label: 'Unix milliseconds', value: String(ms) },
    { label: '.NET ticks', value: (BigInt(ms) * 10000n + TICKS_AT_UNIX_EPOCH).toString() },
    { label: 'SQL Server datetime2 (UTC)', value: inSqlRange ? `'${sqlLocal}'` : outOfRange },
    { label: 'SQL Server datetimeoffset', value: inSqlRange ? `'${sqlLocal}+00:00'` : outOfRange },
    { label: 'SQL Server from Unix seconds', value: inSqlRange ? sqlDateAdd(seconds) : outOfRange },
    { label: 'HTTP date (Retry-After, Last-Modified)', value: d.toUTCString() },
    {
      label: 'Readable (local)',
      value: new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long' }).format(d),
    },
    { label: 'Relative to now', value: relative(ms, now) },
  ];
}
