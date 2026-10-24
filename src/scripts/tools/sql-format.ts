// SQL Server formatting helpers shared by the tools

const SIMPLE_IDENT = /^#{0,2}[A-Za-z_][A-Za-z0-9_@$#]*$/;

// T-SQL reserved keywords: names matching these must be bracket-quoted
const RESERVED = new Set(
  `add all alter and any as asc authorization backup begin between break browse bulk by cascade case check
  checkpoint close clustered coalesce collate column commit compute constraint contains containstable continue
  convert create cross current current_date current_time current_timestamp current_user cursor database dbcc
  deallocate declare default delete deny desc disk distinct distributed double drop dump else end errlvl escape
  except exec execute exists exit external fetch file fillfactor for foreign freetext freetexttable from full
  function goto grant group having holdlock identity identity_insert identitycol if in index inner insert
  intersect into is join key kill left like lineno load merge national nocheck nonclustered not null nullif of
  off offsets on open opendatasource openquery openrowset openxml option or order outer over percent pivot plan
  precision primary print proc procedure public raiserror read readtext reconfigure references replication
  restore restrict return revert revoke right rollback rowcount rowguidcol rule save schema securityaudit select
  semantickeyphrasetable semanticsimilaritydetailstable semanticsimilaritytable session_user set setuser shutdown
  some statistics system_user table tablesample textsize then to top tran transaction trigger truncate
  try_convert tsequal union unique unpivot update updatetext use user values varying view waitfor when where
  while with writetext`.split(/\s+/),
);

// Bracket-quote one name part when it is not a plain identifier
export function quoteName(name: string): string {
  const n = name.trim();
  if (n.startsWith('[') && n.endsWith(']')) return n;
  if (SIMPLE_IDENT.test(n) && !RESERVED.has(n.toLowerCase())) return n;
  return `[${n.replace(/]/g, ']]')}]`;
}

// Quote a possibly schema-qualified name such as dbo.Customer
export function quoteObject(name: string): string {
  return name
    .split('.')
    .map((part) => quoteName(part))
    .join('.');
}

// N'...' string literal
export function sqlString(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

// Smallest common NVARCHAR size that fits, or MAX
export function nvarcharFor(maxLength: number): string {
  for (const size of [50, 100, 255, 500, 1000, 4000]) {
    if (maxLength <= size) return `NVARCHAR(${size})`;
  }
  return 'NVARCHAR(MAX)';
}

export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
