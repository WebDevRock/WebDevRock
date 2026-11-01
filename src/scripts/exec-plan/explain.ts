// Plain-English explanations of plan operators and warnings, and a short summary of what a plan says.
import { rowsOut, type MissingIndex, type PlanNode, type PlanStatement, type PlanWarning } from './parse';

export type Category = 'scan' | 'seek' | 'lookup' | 'join' | 'aggregate' | 'other' | 'statement';

export function category(n: PlanNode): Category {
  if (n.isStatement) return 'statement';
  switch (n.base) {
    case 'Clustered Index Scan':
    case 'Index Scan':
    case 'Table Scan':
    case 'Columnstore Index Scan':
      return 'scan';
    case 'Clustered Index Seek':
    case 'Index Seek':
      return 'seek';
    case 'Key Lookup':
    case 'RID Lookup':
      return 'lookup';
    case 'Nested Loops':
    case 'Merge Join':
    case 'Adaptive Join':
      return 'join';
    case 'Hash Match':
      return n.logicalOp.includes('Join') || n.logicalOp.includes('Semi') || n.logicalOp.includes('Union') ? 'join' : 'aggregate';
    case 'Sort':
    case 'Stream Aggregate':
    case 'Segment':
    case 'Sequence Project':
    case 'Window Aggregate':
    case 'Window Spool':
      return 'aggregate';
    default:
      return 'other';
  }
}

const OPERATORS: Record<string, string> = {
  Statement: 'The statement itself. Rows arriving here are the query’s results, sent back to the application.',
  'Clustered Index Scan':
    'Reads every row of the table, in the order the table is stored, and keeps the rows that match any condition. On a large table this is expensive. It often means no index fits the query.',
  'Clustered Index Seek': 'Uses the table’s clustered index to go straight to the matching rows, reading only the pages it needs.',
  'Index Seek': 'Uses a nonclustered index to go straight to the matching entries. Cheap, but the index may not hold every column the query needs.',
  'Index Scan':
    'Reads every entry in a nonclustered index. Cheaper than reading the whole table, because the index is smaller, but it still reads everything.',
  'Key Lookup':
    'For each row coming from an index, fetches the remaining columns from the table’s clustered index. That’s one seek per row: cheap for a few rows, expensive for thousands. Adding the columns to the index with INCLUDE removes it.',
  'RID Lookup': 'Like a Key Lookup, for a table without a clustered index (a heap): fetches each row by its physical location.',
  'Table Scan': 'Reads every row of a heap, a table without a clustered index.',
  'Columnstore Index Scan': 'Reads a columnstore index, which stores data by column and can process rows in batches. Good for large aggregations.',
  'Nested Loops':
    'For each row from the top input, runs the bottom input once. Fast when the top input is small, and slow when it’s large.',
  'Merge Join': 'Joins two inputs that are already sorted on the join columns, by walking through both in step.',
  'Adaptive Join': 'Chooses between a hash join and nested loops while the query runs, based on how many rows actually arrive.',
  'Hash Match join':
    'Builds a hash table in memory from the top input, then checks every row of the bottom input against it. Suits large, unsorted inputs. It needs a memory grant, and writes to tempdb (spills) if the grant is too small.',
  'Hash Match aggregate': 'Groups rows using a hash table in memory, with one entry per group. Needs a memory grant.',
  Sort: 'Sorts its input. It needs a memory grant, and must read every input row before it can return the first one.',
  'Stream Aggregate': 'Groups rows that arrive already sorted, or calculates a single total such as COUNT(*).',
  'Compute Scalar': 'Calculates a value, such as an expression in the SELECT list. Usually costs next to nothing.',
  Filter: 'Keeps only the rows that match a condition.',
  Top: 'Returns only the first rows and then stops asking for more.',
  Parallelism: 'Moves rows between threads when the query runs in parallel: gathering, redistributing or splitting the streams.',
  Concatenation: 'Combines several inputs one after another, as UNION ALL does.',
  'Constant Scan': 'Produces rows from fixed values without reading a table.',
  'Table Spool': 'Saves rows in a hidden worktable in tempdb so they can be read again without recalculating them.',
  'Index Spool': 'Builds a temporary index in tempdb while the query runs. Often a sign that a real index is missing.',
  Segment: 'Marks where each group starts, for window functions such as ROW_NUMBER().',
  'Sequence Project': 'Calculates window functions such as ROW_NUMBER() or RANK().',
  'Window Spool': 'Holds rows for a window function’s frame, such as a running total.',
  Assert: 'Checks a condition, such as a foreign key or a subquery returning one row, and raises an error if it fails.',
  'Clustered Index Insert': 'Writes new rows to the table.',
  'Clustered Index Update': 'Changes rows in the table.',
  'Clustered Index Delete': 'Removes rows from the table.',
  'Index Insert': 'Adds entries to a nonclustered index.',
  'Index Update': 'Changes entries in a nonclustered index.',
  'Index Delete': 'Removes entries from a nonclustered index.',
};

export function explainOperator(n: PlanNode): string {
  if (n.base === 'Hash Match') return OPERATORS[category(n) === 'join' ? 'Hash Match join' : 'Hash Match aggregate'];
  return OPERATORS[n.base] ?? OPERATORS[n.physicalOp] ?? `${n.physicalOp}. Microsoft’s showplan operator reference describes what it does.`;
}

export function explainWarning(w: PlanWarning): string {
  switch (w.kind) {
    case 'SpillToTempDb':
      return 'Ran out of its memory grant and wrote rows to tempdb, which is much slower than working in memory. It usually happens when SQL Server expected fewer rows than arrived, so it asked for too little memory.';
    case 'PlanAffectingConvert':
      return w.detail.startsWith('Seek Plan')
        ? 'A data type conversion (CONVERT_IMPLICIT) on a column stops SQL Server seeking an index. Usually a value of a different type from the column, such as nvarchar against varchar.'
        : 'A data type conversion may make the row estimates less accurate.';
    case 'NoJoinPredicate':
      return 'This join has no join condition, so every row is matched with every row from the other input.';
    case 'ColumnsWithNoStatistics':
      return 'These columns have no statistics, so the row estimates for them are guesses.';
    case 'MemoryGrantWarning':
      return 'The memory grant didn’t fit what the query used: too much is wasted memory, too little causes spills.';
    case 'UnmatchedIndexes':
      return 'A filtered index couldn’t be used because of how the query was parameterised.';
    default:
      return `${w.kind}.`;
  }
}

export const fmtRows = (n: number) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (Number.isInteger(n)) return n.toLocaleString('en-GB');
  return n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-GB');
};

export const fmtPct = (share: number) => {
  const p = share * 100;
  if (p === 0) return '0%';
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
};

export const objectName = (n: PlanNode) => (n.object ? `${n.object.table}${n.object.index ? ` (${n.object.index})` : ''}` : '');

/** Total estimated rows across all executions, to compare with actual rows */
export const estimatedTotal = (n: PlanNode) => n.estRows * n.estExecutions;

/** How far the actual rows were from the estimate, as a ratio of at least 1 (null if not an actual plan) */
export function misestimate(n: PlanNode): number | null {
  if (n.actualRows === null || n.isStatement) return null;
  const est = Math.max(estimatedTotal(n), 1);
  const act = Math.max(n.actualRows, 1);
  return Math.max(est / act, act / est);
}

export function createIndexSql(mi: MissingIndex) {
  const keys = [...mi.equality, ...mi.inequality];
  const name = `IX_${mi.table}_${keys.join('_')}`;
  const include = mi.include.length ? `\nINCLUDE (${mi.include.join(', ')})` : '';
  return `CREATE INDEX ${name}\nON ${mi.schema}.${mi.table} (${keys.join(', ')})${include};`;
}

export interface Finding {
  tone: 'info' | 'warn' | 'good';
  text: string;
  node?: PlanNode;
  sql?: string;
}

// What a reader should take away from the plan, most important first
export function summarise(s: PlanStatement): Finding[] {
  const out: Finding[] = [];
  const ops = s.nodes.filter((n) => !n.isStatement);
  const top = [...ops].sort((a, b) => b.cost - a.cost)[0];

  if (top) {
    out.push({
      tone: top.costShare > 0.5 && category(top) === 'scan' ? 'warn' : 'info',
      text: `${fmtPct(top.costShare)} of the estimated cost is the ${top.name}${top.object ? ` on ${top.object.table}` : ''}.`,
      node: top,
    });
  }

  for (const n of ops.filter((o) => category(o) === 'scan')) {
    const read = n.actualRowsRead ?? n.estRowsRead ?? n.tableCardinality;
    const returned = rowsOut(n);
    if (read && read >= 1000 && returned * 20 < read) {
      const converted = /CONVERT_IMPLICIT/i.test(n.predicate ?? '');
      out.push({
        tone: 'warn',
        text: `The ${n.name} on ${n.object?.table ?? 'the table'} reads ${fmtRows(read)} rows to return ${fmtRows(returned)}${n.actualRowsRead !== null ? '' : ' (estimated)'}. ${
          converted
            ? 'Its condition converts the column to another data type (CONVERT_IMPLICIT) before comparing, so the index can only be scanned, not seeked. Pass the value with the same data type as the column.'
            : 'An index that matches the condition would let it seek instead.'
        }`,
        node: n,
      });
    }
  }

  for (const n of ops.filter((o) => o.base === 'Key Lookup' || o.base === 'RID Lookup')) {
    const execs = n.actualExecutions ?? n.estExecutions;
    const cols = n.outputColumns.filter(Boolean);
    out.push({
      tone: execs > 1000 ? 'warn' : 'info',
      text: `The ${n.base} runs ${fmtRows(execs)} time${execs === 1 ? '' : 's'}, once for each row from the index, to fetch ${cols.length ? cols.join(', ') : 'more columns'}. ${cols.length ? `Adding ${cols.join(', ')} to the index with INCLUDE would remove it.` : ''}`.trim(),
      node: n,
    });
  }

  // Report a misestimate where it starts: skip an operator whose input was already off by the same rows
  const inherited = (n: PlanNode) => n.children.some((c) => (misestimate(c) ?? 0) >= 3 && c.actualRows === n.actualRows);
  const misses = ops
    .map((n) => ({ n, ratio: misestimate(n) }))
    .filter((m): m is { n: PlanNode; ratio: number } => m.ratio !== null && m.ratio >= 3 && Math.max(estimatedTotal(m.n), m.n.actualRows ?? 0) >= 100)
    .filter((m) => !inherited(m.n))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 2);
  for (const { n, ratio } of misses) {
    const under = (n.actualRows ?? 0) > estimatedTotal(n);
    out.push({
      tone: 'warn',
      text: `At the ${n.name}${n.object ? ` on ${n.object.table}` : ''}, SQL Server expected ${fmtRows(estimatedTotal(n))} rows and got ${fmtRows(n.actualRows ?? 0)}: ${under ? 'about' : 'roughly'} ${Math.round(ratio)} times ${under ? 'more' : 'fewer'}. Plans are built on these estimates, so a wrong one can lead to the wrong join, too little memory, or a scan where a seek would do. Outdated statistics are a common cause.`,
      node: n,
    });
  }

  for (const n of ops) {
    for (const w of n.warnings) out.push({ tone: 'warn', text: `Warning on the ${n.name}: ${explainWarning(w)}`, node: n });
  }
  const seekConverts = s.warnings.filter((w) => w.kind === 'PlanAffectingConvert' && w.detail.startsWith('Seek Plan'));
  for (const w of s.warnings) {
    if (w.kind === 'PlanAffectingConvert' && !w.detail.startsWith('Seek Plan') && seekConverts.length) continue;
    out.push({ tone: 'warn', text: `${explainWarning(w)} ${w.detail ? `(${w.detail.replace(/^Seek Plan: |^Cardinality Estimate: /, '')})` : ''}`.trim() });
  }

  for (const mi of s.missingIndexes) {
    out.push({
      tone: 'info',
      text: `SQL Server suggests an index on ${mi.table}, and estimates it could cut this query’s cost by about ${Math.round(mi.impact)}%. Treat it as a hint: the suggestion doesn’t consider your other indexes or other queries.`,
      sql: createIndexSql(mi),
    });
  }

  if (s.degreeOfParallelism > 1) out.push({ tone: 'info', text: `The query ran in parallel on ${s.degreeOfParallelism} threads.` });

  if (!s.isActual) {
    out.push({ tone: 'info', text: 'This is an estimated plan: the row counts are SQL Server’s guesses, not what happened. An actual plan also shows the real rows.' });
  }

  if (out.length <= 1 && top && category(top) === 'seek') {
    out.push({ tone: 'good', text: 'Nothing stands out: the plan finds its rows with a seek and reads little else.', node: top });
  }
  return out;
}
