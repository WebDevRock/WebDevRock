// Parse SQL Server showplan XML (an estimated or actual execution plan) into a simple tree.
// Runs in the browser with DOMParser; nothing is sent anywhere.

export interface PlanWarning {
  kind: string;
  detail: string;
}

export interface PlanObject {
  database: string;
  schema: string;
  table: string;
  index: string;
  alias: string;
  indexKind: string;
}

export interface PlanNode {
  nodeId: number;
  physicalOp: string;
  logicalOp: string;
  /** Name as SSMS shows it, e.g. "Key Lookup" or "Hash Match (Inner Join)" */
  name: string;
  /** Operator family used for explanations and colours, e.g. "Key Lookup", "Hash Match" */
  base: string;
  object: PlanObject | null;
  /** Estimated rows per execution */
  estRows: number;
  /** Estimated number of executions (rebinds + rewinds + 1) */
  estExecutions: number;
  estRowsRead: number | null;
  tableCardinality: number | null;
  actualRows: number | null;
  actualExecutions: number | null;
  actualRowsRead: number | null;
  subtreeCost: number;
  /** This operator's own estimated cost: subtree cost minus its children's */
  cost: number;
  /** Share of the statement's total estimated cost, 0 to 1 */
  costShare: number;
  seek: string | null;
  predicate: string | null;
  outputColumns: string[];
  warnings: PlanWarning[];
  parallel: boolean;
  children: PlanNode[];
  /** True for the statement node (SELECT, INSERT...) that SSMS draws on the far left */
  isStatement: boolean;
}

export interface MissingIndex {
  impact: number;
  table: string;
  schema: string;
  equality: string[];
  inequality: string[];
  include: string[];
}

export interface PlanStatement {
  text: string;
  type: string;
  totalCost: number;
  root: PlanNode;
  nodes: PlanNode[];
  missingIndexes: MissingIndex[];
  warnings: PlanWarning[];
  degreeOfParallelism: number;
  isActual: boolean;
  memoryGrantKb: number | null;
  memoryUsedKb: number | null;
}

export class PlanParseError extends Error {}

const unbracket = (s: string | null) => (s ?? '').replace(/^\[|\]$/g, '');
const num = (el: Element, attr: string) => {
  const v = el.getAttribute(attr);
  return v === null || v === '' ? null : Number(v);
};

/** Child elements of el, skipping into wrappers but never into a nested RelOp */
function ownDescendants(el: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => {
    for (const c of Array.from(e.children)) {
      if (c.localName === 'RelOp') continue;
      if (c.localName === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** The RelOp elements directly below this one, in plan order */
function childRelOps(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => {
    for (const c of Array.from(e.children)) {
      if (c.localName === 'RelOp') out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

const directChild = (el: Element, name: string) => Array.from(el.children).find((c) => c.localName === name) ?? null;

/** Turn "[Shop].[dbo].[Orders].[CustomerId] as [o].[CustomerId]" into "o.CustomerId", and similar */
export function tidyExpression(s: string): string {
  return s
    .replace(/\[[^\]]+\]\.\[[^\]]+\]\.\[[^\]]+\]\.\[([^\]]+)\] as \[([^\]]+)\]\.\[([^\]]+)\]/g, '$2.$3')
    .replace(/\[[^\]]+\]\.\[[^\]]+\]\.\[([^\]]+)\]\.\[([^\]]+)\]/g, '$1.$2')
    .replace(/\[([^\]]+)\]/g, '$1');
}

const SCAN_TYPE: Record<string, string> = { EQ: '=', GT: '>', GE: '>=', LT: '<', LE: '<=', IS: 'IS', ISNOT: 'IS NOT', IS_NOT: 'IS NOT' };

function seekText(el: Element): string | null {
  const parts: string[] = [];
  for (const keys of ownDescendants(el, 'SeekKeys')) {
    for (const range of Array.from(keys.children)) {
      const op = SCAN_TYPE[range.getAttribute('ScanType') ?? ''] ?? range.getAttribute('ScanType') ?? '=';
      const cols = ownDescendants(range, 'RangeColumns').flatMap((rc) => ownDescendants(rc, 'ColumnReference').map((c) => c.getAttribute('Column') ?? '?'));
      const vals = ownDescendants(range, 'RangeExpressions').flatMap((re) =>
        Array.from(re.children)
          .filter((c) => c.localName === 'ScalarOperator')
          .map((c) => tidyExpression(c.getAttribute('ScalarString') ?? '?'))
      );
      cols.forEach((col, i) => parts.push(`${col} ${op} ${vals[i] ?? '?'}`));
    }
  }
  return parts.length ? parts.join(' AND ') : null;
}

function predicateText(el: Element): string | null {
  const pred = ownDescendants(el, 'Predicate')[0];
  const scalar = pred ? Array.from(pred.children).find((c) => c.localName === 'ScalarOperator') : null;
  const s = scalar?.getAttribute('ScalarString');
  return s ? tidyExpression(s) : null;
}

function warningsOf(warningsEl: Element | null): PlanWarning[] {
  if (!warningsEl) return [];
  const out: PlanWarning[] = [];
  for (const attr of ['NoJoinPredicate', 'SpatialGuess', 'UnmatchedIndexes', 'FullUpdateForOnlineIndexBuild']) {
    const v = warningsEl.getAttribute(attr);
    if (v === '1' || v === 'true') out.push({ kind: attr, detail: '' });
  }
  for (const w of Array.from(warningsEl.children)) {
    switch (w.localName) {
      case 'SpillToTempDb':
        out.push({ kind: 'SpillToTempDb', detail: `spill level ${w.getAttribute('SpillLevel') ?? '?'}` });
        break;
      case 'HashSpillDetails':
      case 'SortSpillDetails':
        // Extra detail for a SpillToTempDb warning on the same operator
        break;
      case 'PlanAffectingConvert':
        out.push({ kind: 'PlanAffectingConvert', detail: `${w.getAttribute('ConvertIssue') ?? ''}: ${tidyExpression(w.getAttribute('Expression') ?? '')}` });
        break;
      case 'ColumnsWithNoStatistics':
        out.push({ kind: 'ColumnsWithNoStatistics', detail: ownDescendants(w, 'ColumnReference').map((c) => c.getAttribute('Column')).join(', ') });
        break;
      case 'MemoryGrantWarning':
        out.push({ kind: 'MemoryGrantWarning', detail: w.getAttribute('GrantWarningKind') ?? '' });
        break;
      default:
        out.push({ kind: w.localName, detail: '' });
    }
  }
  return out;
}

function displayName(physicalOp: string, logicalOp: string, lookup: boolean): { name: string; base: string } {
  if (lookup && /Clustered Index Seek/.test(physicalOp)) return { name: 'Key Lookup', base: 'Key Lookup' };
  if (physicalOp === 'Hash Match' || physicalOp === 'Nested Loops' || physicalOp === 'Merge Join' || physicalOp === 'Adaptive Join' || physicalOp === 'Parallelism')
    return { name: `${physicalOp} (${logicalOp})`, base: physicalOp };
  return { name: physicalOp, base: physicalOp };
}

function parseRelOp(el: Element, nodes: PlanNode[]): PlanNode {
  const physicalOp = el.getAttribute('PhysicalOp') ?? 'Unknown';
  const logicalOp = el.getAttribute('LogicalOp') ?? physicalOp;
  const indexScan = ownDescendants(el, 'IndexScan')[0];
  const lookup = indexScan ? ['1', 'true'].includes(indexScan.getAttribute('Lookup') ?? '') : false;
  const { name, base } = displayName(physicalOp, logicalOp, lookup);

  const objEl = ownDescendants(el, 'Object')[0];
  const object: PlanObject | null = objEl
    ? {
        database: unbracket(objEl.getAttribute('Database')),
        schema: unbracket(objEl.getAttribute('Schema')),
        table: unbracket(objEl.getAttribute('Table')),
        index: unbracket(objEl.getAttribute('Index')),
        alias: unbracket(objEl.getAttribute('Alias')),
        indexKind: objEl.getAttribute('IndexKind') ?? '',
      }
    : null;

  // Actual plans record run-time counters per thread; add them up
  const counters = ownDescendants(el, 'RunTimeCountersPerThread');
  const sum = (attr: string) => (counters.some((c) => c.hasAttribute(attr)) ? counters.reduce((n, c) => n + (num(c, attr) ?? 0), 0) : null);

  const outputList = directChild(el, 'OutputList');
  const node: PlanNode = {
    nodeId: num(el, 'NodeId') ?? -1,
    physicalOp,
    logicalOp,
    name,
    base,
    object,
    estRows: num(el, 'EstimateRows') ?? 0,
    estExecutions: (num(el, 'EstimateRebinds') ?? 0) + (num(el, 'EstimateRewinds') ?? 0) + 1,
    estRowsRead: num(el, 'EstimatedRowsRead'),
    tableCardinality: num(el, 'TableCardinality'),
    actualRows: counters.length ? sum('ActualRows') : null,
    actualExecutions: counters.length ? sum('ActualExecutions') : null,
    actualRowsRead: counters.length ? sum('ActualRowsRead') : null,
    subtreeCost: num(el, 'EstimatedTotalSubtreeCost') ?? 0,
    cost: 0,
    costShare: 0,
    seek: seekText(el),
    predicate: predicateText(el),
    outputColumns: outputList ? ownDescendants(outputList, 'ColumnReference').map((c) => c.getAttribute('Column') ?? '') : [],
    warnings: warningsOf(directChild(el, 'Warnings')),
    parallel: ['1', 'true'].includes(el.getAttribute('Parallel') ?? ''),
    children: [],
    isStatement: false,
  };
  nodes.push(node);
  node.children = childRelOps(el).map((c) => parseRelOp(c, nodes));
  const childCost = node.children.reduce((n, c) => n + c.subtreeCost, 0);
  node.cost = Math.max(0, node.subtreeCost - childCost);
  return node;
}

function parseMissingIndexes(queryPlan: Element): MissingIndex[] {
  const out: MissingIndex[] = [];
  for (const group of ownDescendants(queryPlan, 'MissingIndexGroup')) {
    const impact = num(group, 'Impact') ?? 0;
    for (const mi of ownDescendants(group, 'MissingIndex')) {
      const cols = (usage: string) =>
        ownDescendants(mi, 'ColumnGroup')
          .filter((g) => g.getAttribute('Usage') === usage)
          .flatMap((g) => ownDescendants(g, 'Column').map((c) => unbracket(c.getAttribute('Name'))));
      out.push({
        impact,
        table: unbracket(mi.getAttribute('Table')),
        schema: unbracket(mi.getAttribute('Schema')),
        equality: cols('EQUALITY'),
        inequality: cols('INEQUALITY'),
        include: cols('INCLUDE'),
      });
    }
  }
  return out;
}

export function parsePlan(xml: string): PlanStatement[] {
  // .sqlplan files often declare utf-16; the text is already decoded, so drop the declaration
  const cleaned = xml.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>/, '').trim();
  if (!cleaned.startsWith('<')) throw new PlanParseError('That doesn’t look like XML. Paste the plan’s XML, which starts with <ShowPlanXML.');
  const doc = new DOMParser().parseFromString(cleaned, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new PlanParseError('The XML couldn’t be read. Check that the whole plan was copied.');
  if (doc.documentElement.localName !== 'ShowPlanXML') throw new PlanParseError('This XML isn’t a SQL Server execution plan. A plan starts with <ShowPlanXML.');

  const statements: PlanStatement[] = [];
  for (const stmt of Array.from(doc.getElementsByTagNameNS('*', 'StmtSimple'))) {
    const queryPlan = directChild(stmt, 'QueryPlan');
    const rootRel = queryPlan ? directChild(queryPlan, 'RelOp') : null;
    if (!queryPlan || !rootRel) continue;

    const nodes: PlanNode[] = [];
    const root = parseRelOp(rootRel, nodes);
    const totalCost = num(stmt, 'StatementSubTreeCost') ?? root.subtreeCost;
    for (const n of nodes) n.costShare = totalCost > 0 ? n.cost / totalCost : 0;

    const type = stmt.getAttribute('StatementType') ?? 'SELECT';
    const statementNode: PlanNode = {
      ...root,
      nodeId: -1,
      physicalOp: type,
      logicalOp: type,
      name: type,
      base: 'Statement',
      object: null,
      estRows: num(stmt, 'StatementEstRows') ?? root.estRows,
      estExecutions: 1,
      estRowsRead: null,
      tableCardinality: null,
      actualRows: null,
      actualExecutions: null,
      actualRowsRead: null,
      subtreeCost: totalCost,
      cost: 0,
      costShare: 0,
      seek: null,
      predicate: null,
      outputColumns: [],
      warnings: [],
      parallel: false,
      children: [root],
      isStatement: true,
    };

    const grant = directChild(queryPlan, 'MemoryGrantInfo');
    statements.push({
      text: (stmt.getAttribute('StatementText') ?? '').trim(),
      type,
      totalCost,
      root: statementNode,
      nodes,
      missingIndexes: parseMissingIndexes(queryPlan),
      warnings: warningsOf(directChild(queryPlan, 'Warnings')),
      degreeOfParallelism: num(queryPlan, 'DegreeOfParallelism') ?? 1,
      isActual: nodes.some((n) => n.actualRows !== null),
      memoryGrantKb: grant ? num(grant, 'GrantedMemory') : null,
      memoryUsedKb: grant ? num(grant, 'MaxUsedMemory') : null,
    });
  }
  if (!statements.length) throw new PlanParseError('No query plans were found in this XML. Statements such as SET or DECLARE don’t have one.');
  return statements;
}

/** Rows that flowed out of an operator: actual if known, otherwise the estimate for all executions */
export function rowsOut(n: PlanNode): number {
  if (n.actualRows !== null) return n.actualRows;
  return n.estRows * n.estExecutions;
}
