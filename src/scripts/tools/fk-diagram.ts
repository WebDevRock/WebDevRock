// Foreign key diagram: reads pasted SQL Server query results (foreign keys, optionally with every column),
// lays the tables out with parents to the left of the tables that reference them, and exports Mermaid.
// Everything here is plain data and maths, so it can be tested outside the page; the component draws it.

export interface Column {
  name: string;
  type: string | null;
  nullable: boolean | null;
  pk: boolean;
  fk: boolean;
  referenced: boolean;
}

export interface Table {
  id: string;
  schema: string;
  name: string;
  columns: Column[];
  // True when the paste listed this table's own columns, not just the ones its keys use
  full: boolean;
}

export interface ForeignKey {
  id: string;
  name: string | null;
  child: string;
  parent: string;
  pairs: { child: string; parent: string }[];
  onDelete: string | null;
  disabled: boolean;
  untrusted: boolean;
}

export interface Model {
  tables: Map<string, Table>;
  fks: ForeignKey[];
  full: boolean;
  schemas: number;
  rows: number;
  skipped: number;
}

type FieldName =
  | 'schema' | 'table' | 'column' | 'type' | 'nullable' | 'pk'
  | 'refSchema' | 'refTable' | 'refColumn' | 'fkName' | 'onDelete' | 'disabled' | 'untrusted';

// Header names, lower case with anything but letters and digits removed. "Parent" means the referenced
// table, as in the queries on the tool page; sp_fkeys' PKTABLE_/FKTABLE_ names work too.
const ALIASES: Record<string, FieldName> = {
  childschema: 'schema', tableschema: 'schema', schema: 'schema', schemaname: 'schema', fkschema: 'schema',
  fktableowner: 'schema', fktableschema: 'schema', referencingschema: 'schema',
  childtable: 'table', tablename: 'table', table: 'table', fktable: 'table', fktablename: 'table', referencingtable: 'table',
  childcolumn: 'column', columnname: 'column', column: 'column', fkcolumn: 'column', fkcolumnname: 'column', referencingcolumn: 'column',
  datatype: 'type', type: 'type', typename: 'type', columntype: 'type',
  isnullable: 'nullable', nullable: 'nullable', allownulls: 'nullable',
  isprimarykey: 'pk', primarykey: 'pk', pk: 'pk', ispk: 'pk',
  parentschema: 'refSchema', referencedschema: 'refSchema', refschema: 'refSchema', pkschema: 'refSchema',
  pktableowner: 'refSchema', pktableschema: 'refSchema',
  parenttable: 'refTable', referencedtable: 'refTable', reftable: 'refTable', pktable: 'refTable', pktablename: 'refTable',
  parentcolumn: 'refColumn', referencedcolumn: 'refColumn', refcolumn: 'refColumn', pkcolumn: 'refColumn', pkcolumnname: 'refColumn',
  foreignkeyname: 'fkName', foreignkey: 'fkName', fkname: 'fkName', constraintname: 'fkName', constraint: 'fkName',
  ondelete: 'onDelete', deleteaction: 'onDelete', deletereferentialactiondesc: 'onDelete', deleterule: 'onDelete',
  isdisabled: 'disabled', disabled: 'disabled',
  isnottrusted: 'untrusted', nottrusted: 'untrusted', untrusted: 'untrusted',
};

// Column orders of the queries on the tool page, for results copied without headers
const POSITIONAL: Record<number, FieldName[]> = {
  4: ['table', 'column', 'refTable', 'refColumn'],
  7: ['schema', 'table', 'column', 'refSchema', 'refTable', 'refColumn', 'fkName'],
  10: ['schema', 'table', 'column', 'type', 'nullable', 'pk', 'refSchema', 'refTable', 'refColumn', 'fkName'],
  13: ['schema', 'table', 'column', 'type', 'nullable', 'pk', 'refSchema', 'refTable', 'refColumn', 'fkName', 'onDelete', 'disabled', 'untrusted'],
};

// ---- Splitting the paste into rows and cells

// SSMS messages that end up in a copy of "Results to Text"
const NOISE = [/^\(\d[\d,]* rows? affected\)$/i, /^completion time:/i, /^total execution time/i, /^msg \d+, level/i];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

export function splitRows(text: string): string[][] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '' && !NOISE.some((re) => re.test(line.trim())));
  if (!lines.length) return [];

  // Results to Text: a header line, then dashes under each column marking its width
  if (lines.length > 1 && /^[\s-]+$/.test(lines[1]) && lines[1].includes('-') && !lines[0].includes('\t')) {
    const starts = [...lines[1].matchAll(/-+/g)].map((m) => m.index!);
    const cut = (line: string) => starts.map((start, i) => line.slice(start, starts[i + 1]).trim());
    return [cut(lines[0]), ...lines.slice(2).map(cut)];
  }
  if (lines[0].includes('\t')) return lines.map((line) => line.split('\t'));
  if (lines[0].includes(',')) return parseCsv(lines.join('\n'));
  if (lines[0].includes('|')) {
    // A Markdown or psql-style table: drop the |---| rule lines
    return lines
      .filter((line) => !/^[\s|:+-]+$/.test(line))
      .map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|'));
  }
  return lines.map((line) => line.trim().split(/\s+/));
}

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  let v = value.trim();
  if (/^".*"$/.test(v) || /^\[.*\]$/.test(v)) v = v.slice(1, -1).trim();
  return v === '' || v.toUpperCase() === 'NULL' ? null : v;
}

function flag(value: string | null): boolean | null {
  if (value === null) return null;
  const v = value.toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'n'].includes(v)) return false;
  return null;
}

// ---- Building the model

export const tableKey = (schema: string, name: string) => (schema ? `${schema}.${name}` : name).toLowerCase();

export function parseResults(text: string): Model {
  const rows = splitRows(text);
  if (!rows.length) throw new Error('Paste the results of one of the queries above, including the header row.');

  // Header row, or the column order of one of the queries
  const first = rows[0].map(normalise);
  const known = first.filter((h) => ALIASES[h]).length;
  let index: Partial<Record<FieldName, number>> = {};
  let body = rows;
  if (known >= 2) {
    first.forEach((h, i) => {
      const name = ALIASES[h];
      if (name && index[name] === undefined) index[name] = i;
    });
    body = rows.slice(1);
  } else {
    const order = POSITIONAL[rows[0].length];
    if (!order) {
      throw new Error(
        `The first row has ${rows[0].length} values and no column names this tool recognises. Copy the results with their headers (in SSMS: right-click the grid, then Copy with Headers).`,
      );
    }
    order.forEach((name, i) => (index[name] = i));
  }
  if (index.table === undefined) throw new Error('No table column found. Expected a header such as ChildTable or TableName.');
  if (index.refTable === undefined && index.column === undefined) {
    throw new Error('No referenced table or column found. Expected headers such as ParentTable or ColumnName.');
  }

  const tables = new Map<string, Table>();
  const fks = new Map<string, ForeignKey>();
  const full = index.type !== undefined || index.pk !== undefined || (index.refTable === undefined && index.column !== undefined);
  let skipped = 0;

  const ensureTable = (schema: string, name: string): Table => {
    const id = tableKey(schema, name);
    let t = tables.get(id);
    if (!t) tables.set(id, (t = { id, schema, name, columns: [], full: false }));
    return t;
  };
  const ensureColumn = (t: Table, name: string): Column => {
    let c = t.columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) t.columns.push((c = { name, type: null, nullable: null, pk: false, fk: false, referenced: false }));
    return c;
  };

  for (const row of body) {
    const get = (name: FieldName) => (index[name] === undefined ? null : clean(row[index[name]!]));
    const tableName = get('table');
    if (!tableName || (rows[0].length > 1 && row.length < 2)) {
      skipped++;
      continue;
    }
    const schema = get('schema') ?? '';
    const t = ensureTable(schema, tableName);
    if (full) t.full = true;

    const columnName = get('column');
    const c = columnName ? ensureColumn(t, columnName) : null;
    if (c) {
      c.type = get('type') ?? c.type;
      c.nullable = flag(get('nullable')) ?? c.nullable;
      c.pk ||= flag(get('pk')) === true;
    }

    const refTable = get('refTable');
    if (!refTable) continue;
    const refSchema = get('refSchema') ?? (index.refSchema === undefined ? schema : '');
    const p = ensureTable(refSchema, refTable);
    const refColumn = get('refColumn');
    const pc = refColumn ? ensureColumn(p, refColumn) : null;
    if (pc) pc.referenced = true;
    if (c) c.fk = true;

    const name = get('fkName');
    const id = name ? `${t.id}|${name.toLowerCase()}` : `${t.id}|${p.id}|${(columnName ?? '').toLowerCase()}`;
    let fk = fks.get(id);
    if (!fk) {
      fks.set(id, (fk = { id, name, child: t.id, parent: p.id, pairs: [], onDelete: null, disabled: false, untrusted: false }));
    }
    if (c && pc && !fk.pairs.some((x) => x.child === c.name && x.parent === pc.name)) fk.pairs.push({ child: c.name, parent: pc.name });
    fk.onDelete = get('onDelete') ?? fk.onDelete;
    fk.disabled ||= flag(get('disabled')) === true;
    fk.untrusted ||= flag(get('untrusted')) === true;
  }

  if (!tables.size) throw new Error('No rows with a table name were found under the header row.');
  return {
    tables,
    fks: [...fks.values()],
    full,
    schemas: new Set([...tables.values()].map((t) => t.schema.toLowerCase())).size,
    rows: body.length - skipped,
    skipped,
  };
}

// ---- Relationship details

const findColumn = (t: Table, name: string) => t.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());

// Optional when every column of the key allows NULL, so a child row can exist without a parent
export function isOptional(model: Model, fk: ForeignKey): boolean {
  const child = model.tables.get(fk.child)!;
  return fk.pairs.length > 0 && fk.pairs.every((p) => findColumn(child, p.child)?.nullable === true);
}

// One-to-one when the key's columns are exactly the child's primary key
export function isOneToOne(model: Model, fk: ForeignKey): boolean {
  const child = model.tables.get(fk.child)!;
  const pk = child.columns.filter((c) => c.pk).map((c) => c.name.toLowerCase());
  const cols = new Set(fk.pairs.map((p) => p.child.toLowerCase()));
  return pk.length > 0 && pk.length === cols.size && pk.every((c) => cols.has(c));
}

export const displayName = (model: Model, t: Table) => (model.schemas > 1 && t.schema ? `${t.schema}.${t.name}` : t.name);

// ---- Choosing what to show

export type ColumnMode = 'all' | 'keys' | 'none';

// Tables within `depth` relationships of the focus table, or every table
export function visibleTables(model: Model, focus: string | null, depth: number, isolated: boolean): Set<string> {
  const linked = new Set(model.fks.flatMap((fk) => (fk.child === fk.parent ? [] : [fk.child, fk.parent])));
  if (!focus || !model.tables.has(focus)) {
    return new Set([...model.tables.keys()].filter((id) => isolated || linked.has(id)));
  }
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const fk of model.fks) {
      for (const [a, b] of [[fk.child, fk.parent], [fk.parent, fk.child]]) {
        if (frontier.includes(a) && !seen.has(b)) { seen.add(b); next.push(b); }
      }
    }
    frontier = next;
  }
  return seen;
}

export const columnsFor = (t: Table, mode: ColumnMode): Column[] =>
  mode === 'none' ? [] : mode === 'keys' ? t.columns.filter((c) => c.pk || c.fk || c.referenced) : t.columns;

// ---- Layout

export const SIZES = { header: 32, row: 22, pad: 6, charMono: 7.3, charTitle: 8, badge: 34, gapX: 84, gapY: 26, gapComponent: 70 };

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: Column[];
}

export function boxSize(model: Model, t: Table, mode: ColumnMode): { w: number; h: number; rows: Column[] } {
  const rows = columnsFor(t, mode);
  const typeText = (c: Column) => (c.type ? c.type + (c.nullable ? ' null' : '') : c.nullable ? 'null' : '');
  const rowWidth = Math.max(0, ...rows.map((c) => 12 + SIZES.badge + c.name.length * SIZES.charMono + 18 + typeText(c).length * SIZES.charMono + 12));
  const titleWidth = 24 + displayName(model, t).length * SIZES.charTitle;
  const w = Math.ceil(Math.max(150, rowWidth, titleWidth));
  const h = SIZES.header + (rows.length ? rows.length * SIZES.row + SIZES.pad : 0);
  return { w, h, rows };
}

export const typeLabel = (c: Column) => (c.type ? c.type + (c.nullable ? ' null' : '') : c.nullable ? 'null' : '');

// Vertical centre of a column's row, relative to the top of its table (the header when it isn't shown)
export function rowOffset(box: Box, column: string | undefined): number {
  const i = column === undefined ? -1 : box.rows.findIndex((c) => c.name.toLowerCase() === column.toLowerCase());
  return i < 0 ? SIZES.header / 2 : SIZES.header + i * SIZES.row + SIZES.row / 2;
}

// Isotonic regression (pool adjacent violators): the tops closest to `desired` that keep the order and leave a gap
function settle(boxes: Box[], desired: number[]) {
  const offsets: number[] = [];
  let acc = 0;
  for (const b of boxes) { offsets.push(acc); acc += b.h + SIZES.gapY; }
  const blocks: { sum: number; n: number }[] = [];
  desired.forEach((d, i) => {
    blocks.push({ sum: d - offsets[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const last = blocks.pop()!;
      blocks[blocks.length - 1].sum += last.sum;
      blocks[blocks.length - 1].n += last.n;
    }
  });
  let i = 0;
  for (const block of blocks) {
    const level = block.sum / block.n;
    for (let k = 0; k < block.n; k++, i++) boxes[i].y = level + offsets[i];
  }
}

interface Link { fk: ForeignKey; parent: string; child: string }

function layoutComponent(ids: string[], links: Link[], boxes: Map<string, Box>) {
  // Break cycles: an edge back to a table still being explored doesn't count for the ranks
  const parentsOf = new Map(ids.map((id) => [id, [] as string[]]));
  const childrenOf = new Map(ids.map((id) => [id, [] as string[]]));
  const state = new Map<string, 1 | 2>();
  const acyclic: Link[] = [];
  const explore = (id: string) => {
    state.set(id, 1);
    for (const l of links) {
      if (l.child !== id || l.parent === id) continue;
      if (state.get(l.parent) === 1) continue;
      acyclic.push(l);
      if (!state.has(l.parent)) explore(l.parent);
    }
    state.set(id, 2);
  };
  ids.forEach((id) => state.has(id) || explore(id));
  for (const l of acyclic) {
    if (!parentsOf.get(l.child)!.includes(l.parent)) parentsOf.get(l.child)!.push(l.parent);
    if (!childrenOf.get(l.parent)!.includes(l.child)) childrenOf.get(l.parent)!.push(l.child);
  }

  // Ranks: longest path from the tables with no parents, then pull each parent up next to its nearest child
  const rank = new Map<string, number>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    rank.set(id, 0);
    const r = Math.max(-1, ...parentsOf.get(id)!.map(rankOf)) + 1;
    rank.set(id, r);
    return r;
  };
  ids.forEach(rankOf);
  const byRankDesc = [...ids].sort((a, b) => rank.get(b)! - rank.get(a)!);
  for (const id of byRankDesc) {
    const kids = childrenOf.get(id)!;
    if (kids.length) rank.set(id, Math.min(...kids.map((k) => rank.get(k)!)) - 1);
  }
  const low = Math.min(...ids.map((id) => rank.get(id)!));
  ids.forEach((id) => rank.set(id, rank.get(id)! - low));
  const ranks: string[][] = [];
  // First order: depth-first from the roots, so related tables start out together
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    (ranks[rank.get(id)!] ??= []).push(id);
    for (const k of childrenOf.get(id)!) walk(k);
    for (const p of parentsOf.get(id)!) walk(p);
  };
  ids.filter((id) => !parentsOf.get(id)!.length).forEach(walk);
  ids.forEach(walk);
  for (let r = 0; r < ranks.length; r++) ranks[r] ??= [];

  const neighbours = new Map(ids.map((id) => [id, [] as string[]]));
  for (const l of links) {
    if (l.parent === l.child) continue;
    neighbours.get(l.parent)!.push(l.child);
    neighbours.get(l.child)!.push(l.parent);
  }

  // Reduce crossings: order each rank by the average position of its neighbours in the rank before or after
  const position = new Map<string, number>();
  const index = () => ranks.forEach((list) => list.forEach((id, i) => position.set(id, i)));
  index();
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? ranks.map((_, i) => i).slice(1) : ranks.map((_, i) => i).reverse().slice(1);
    for (const r of order) {
      const near = down ? r - 1 : r + 1;
      const score = (id: string) => {
        const ns = neighbours.get(id)!.filter((n) => rank.get(n) === near);
        return ns.length ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : position.get(id)!;
      };
      const scores = new Map(ranks[r].map((id) => [id, score(id)]));
      ranks[r].sort((a, b) => scores.get(a)! - scores.get(b)!);
      ranks[r].forEach((id, i) => position.set(id, i));
    }
  }

  // x: one column per rank, as wide as its widest table
  let x = 0;
  for (const list of ranks) {
    const width = Math.max(0, ...list.map((id) => boxes.get(id)!.w));
    for (const id of list) boxes.get(id)!.x = x;
    x += width + SIZES.gapX;
  }

  // y: line each table up with the rows it connects to, without overlapping
  const fkBetween = links.filter((l) => l.parent !== l.child);
  const desiredTop = (id: string, ranksDone: (r: number) => boolean) => {
    const box = boxes.get(id)!;
    const targets: number[] = [];
    for (const l of fkBetween) {
      const other = l.parent === id ? l.child : l.child === id ? l.parent : null;
      if (!other || !ranksDone(rank.get(other)!)) continue;
      const otherBox = boxes.get(other)!;
      const mine = rowOffset(box, l.parent === id ? l.fk.pairs[0]?.parent : l.fk.pairs[0]?.child);
      const theirs = rowOffset(otherBox, l.parent === id ? l.fk.pairs[0]?.child : l.fk.pairs[0]?.parent);
      targets.push(otherBox.y + theirs - mine);
    }
    return targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : box.y;
  };
  ranks.forEach((list) => {
    let y = 0;
    for (const id of list) { boxes.get(id)!.y = y; y += boxes.get(id)!.h + SIZES.gapY; }
  });
  const passes: ['down' | 'up', number[]][] = [
    ['down', ranks.map((_, i) => i).slice(1)],
    ['up', ranks.map((_, i) => i).reverse().slice(1)],
    ['down', ranks.map((_, i) => i).slice(1)],
  ];
  for (const [dir, order] of passes) {
    for (const r of order) {
      const list = ranks[r].map((id) => boxes.get(id)!);
      const done = (other: number) => (dir === 'down' ? other < r : other > r);
      settle(list, ranks[r].map((id) => desiredTop(id, done)));
    }
  }
  if (ranks.length > 1) {
    // Rank 0 was only placed in the upward pass's last step; give it a final settle against rank 1
    settle(ranks[0].map((id) => boxes.get(id)!), ranks[0].map((id) => desiredTop(id, (o) => o > 0)));
  }

  // Move the component so its top-left is at 0, 0
  const top = Math.min(...ids.map((id) => boxes.get(id)!.y));
  ids.forEach((id) => (boxes.get(id)!.y -= top));
}

export interface Layout {
  boxes: Map<string, Box>;
  width: number;
  height: number;
}

export function layout(model: Model, visible: Set<string>, mode: ColumnMode): Layout {
  const boxes = new Map<string, Box>();
  for (const id of visible) {
    const t = model.tables.get(id)!;
    boxes.set(id, { id, x: 0, y: 0, ...boxSize(model, t, mode) });
  }
  const links: Link[] = model.fks
    .filter((fk) => visible.has(fk.child) && visible.has(fk.parent))
    .map((fk) => ({ fk, parent: fk.parent, child: fk.child }));

  // Connected components, each laid out on its own
  const group = new Map<string, number>();
  const components: string[][] = [];
  for (const id of visible) {
    if (group.has(id)) continue;
    const members: string[] = [];
    const stack = [id];
    group.set(id, components.length);
    while (stack.length) {
      const cur = stack.pop()!;
      members.push(cur);
      for (const l of links) {
        const other = l.parent === cur ? l.child : l.child === cur ? l.parent : null;
        if (other && !group.has(other)) { group.set(other, components.length); stack.push(other); }
      }
    }
    components.push(members);
  }

  const placed = components.map((ids) => {
    const own = links.filter((l) => ids.includes(l.child));
    layoutComponent(ids, own, boxes);
    const width = Math.max(...ids.map((id) => boxes.get(id)!.x + boxes.get(id)!.w));
    const height = Math.max(...ids.map((id) => boxes.get(id)!.y + boxes.get(id)!.h));
    return { ids, width, height, single: ids.length === 1 && !own.length };
  });

  // Shelf packing: connected groups first, biggest first, then tables with no relationships
  placed.sort((a, b) => Number(a.single) - Number(b.single) || b.ids.length - a.ids.length || b.height - a.height);
  const maxWidth = Math.max(1100, ...placed.map((p) => p.width));
  let x = 0;
  let y = 0;
  let shelf = 0;
  let lastSingle = false;
  for (const p of placed) {
    const newShelf = (x > 0 && x + p.width > maxWidth) || (p.single && !lastSingle && x > 0);
    if (newShelf) { x = 0; y += shelf + SIZES.gapComponent; shelf = 0; }
    for (const id of p.ids) { boxes.get(id)!.x += x; boxes.get(id)!.y += y; }
    x += p.width + (p.single ? SIZES.gapY * 2 : SIZES.gapComponent);
    shelf = Math.max(shelf, p.height);
    lastSingle = p.single;
  }

  let width = 0;
  let height = 0;
  for (const b of boxes.values()) { width = Math.max(width, b.x + b.w); height = Math.max(height, b.y + b.h); }
  return { boxes, width, height };
}

// ---- Drawing helpers: the line for a relationship and its end markers

export interface Edge {
  d: string;
  parentEnd: { x: number; y: number; out: number };
  childEnd: { x: number; y: number; out: number };
}

export function edgeGeometry(parent: Box, child: Box, fk: ForeignKey): Edge {
  const py = parent.y + rowOffset(parent, fk.pairs[0]?.parent);
  let cy = child.y + rowOffset(child, fk.pairs[0]?.child);

  if (parent === child) {
    if (Math.abs(cy - py) < 4) cy = py + 10;
    const sx = parent.x + parent.w;
    const reach = 46;
    return {
      d: `M ${sx} ${py} C ${sx + reach} ${py}, ${sx + reach} ${cy}, ${sx} ${cy}`,
      parentEnd: { x: sx, y: py, out: 1 },
      childEnd: { x: sx, y: cy, out: 1 },
    };
  }

  let sx: number, ex: number, sOut: number, eOut: number;
  if (child.x >= parent.x + parent.w) { sx = parent.x + parent.w; ex = child.x; sOut = 1; eOut = -1; }
  else if (child.x + child.w <= parent.x) { sx = parent.x; ex = child.x + child.w; sOut = -1; eOut = 1; }
  else {
    // Same column: both ends on the right, looping out past the wider table
    sx = parent.x + parent.w; ex = child.x + child.w; sOut = 1; eOut = 1;
    const far = Math.max(sx, ex) + 40 + Math.min(80, Math.abs(cy - py) / 6);
    return {
      d: `M ${sx} ${py} C ${far} ${py}, ${far} ${cy}, ${ex} ${cy}`,
      parentEnd: { x: sx, y: py, out: 1 },
      childEnd: { x: ex, y: cy, out: 1 },
    };
  }
  const reach = Math.max(40, Math.abs(ex - sx) / 2);
  return {
    d: `M ${sx} ${py} C ${sx + sOut * reach} ${py}, ${ex + eOut * reach} ${cy}, ${ex} ${cy}`,
    parentEnd: { x: sx, y: py, out: sOut },
    childEnd: { x: ex, y: cy, out: eOut },
  };
}

// Crow's foot notation. Parent end: || exactly one, o| zero or one (nullable key). Child end: a crow's foot
// for many, or o| zero or one when the key is the child's whole primary key.
export function markerPaths(edge: Edge, optional: boolean, oneToOne: boolean): { lines: string; circles: { cx: number; cy: number }[] } {
  const p = edge.parentEnd;
  const c = edge.childEnd;
  const bar = (x: number, y: number) => `M ${x} ${y - 6} L ${x} ${y + 6}`;
  const parts = [bar(p.x + p.out * 8, p.y)];
  const circles: { cx: number; cy: number }[] = [];
  if (optional) circles.push({ cx: p.x + p.out * 17, cy: p.y });
  else parts.push(bar(p.x + p.out * 13, p.y));
  if (oneToOne) {
    parts.push(bar(c.x + c.out * 8, c.y));
    circles.push({ cx: c.x + c.out * 17, cy: c.y });
  } else {
    const tip = c.x + c.out * 13;
    parts.push(`M ${tip} ${c.y} L ${c.x} ${c.y - 6} M ${tip} ${c.y} L ${c.x} ${c.y} M ${tip} ${c.y} L ${c.x} ${c.y + 6}`);
  }
  return { lines: parts.join(' '), circles };
}

// ---- Mermaid erDiagram text

const mermaidName = (model: Model, t: Table) => {
  const raw = model.schemas > 1 && t.schema ? `${t.schema}_${t.name}` : t.name;
  return raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_');
};

export function toMermaid(model: Model, visible: Set<string>, mode: ColumnMode): string {
  const lines = ['erDiagram'];
  for (const fk of model.fks) {
    if (!visible.has(fk.child) || !visible.has(fk.parent)) continue;
    const parent = model.tables.get(fk.parent)!;
    const child = model.tables.get(fk.child)!;
    const left = isOptional(model, fk) ? '|o' : '||';
    const right = isOneToOne(model, fk) ? 'o|' : 'o{';
    const label = (fk.name ?? fk.pairs.map((p) => p.child).join(', ')) || 'references';
    lines.push(`    ${mermaidName(model, parent)} ${left}--${right} ${mermaidName(model, child)} : "${label.replace(/"/g, "'")}"`);
  }
  if (mode !== 'none') {
    for (const id of visible) {
      const t = model.tables.get(id)!;
      const cols = columnsFor(t, mode);
      if (!cols.length) continue;
      lines.push(`    ${mermaidName(model, t)} {`);
      for (const c of cols) {
        const full = (c.type ?? 'column').replace(/\s+/g, '');
        // Mermaid types allow letters, digits, -, _, () and [], so decimal(18,2) keeps its detail in a comment
        const type = /^[A-Za-z][\w\-()[\]]*$/.test(full) ? full : full.replace(/[^\w].*$/, '') || 'column';
        const keys = [c.pk && 'PK', c.fk && 'FK'].filter(Boolean).join(', ');
        const comment = type !== full ? ` "${full}"` : '';
        lines.push(`        ${type} ${c.name.replace(/[^A-Za-z0-9_-]/g, '_')}${keys ? ` ${keys}` : ''}${comment}`);
      }
      lines.push('    }');
    }
  }
  return lines.join('\n');
}

// ---- Example: a small shop database, in the shape of the "every column" query

const EXAMPLE_ROWS = [
  ['Sales', 'Customer', 'CustomerID', 'int', 0, 1],
  ['Sales', 'Customer', 'Name', 'nvarchar(200)', 0, 0],
  ['Sales', 'Customer', 'Email', 'nvarchar(320)', 1, 0],
  ['Sales', 'Customer', 'DefaultAddressID', 'int', 1, 0, 'Sales', 'Address', 'AddressID', 'FK_Customer_DefaultAddress', 'NO_ACTION', 0, 0],
  ['Sales', 'Address', 'AddressID', 'int', 0, 1],
  ['Sales', 'Address', 'CustomerID', 'int', 0, 0, 'Sales', 'Customer', 'CustomerID', 'FK_Address_Customer', 'CASCADE', 0, 0],
  ['Sales', 'Address', 'Line1', 'nvarchar(200)', 0, 0],
  ['Sales', 'Address', 'Postcode', 'nvarchar(10)', 0, 0],
  ['Sales', 'CustomerLoyalty', 'CustomerID', 'int', 0, 1, 'Sales', 'Customer', 'CustomerID', 'FK_CustomerLoyalty_Customer', 'CASCADE', 0, 0],
  ['Sales', 'CustomerLoyalty', 'Points', 'int', 0, 0],
  ['Sales', 'Order', 'OrderID', 'int', 0, 1],
  ['Sales', 'Order', 'CustomerID', 'int', 0, 0, 'Sales', 'Customer', 'CustomerID', 'FK_Order_Customer', 'NO_ACTION', 0, 0],
  ['Sales', 'Order', 'ShippingAddressID', 'int', 1, 0, 'Sales', 'Address', 'AddressID', 'FK_Order_ShippingAddress', 'NO_ACTION', 0, 1],
  ['Sales', 'Order', 'OrderedAt', 'datetime2(3)', 0, 0],
  ['Sales', 'Order', 'Total', 'decimal(18,2)', 0, 0],
  ['Sales', 'OrderLine', 'OrderID', 'int', 0, 1, 'Sales', 'Order', 'OrderID', 'FK_OrderLine_Order', 'CASCADE', 0, 0],
  ['Sales', 'OrderLine', 'LineNo', 'smallint', 0, 1],
  ['Sales', 'OrderLine', 'ProductID', 'int', 0, 0, 'Production', 'Product', 'ProductID', 'FK_OrderLine_Product', 'NO_ACTION', 0, 0],
  ['Sales', 'OrderLine', 'Quantity', 'int', 0, 0],
  ['Sales', 'OrderLine', 'UnitPrice', 'decimal(18,2)', 0, 0],
  ['Sales', 'ShipmentLine', 'ShipmentLineID', 'int', 0, 1],
  ['Sales', 'ShipmentLine', 'OrderID', 'int', 0, 0, 'Sales', 'OrderLine', 'OrderID', 'FK_ShipmentLine_OrderLine', 'NO_ACTION', 0, 0],
  ['Sales', 'ShipmentLine', 'LineNo', 'smallint', 0, 0, 'Sales', 'OrderLine', 'LineNo', 'FK_ShipmentLine_OrderLine', 'NO_ACTION', 0, 0],
  ['Sales', 'ShipmentLine', 'ShippedAt', 'datetime2(3)', 1, 0],
  ['Production', 'Category', 'CategoryID', 'int', 0, 1],
  ['Production', 'Category', 'ParentCategoryID', 'int', 1, 0, 'Production', 'Category', 'CategoryID', 'FK_Category_Parent', 'NO_ACTION', 0, 0],
  ['Production', 'Category', 'Name', 'nvarchar(100)', 0, 0],
  ['Production', 'Product', 'ProductID', 'int', 0, 1],
  ['Production', 'Product', 'CategoryID', 'int', 0, 0, 'Production', 'Category', 'CategoryID', 'FK_Product_Category', 'NO_ACTION', 1, 1],
  ['Production', 'Product', 'Name', 'nvarchar(200)', 0, 0],
  ['Production', 'Product', 'ListPrice', 'decimal(18,2)', 0, 0],
  ['dbo', 'AuditLog', 'AuditLogID', 'bigint', 0, 1],
  ['dbo', 'AuditLog', 'LoggedAt', 'datetime2(3)', 0, 0],
  ['dbo', 'AuditLog', 'Detail', 'nvarchar(max)', 1, 0],
];

export const EXAMPLE = [
  'TableSchema\tTableName\tColumnName\tDataType\tIsNullable\tIsPrimaryKey\tParentSchema\tParentTable\tParentColumn\tForeignKeyName\tOnDelete\tIsDisabled\tIsNotTrusted',
  ...EXAMPLE_ROWS.map((r) => [...r, ...Array(13 - r.length).fill('NULL')].join('\t')),
].join('\n');
