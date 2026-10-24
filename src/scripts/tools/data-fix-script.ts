// Builds a reversible SQL Server data fix script: preview, backup, apply, verify, rollback.
// Updates restore the changed columns from the backup; deletes put the deleted rows back.
import { quoteName, quoteObject, splitList, sqlString } from './sql-format';

export type DataFixAction = 'update' | 'delete';
export type DataFixMode = 'join' | 'filter';

export type DataFixOptions = {
  table: string;
  keys: string;     // comma-separated key columns
  columns: string;  // comma-separated columns being changed (updates only)
  action: DataFixAction;
  mode: DataFixMode;
  source: string;   // join mode: table holding the keys (and new_<column> values for an update)
  setClause: string; // filter mode, updates only
  where: string;     // filter mode
  ticket: string;
  batched: boolean;
  batchSize: number;
  date: Date;
};

const pad = (n: number) => String(n).padStart(2, '0');

function backupName(table: string, ticket: string, date: Date): string {
  const parts = table.split('.');
  const schema = parts.length > 1 ? quoteObject(parts.slice(0, -1).join('.')) + '.' : '';
  const ref = ticket.replace(/[^A-Za-z0-9]/g, '') || 'Backup';
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `${schema}DataFix_${ref}_${day}`;
}

export function buildDataFix(o: DataFixOptions): string {
  const table = o.table.trim();
  const keys = splitList(o.keys);
  const columns = splitList(o.columns);

  const deleting = o.action === 'delete';

  if (!table) throw new Error('Enter the table to fix.');
  if (keys.length === 0) throw new Error('Enter at least one key column.');
  if (!deleting && columns.length === 0) throw new Error('Enter at least one column to change.');
  if (o.mode === 'join' && !o.source.trim()) {
    throw new Error(deleting ? 'Enter the table that holds the keys to delete.' : 'Enter the table that holds the new values.');
  }
  if (!deleting && o.mode === 'filter' && !o.setClause.trim()) throw new Error('Enter the SET clause.');
  if (o.mode === 'filter' && !o.where.trim()) {
    throw new Error(`A WHERE clause is required. Without one, every row in the table ${deleting ? 'is deleted' : 'changes'}.`);
  }
  if (o.batched && !(o.batchSize > 0)) throw new Error('Batch size must be a positive number.');

  const target = quoteObject(table);
  const backup = backupName(table, o.ticket.trim(), o.date);
  const k = keys.map(quoteName);
  if (deleting) return buildDelete(o, target, backup, k);
  const c = columns.map(quoteName);
  const newCol = (col: string) => quoteName(`new_${col.replace(/^\[|\]$/g, '')}`);

  const keyJoin = (alias: string) => k.map((key) => `${alias}.${key} = t.${key}`).join('\n AND ');

  // FROM/JOIN/WHERE shared by preview, backup and update
  let scope: string;
  if (o.mode === 'join') {
    // NULL-safe "values differ": true when any column changes, including to or from NULL
    const differs = `EXISTS (SELECT ${c.map((x) => `t.${x}`).join(', ')} EXCEPT SELECT ${columns.map((x) => `s.${newCol(x)}`).join(', ')})`;
    scope = `FROM ${target} t\nJOIN ${quoteObject(o.source.trim())} s\n  ON ${keyJoin('s')}\nWHERE ${differs}`;
  } else {
    scope = `FROM ${target} t\nWHERE ${o.where.trim()}`;
  }

  const setClause =
    o.mode === 'join'
      ? 'SET ' + columns.map((x) => `t.${quoteName(x)} = s.${newCol(x)}`).join(',\n    ')
      : `SET ${o.setClause.trim()}`;

  const previewColumns =
    o.mode === 'join'
      ? [...k.map((x) => `t.${x}`), ...columns.flatMap((x) => [`t.${quoteName(x)} AS ${quoteName(`old_${x.replace(/^\[|\]$/g, '')}`)}`, `s.${newCol(x)}`])]
      : [...k.map((x) => `t.${x}`), ...c.map((x) => `t.${x}`)];

  const header = [
    `-- Data fix${o.ticket.trim() ? `: ${o.ticket.trim()}` : ''}`,
    `-- Target: ${target}`,
    `-- Generated ${o.date.getFullYear()}-${pad(o.date.getMonth() + 1)}-${pad(o.date.getDate())} with webdevrock.uk/tools/data-fix-script`,
    '-- Run one step at a time and check each result before moving on.',
  ];

  const preview = [
    '-- 1) Preview the rows that will change',
    `SELECT ${previewColumns.join(',\n       ')}`,
    `${scope};`,
  ];

  const backupStep = [
    '-- 2) Back up the current rows (the row count should match the preview)',
    'SELECT t.*',
    `INTO ${backup}`,
    `${scope};`,
  ];

  let apply: string[];
  if (!o.batched) {
    apply = [
      '-- 3) Apply the fix',
      'BEGIN TRAN;',
      '',
      'UPDATE t',
      `${setClause}`,
      `${scope};`,
      '',
      'SELECT @@ROWCOUNT AS rows_updated;  -- should match the preview count',
      '',
      '-- COMMIT;',
      '-- ROLLBACK;',
    ];
  } else {
    apply = [
      '-- 3) Apply the fix in batches',
      '--    Each batch commits on its own; use the backup table (step 5) to undo.',
      ...(o.mode === 'filter'
        ? ['--    The WHERE clause must exclude rows already updated, or this loop never ends.']
        : []),
      `DECLARE @batch_size INT = ${Math.floor(o.batchSize)};`,
      'DECLARE @rows INT = 1;',
      'DECLARE @total INT = 0;',
      '',
      'WHILE @rows > 0',
      'BEGIN',
      '  UPDATE TOP (@batch_size) t',
      `  ${setClause.replace(/\n/g, '\n  ')}`,
      `  ${scope.replace(/\n/g, '\n  ')};`,
      '',
      '  SET @rows = @@ROWCOUNT;',
      '  SET @total += @rows;',
      "  RAISERROR('Updated %d rows so far', 0, 1, @total) WITH NOWAIT;",
      '',
      "  IF @rows > 0 WAITFOR DELAY '00:00:01';",
      'END;',
    ];
  }

  const backupJoin = k.map((key) => `b.${key} = t.${key}`).join('\n AND ');

  const verify = [
    '-- 4) Verify: old values from the backup next to the current values',
    `SELECT ${[...k.map((x) => `t.${x}`), ...c.flatMap((x) => [`b.${x} AS ${quoteName(`old_${x.replace(/^\[|\]$/g, '')}`)}`, `t.${x}`])].join(',\n       ')}`,
    `FROM ${target} t`,
    `JOIN ${backup} b`,
    `  ON ${backupJoin};`,
  ];

  const rollback = [
    '-- 5) Rollback, only if needed: restore the changed columns from the backup',
    'BEGIN TRAN;',
    '',
    'UPDATE t',
    'SET ' + c.map((x) => `t.${x} = b.${x}`).join(',\n    '),
    `FROM ${target} t`,
    `JOIN ${backup} b`,
    `  ON ${backupJoin};`,
    '',
    'SELECT @@ROWCOUNT AS rows_restored;',
    '',
    '-- COMMIT;',
    '-- ROLLBACK;',
  ];

  const cleanup = ['-- 6) Once the fix is confirmed stable', `-- DROP TABLE ${backup};`];

  return [header, preview, backupStep, apply, verify, rollback, cleanup].map((s) => s.join('\n')).join('\n\n');
}

// Delete: back up whole rows, delete exactly the backed-up rows, and put them back with an INSERT if needed
function buildDelete(o: DataFixOptions, target: string, backup: string, k: string[]): string {
  // EXISTS rather than JOIN, so a key listed twice can't put the same row in the backup twice
  const scope =
    o.mode === 'join'
      ? `FROM ${target} t\nWHERE EXISTS (\n  SELECT 1 FROM ${quoteObject(o.source.trim())} s\n  WHERE ${k.map((key) => `s.${key} = t.${key}`).join(' AND ')}\n)`
      : `FROM ${target} t\nWHERE ${o.where.trim()}`;

  const backupJoin = k.map((key) => `b.${key} = t.${key}`).join('\n AND ');
  const objectId = `OBJECT_ID(${sqlString(target)})`;

  const header = [
    `-- Data delete${o.ticket.trim() ? `: ${o.ticket.trim()}` : ''}`,
    `-- Target: ${target}`,
    `-- Generated ${o.date.getFullYear()}-${pad(o.date.getMonth() + 1)}-${pad(o.date.getDate())} with webdevrock.uk/tools/data-fix-script`,
    '-- Run one step at a time and check each result before moving on.',
  ];

  const preview = [
    '-- 1) Preview the rows that will be deleted',
    'SELECT COUNT(*) AS rows_to_delete',
    `${scope};`,
    '',
    'SELECT TOP (100) t.*',
    `${scope};`,
  ];

  const references = [
    '-- 2) Check for tables that reference this one. If they hold rows pointing at the rows being deleted,',
    "--    the delete fails (NO_ACTION) or also deletes or changes those rows (CASCADE, SET_NULL), which step 6 can't undo.",
    "SELECT OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS referencing_table,",
    '       fk.name AS foreign_key,',
    '       fk.delete_referential_action_desc AS on_delete',
    'FROM sys.foreign_keys fk',
    `WHERE fk.referenced_object_id = ${objectId};`,
  ];

  const backupStep = [
    '-- 3) Back up the whole rows (the row count should match the preview)',
    'SELECT t.*',
    `INTO ${backup}`,
    `${scope};`,
  ];

  // Joining to the backup deletes exactly the rows that were saved, even if more rows have started to
  // match since step 3, so everything deleted can be restored
  let apply: string[];
  if (!o.batched) {
    apply = [
      '-- 4) Delete the backed-up rows',
      'BEGIN TRAN;',
      '',
      'DELETE t',
      `FROM ${target} t`,
      `JOIN ${backup} b`,
      `  ON ${backupJoin};`,
      '',
      'SELECT @@ROWCOUNT AS rows_deleted;  -- should match the backup row count',
      '',
      '-- COMMIT;',
      '-- ROLLBACK;',
    ];
  } else {
    apply = [
      '-- 4) Delete the backed-up rows in batches',
      '--    Each batch commits on its own; restore from the backup (step 6) to undo.',
      `DECLARE @batch_size INT = ${Math.floor(o.batchSize)};`,
      'DECLARE @rows INT = 1;',
      'DECLARE @total INT = 0;',
      '',
      'WHILE @rows > 0',
      'BEGIN',
      '  DELETE TOP (@batch_size) t',
      `  FROM ${target} t`,
      `  JOIN ${backup} b`,
      `    ON ${backupJoin.replace(/\n/g, '\n  ')};`,
      '',
      '  SET @rows = @@ROWCOUNT;',
      '  SET @total += @rows;',
      "  RAISERROR('Deleted %d rows so far', 0, 1, @total) WITH NOWAIT;",
      '',
      "  IF @rows > 0 WAITFOR DELAY '00:00:01';",
      'END;',
    ];
  }

  const verify = [
    '-- 5) Verify: none of the backed-up rows should be left',
    'SELECT COUNT(*) AS rows_still_present  -- should be 0',
    `FROM ${target} t`,
    `JOIN ${backup} b`,
    `  ON ${backupJoin};`,
    '',
    `SELECT COUNT(*) AS rows_in_backup FROM ${backup};`,
  ];

  const restore = [
    '-- 6) Restore, only if needed: put the deleted rows back',
    '--    6a) Get the columns to insert. Computed and rowversion columns are left out because SQL Server',
    '--        fills them in itself; has_identity says whether 6b needs its IDENTITY_INSERT lines.',
    "SELECT STUFF((SELECT ', ' + QUOTENAME(c.name)",
    '              FROM sys.columns c',
    `              WHERE c.object_id = ${objectId}`,
    "                AND c.is_computed = 0 AND TYPE_NAME(c.system_type_id) <> 'timestamp'",
    '              ORDER BY c.column_id',
    "              FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS column_list,",
    `       OBJECTPROPERTY(${objectId}, 'TableHasIdentity') AS has_identity;`,
    '',
    '--    6b) Paste column_list over both /* column_list */ placeholders. If has_identity is 0, remove the',
    '--        two IDENTITY_INSERT lines. Rows that are already back in the table are skipped.',
    'BEGIN TRAN;',
    '',
    `SET IDENTITY_INSERT ${target} ON;`,
    '',
    `INSERT INTO ${target} (/* column_list */)`,
    'SELECT /* column_list */',
    `FROM ${backup} b`,
    `WHERE NOT EXISTS (SELECT 1 FROM ${target} t WHERE ${k.map((key) => `t.${key} = b.${key}`).join(' AND ')});`,
    '',
    'SELECT @@ROWCOUNT AS rows_restored;',
    '',
    `SET IDENTITY_INSERT ${target} OFF;`,
    '',
    '-- COMMIT;',
    '-- ROLLBACK;',
  ];

  const cleanup = ['-- 7) Once the delete is confirmed', `-- DROP TABLE ${backup};`];

  return [header, preview, references, backupStep, apply, verify, restore, cleanup].map((s) => s.join('\n')).join('\n\n');
}
