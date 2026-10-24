// Converts a pasted list (one column, or id + value) into SQL Server input
import { nvarcharFor, quoteName, sqlString } from './sql-format';

export type ListFormat = 'in' | 'json' | 'temp';

export type ListOptions = {
  format: ListFormat;
  header: boolean;
  dedupe: boolean;
};

export type ListResult = {
  sql: string;
  rows: number;
  duplicates: number;
  conflicts: string[];
  emptyValues: number;
};

type Column = { name: string; isInt: boolean; isBig: boolean; maxLength: number };

const INT_RE = /^-?(0|[1-9]\d*)$/;
const VALUES_LIMIT = 1000; // SQL Server allows at most 1000 rows in one VALUES list

// One row per line. Two columns are split on the first tab (pasted from Excel) or comma.
// A single line is treated as a comma-separated list of values.
export function parseList(input: string): string[][] {
  const lines = input.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 1 && !lines[0].includes('\t')) {
    return lines[0].split(',').map(clean).filter(Boolean).map((v) => [v]);
  }

  const delimiter = lines.some((line) => line.includes('\t')) ? '\t' : ',';
  return lines.map((line) => {
    const at = line.indexOf(delimiter);
    return (at === -1 ? [line] : [line.slice(0, at), line.slice(at + 1)]).map(clean);
  });
}

// Trim, and unwrap "quoted" CSV values
function clean(cell: string): string {
  const v = cell.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/""/g, '"');
  return v;
}

function describe(name: string, values: string[]): Column {
  const present = values.filter((v) => v !== '');
  const isInt = present.length > 0 && present.every((v) => INT_RE.test(v));
  const isBig = isInt && present.some((v) => Math.abs(Number(v)) > 2147483647);
  const maxLength = Math.max(1, ...present.map((v) => v.length));
  return { name, isInt, isBig, maxLength };
}

function sqlType(col: Column): string {
  if (col.isInt) return col.isBig ? 'BIGINT' : 'INT';
  return nvarcharFor(col.maxLength);
}

function literal(col: Column, value: string): string {
  if (value === '') return 'NULL';
  return col.isInt ? value : sqlString(value);
}

function jsonValue(col: Column, value: string): string | number | null {
  if (value === '') return null;
  return col.isInt && !col.isBig ? Number(value) : value;
}

export function buildListSql(input: string, options: ListOptions): ListResult {
  let rows = parseList(input);

  let names = ['id', 'new_value'];
  if (options.header && rows.length > 0) {
    names = [rows[0][0] || 'id', rows[0][1] || 'new_value'];
    rows = rows.slice(1);
  }
  if (rows.length === 0) throw new Error('Paste at least one value.');

  const twoColumns = rows.some((r) => r.length > 1);

  // Remove repeated ids, keeping the first, and note ids that appear with different values
  let duplicates = 0;
  const conflicts: string[] = [];
  if (options.dedupe) {
    const seen = new Map<string, string>();
    rows = rows.filter((r) => {
      const value = r[1] ?? '';
      if (!seen.has(r[0])) {
        seen.set(r[0], value);
        return true;
      }
      duplicates++;
      if (twoColumns && seen.get(r[0]) !== value && !conflicts.includes(r[0])) conflicts.push(r[0]);
      return false;
    });
  }

  const idCol = describe(names[0], rows.map((r) => r[0]));
  const valueCol = describe(names[1], rows.map((r) => r[1] ?? ''));
  const emptyValues = twoColumns ? rows.filter((r) => (r[1] ?? '') === '').length : 0;

  let sql: string;
  if (options.format === 'in') {
    sql = buildIn(idCol, rows);
  } else if (options.format === 'json') {
    sql = buildJson(idCol, valueCol, rows, twoColumns);
  } else {
    const unique = new Set(rows.map((r) => r[0])).size === rows.length;
    sql = buildTemp(idCol, valueCol, rows, twoColumns, unique);
  }

  return { sql, rows: rows.length, duplicates, conflicts, emptyValues };
}

function buildIn(idCol: Column, rows: string[][]): string {
  const values = rows.map((r) => literal(idCol, r[0]));
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += 10) lines.push('  ' + values.slice(i, i + 10).join(', '));
  return `IN (\n${lines.join(',\n')}\n)`;
}

function buildJson(idCol: Column, valueCol: Column, rows: string[][], twoColumns: boolean): string {
  if (!twoColumns) {
    const json = JSON.stringify(rows.map((r) => jsonValue(idCol, r[0])));
    const cast = idCol.isInt ? `CAST(value AS ${sqlType(idCol)})` : 'value';
    return [
      `DECLARE @ids NVARCHAR(MAX) = ${sqlString(json)};`,
      '',
      `SELECT ${cast} AS ${quoteName(idCol.name)}`,
      'FROM OPENJSON(@ids);',
    ].join('\n');
  }

  const json = JSON.stringify(
    rows.map((r) => ({ [idCol.name]: jsonValue(idCol, r[0]), [valueCol.name]: jsonValue(valueCol, r[1] ?? '') })),
  );
  return [
    `DECLARE @json NVARCHAR(MAX) = ${sqlString(json)};`,
    '',
    'SELECT j.*',
    'FROM OPENJSON(@json)',
    'WITH (',
    `  ${quoteName(idCol.name)} ${sqlType(idCol)} ${jsonPath(idCol.name)},`,
    `  ${quoteName(valueCol.name)} ${sqlType(valueCol)} ${jsonPath(valueCol.name)}`,
    ') AS j;',
  ].join('\n');
}

function jsonPath(name: string): string {
  const segment = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
  return `'$.${segment.replace(/'/g, "''")}'`;
}

function buildTemp(idCol: Column, valueCol: Column, rows: string[][], twoColumns: boolean, unique: boolean): string {
  const id = quoteName(idCol.name);
  const value = quoteName(valueCol.name);
  const columns = twoColumns ? `${id}, ${value}` : id;

  const out = [
    'CREATE TABLE #temp_updates (',
    `  ${id} ${sqlType(idCol)} NOT NULL${unique ? ' PRIMARY KEY' : ''}${twoColumns ? ',' : ''}${unique ? '' : '  -- no PRIMARY KEY: the list contains repeated ids'}`,
  ];
  if (twoColumns) out.push(`  ${value} ${sqlType(valueCol)} NULL`);
  out.push(');');

  for (let i = 0; i < rows.length; i += VALUES_LIMIT) {
    const batch = rows.slice(i, i + VALUES_LIMIT).map((r) =>
      twoColumns ? `(${literal(idCol, r[0])}, ${literal(valueCol, r[1] ?? '')})` : `(${literal(idCol, r[0])})`,
    );
    out.push('', `INSERT INTO #temp_updates (${columns}) VALUES`, batch.join(',\n') + ';');
  }

  return out.join('\n');
}
