// Generates a SQL Server OPENJSON ... WITH (...) query from a sample JSON payload
import { nvarcharFor, quoteName, sqlString } from './sql-format';

export type OpenJsonOptions = {
  path: string; // '' to detect automatically
  flatten: boolean;
  includeSample: boolean;
  intoTemp: boolean;
};

export type OpenJsonColumn = { name: string; path: string; type: string; asJson: boolean; note?: string };

export type OpenJsonResult = { sql: string; path: string; rows: number; columns: OpenJsonColumn[] };

type Stats = {
  path: string;
  kinds: Set<string>;
  maxLength: number;
  maxIntDigits: number;
  maxScale: number;
  bigInt: boolean;
  exponent: boolean;
  allDate: boolean;
  allDateTime: boolean;
  allOffset: boolean;
  allGuid: boolean;
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?$/;
export const OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})$/;
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/; // anything else must be "quoted" in a JSON path

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// '$', '$.data', '$.result.items', '$."my key"'
export function parsePath(path: string): string[] {
  const p = path.trim();
  if (p === '' || p === '$') return [];
  if (!p.startsWith('$.')) throw new Error('Path must start with $ (for example $.data).');

  const segments: string[] = [];
  const re = /\.(?:"((?:[^"\\]|\\.)*)"|([^."[\]]+))/y;
  re.lastIndex = 1;
  while (re.lastIndex < p.length) {
    const m = re.exec(p);
    if (!m) throw new Error(`Unsupported path: ${p}. Use property names only, e.g. $.data.items`);
    segments.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return segments;
}

export function formatPath(segments: string[]): string {
  return '$' + segments.map((s) => '.' + (PATH_IDENT.test(s) ? s : `"${s.replace(/["\\]/g, '\\$&')}"`)).join('');
}

// Prefer the first property holding an array of objects, e.g. { "data": [ ... ] }
export function suggestPath(data: unknown): string[] {
  if (Array.isArray(data) || !isObject(data)) return [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.some(isObject)) return [key];
  }
  for (const [key, value] of Object.entries(data)) {
    if (isObject(value)) {
      const inner = suggestPath(value);
      if (inner.length) return [key, ...inner];
    }
  }
  return [];
}

function resolve(data: unknown, segments: string[]): unknown {
  let current = data;
  for (const s of segments) {
    if (!isObject(current) || !(s in current)) throw new Error(`Nothing found at ${formatPath(segments)}.`);
    current = current[s];
  }
  return current;
}

function newStats(path: string): Stats {
  return {
    path, kinds: new Set(), maxLength: 0, maxIntDigits: 0, maxScale: 0, bigInt: false, exponent: false,
    allDate: true, allDateTime: true, allOffset: true, allGuid: true,
  };
}

function record(stats: Stats, value: unknown) {
  if (value === null || value === undefined) {
    stats.kinds.add('null');
  } else if (typeof value === 'boolean') {
    stats.kinds.add('bool');
    stats.maxLength = Math.max(stats.maxLength, 5);
  } else if (typeof value === 'number') {
    const text = String(value);
    stats.maxLength = Math.max(stats.maxLength, text.length);
    if (/e/i.test(text)) stats.exponent = true;
    if (Number.isInteger(value)) {
      stats.kinds.add('int');
      if (Math.abs(value) > 2147483647) stats.bigInt = true;
    } else {
      stats.kinds.add('dec');
    }
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    stats.maxIntDigits = Math.max(stats.maxIntDigits, whole.length);
    stats.maxScale = Math.max(stats.maxScale, fraction.length);
  } else if (typeof value === 'string') {
    stats.kinds.add('string');
    stats.maxLength = Math.max(stats.maxLength, value.length);
    if (!DATE_RE.test(value)) stats.allDate = false;
    if (!DATETIME_RE.test(value)) stats.allDateTime = false;
    if (!OFFSET_RE.test(value)) stats.allOffset = false;
    if (!GUID_RE.test(value)) stats.allGuid = false;
  } else if (Array.isArray(value)) {
    stats.kinds.add('array');
  } else {
    stats.kinds.add('object');
  }
}

function decide(stats: Stats): { type: string; asJson: boolean; note?: string } {
  const kinds = new Set(stats.kinds);
  kinds.delete('null');

  if (kinds.size === 0) return { type: 'NVARCHAR(100)', asJson: false, note: 'only nulls in sample' };

  const structured = kinds.has('array') || kinds.has('object');
  if (structured) {
    if ([...kinds].every((k) => k === 'array' || k === 'object')) return { type: 'NVARCHAR(MAX)', asJson: true };
    return { type: 'NVARCHAR(MAX)', asJson: false, note: 'mixed types in sample' };
  }

  if (kinds.size === 1 && kinds.has('bool')) return { type: 'BIT', asJson: false };
  if (kinds.size === 1 && kinds.has('int')) return { type: stats.bigInt ? 'BIGINT' : 'INT', asJson: false };

  if ([...kinds].every((k) => k === 'int' || k === 'dec')) {
    if (stats.exponent) return { type: 'FLOAT', asJson: false };
    const scale = Math.min(stats.maxScale, 18);
    const precision = Math.min(38, Math.max(18, stats.maxIntDigits + scale));
    return { type: `DECIMAL(${precision}, ${scale})`, asJson: false };
  }

  if (kinds.size === 1 && kinds.has('string')) {
    if (stats.allDate) return { type: 'DATE', asJson: false };
    if (stats.allOffset) return { type: 'DATETIMEOFFSET', asJson: false };
    if (stats.allDateTime) return { type: 'DATETIME2', asJson: false };
    if (stats.allGuid) return { type: 'UNIQUEIDENTIFIER', asJson: false };
    return { type: nvarcharFor(stats.maxLength), asJson: false };
  }

  return { type: nvarcharFor(stats.maxLength), asJson: false, note: 'mixed types in sample' };
}

// Columns in first-seen order. Nested objects become name_child columns when flattening.
export function inferColumns(rows: unknown[], flatten: boolean): OpenJsonColumn[] {
  const columns = new Map<string, Stats>();

  const visit = (obj: Record<string, unknown>, names: string[], pathSegments: string[]) => {
    for (const [key, value] of Object.entries(obj)) {
      const name = [...names, key].join('_');
      const segments = [...pathSegments, key];
      if (flatten && isObject(value)) {
        visit(value, [...names, key], segments);
        continue;
      }
      if (!columns.has(name)) columns.set(name, newStats(formatPath(segments)));
      record(columns.get(name)!, value);
    }
  };

  const objects = rows.filter(isObject);
  if (objects.length === 0) {
    // Array of plain values: one column reading the element itself
    const stats = newStats('$');
    rows.forEach((v) => record(stats, v));
    return [{ name: 'value', path: '$', ...decide(stats) }];
  }

  objects.forEach((obj) => visit(obj, [], []));

  // Properties missing from some rows come back as NULL, which the stats already allow for.
  // Drop a null-only column when other rows flattened the same property into child columns.
  const names = [...columns.keys()];
  return [...columns.entries()]
    .filter(([name, stats]) => {
      const onlyNull = stats.kinds.size === 1 && stats.kinds.has('null');
      return !(onlyNull && names.some((n) => n.startsWith(name + '_')));
    })
    .map(([name, stats]) => ({ name, path: stats.path, ...decide(stats) }));
}

export function buildOpenJson(jsonText: string, options: OpenJsonOptions): OpenJsonResult {
  const text = jsonText.trim();
  if (!text) throw new Error('Paste a JSON sample.');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`);
  }

  const segments = options.path.trim() ? parsePath(options.path) : suggestPath(data);
  const target = resolve(data, segments);
  if (!Array.isArray(target) && !isObject(target)) {
    throw new Error(`The value at ${formatPath(segments)} must be an object or an array.`);
  }
  const rows = Array.isArray(target) ? target : [target];
  if (rows.length === 0) throw new Error(`The array at ${formatPath(segments)} is empty, so there is nothing to infer from.`);

  const columns = inferColumns(rows, options.flatten);
  const path = formatPath(segments);

  const nameWidth = Math.max(...columns.map((c) => quoteName(c.name).length));
  const typeWidth = Math.max(...columns.map((c) => c.type.length));
  const withLines = columns.map((c, i) => {
    const pathLiteral = `'${c.path.replace(/'/g, "''")}'`;
    const asJson = c.asJson ? ' AS JSON' : '';
    const comma = i < columns.length - 1 ? ',' : '';
    const note = c.note ? `  -- ${c.note}` : '';
    return `  ${quoteName(c.name).padEnd(nameWidth)} ${c.type.padEnd(typeWidth)} ${pathLiteral}${asJson}${comma}${note}`;
  });

  const declare = options.includeSample
    ? `DECLARE @json NVARCHAR(MAX) = ${sqlString(text)};`
    : "DECLARE @json NVARCHAR(MAX) = N'';  -- set to your JSON";

  const source = segments.length ? `OPENJSON(@json, '${path.replace(/'/g, "''")}')` : 'OPENJSON(@json)';

  const sql = [
    declare,
    '',
    'SELECT j.*',
    ...(options.intoTemp ? ['INTO #json_rows'] : []),
    `FROM ${source}`,
    'WITH (',
    ...withLines,
    ') AS j;',
  ].join('\n');

  return { sql, path, rows: rows.length, columns };
}
