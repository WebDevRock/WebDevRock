// Generates a SQL Server nodes()/value() query from a sample XML document, with column types inferred from
// the values in the sample. Repeated child elements can be shredded into their own rows with CROSS APPLY.
import { DATE_RE, DATETIME_RE, GUID_RE, OFFSET_RE } from './json-to-openjson';
import { parseXml } from './xml-json';
import { nvarcharFor, quoteName, sqlString } from './sql-format';

export type XmlNodesOptions = {
  path: string; // rows, e.g. /orders/order; '' to detect
  child: string; // child rows relative to each row, e.g. lines/line; '' for none
  flatten: boolean;
  includeSample: boolean;
  intoTemp: boolean;
};

export type XmlNodesColumn = { name: string; expression: string; type: string; note?: string };

export type XmlNodesResult = {
  sql: string;
  path: string;
  rows: number;
  child?: { path: string; rows: number };
  suggestedChild?: string; // a repeated element under the rows, when no child path was given
  columns: XmlNodesColumn[];
};

type Stats = {
  kind: 'value' | 'query';
  names: string[];
  path: string; // relative to the row (or child) element
  values: string[];
  empty: number;
  repeated?: boolean; // an element that appears more than once in a row, read with query()
};

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';

const INT_RE = /^-?(0|[1-9]\d*)$/;
const DECIMAL_RE = /^-?(0|[1-9]\d*)\.\d+$/;
const FLOAT_RE = /^-?(0|[1-9]\d*)(\.\d+)?[eE][+-]?\d+$/;

const childElements = (el: Element) => Array.from(el.childNodes).filter((n): n is Element => n.nodeType === ELEMENT_NODE);

const directText = (el: Element) =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === TEXT_NODE || n.nodeType === CDATA_SECTION_NODE)
    .map((n) => n.nodeValue ?? '')
    .join('');

const isNamespaceDeclaration = (attr: Attr) => attr.namespaceURI === XMLNS_URI || attr.name === 'xmlns' || attr.name.startsWith('xmlns:');

// ---- Namespaces: one prefix per namespace URI, the document's own where it has one

class Namespaces {
  private prefixes = new Map<string, string>(); // uri -> prefix

  constructor(root: Element) {
    const visit = (el: Element) => {
      this.add(el.namespaceURI, el.prefix);
      for (const attr of Array.from(el.attributes)) if (!isNamespaceDeclaration(attr)) this.add(attr.namespaceURI, attr.prefix);
      childElements(el).forEach(visit);
    };
    visit(root);
  }

  private add(uri: string | null, preferred: string | null) {
    if (!uri || this.prefixes.has(uri)) return;
    const taken = new Set(this.prefixes.values());
    let prefix = preferred && !taken.has(preferred) && preferred !== 'xml' ? preferred : 'ns';
    for (let i = 2; taken.has(prefix); i++) prefix = `ns${i}`;
    this.prefixes.set(uri, prefix);
  }

  // The name to use in a path: the prefix SQL Server will know it by, and the local name
  name(node: Element | Attr): string {
    if (node.namespaceURI === 'http://www.w3.org/XML/1998/namespace') return `xml:${node.localName}`;
    const prefix = node.namespaceURI ? this.prefixes.get(node.namespaceURI) : undefined;
    return prefix ? `${prefix}:${node.localName}` : node.localName;
  }

  declaration(): string | undefined {
    if (!this.prefixes.size) return undefined;
    const items = [...this.prefixes].map(([uri, prefix]) => `  '${uri.replace(/'/g, "''")}' AS ${prefix}`);
    return `WITH XMLNAMESPACES (\n${items.join(',\n')}\n)`;
  }
}

// ---- Finding the rows

// '/orders/order' or 'lines/line'. Steps match by local name, so any prefix (or none) can be used.
function parseSteps(path: string, absolute: boolean): string[] {
  const p = path.trim().replace(/\/+$/, '');
  if (/\/\/|[[\]@*()]/.test(p)) throw new Error(`Unsupported path: ${p}. Use element names only, e.g. ${absolute ? '/orders/order' : 'lines/line'}`);
  if (absolute && !p.startsWith('/')) throw new Error(`The rows path must start at the root, e.g. /${p}`);
  if (!absolute && p.startsWith('/')) throw new Error('The child rows path is relative to each row: leave out the leading /, e.g. lines/line');
  return p.split('/').filter(Boolean).map((step) => step.slice(step.indexOf(':') + 1));
}

function follow(from: Element[], steps: string[]): Element[] {
  return steps.reduce((current, step) => current.flatMap((el) => childElements(el).filter((c) => c.localName === step)), from);
}

// The shallowest element that repeats under one parent, e.g. <order> in <orders><order/><order/></orders>
function detectRows(root: Element): Element[] {
  const queue: Element[][] = [[root]];
  while (queue.length) {
    const chain = queue.shift()!;
    const parent = chain[chain.length - 1];
    const groups = new Map<string, Element[]>();
    for (const child of childElements(parent)) {
      const key = `${child.namespaceURI} ${child.localName}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(child);
    }
    for (const group of groups.values()) if (group.length > 1) return group;
    for (const group of groups.values()) queue.push([...chain, group[0]]);
  }
  return [root];
}

function pathTo(el: Element, ns: Namespaces): string {
  const steps: string[] = [];
  for (let current: Element | null = el; current; current = current.parentElement) steps.unshift(ns.name(current));
  return '/' + steps.join('/');
}

function relativePath(from: Element, to: Element, ns: Namespaces): string {
  const steps: string[] = [];
  for (let current: Element | null = to; current && current !== from; current = current.parentElement) steps.unshift(ns.name(current));
  return steps.join('/');
}

// ---- Columns

// Element paths, relative to the row, that appear more than once under the same parent in any row
function repeatedPaths(rows: Element[], ns: Namespaces): string[] {
  const repeats = new Set<string>();
  const visit = (el: Element, rel: string) => {
    const counts = new Map<string, Element[]>();
    for (const child of childElements(el)) {
      const name = ns.name(child);
      if (!counts.has(name)) counts.set(name, []);
      counts.get(name)!.push(child);
    }
    for (const [name, group] of counts) {
      const path = rel ? `${rel}/${name}` : name;
      if (group.length > 1) repeats.add(path);
      group.forEach((child) => visit(child, path));
    }
  };
  rows.forEach((row) => visit(row, ''));
  return [...repeats];
}

function collectColumns(rows: Element[], ns: Namespaces, flatten: boolean, baseNames: string[], skip: (path: string) => boolean): Stats[] {
  const repeats = new Set(repeatedPaths(rows, ns));
  const columns = new Map<string, Stats>();

  const column = (kind: Stats['kind'], names: string[], path: string): Stats => {
    const key = `${kind} ${path}`;
    if (!columns.has(key)) columns.set(key, { kind, names, path, values: [], empty: 0 });
    return columns.get(key)!;
  };
  const record = (stats: Stats, value: string) => (value.trim() === '' ? stats.empty++ : stats.values.push(value));
  const textPath = (rel: string) => (rel ? `(${rel}/text())[1]` : '(text())[1]');

  const visit = (el: Element, rel: string, names: string[]) => {
    for (const attr of Array.from(el.attributes)) {
      if (isNamespaceDeclaration(attr)) continue;
      const name = ns.name(attr);
      record(column('value', [...names, attr.localName], rel ? `(${rel}/@${name})[1]` : `@${name}`), attr.value);
    }

    const seen = new Set<string>();
    for (const child of childElements(el)) {
      const name = ns.name(child);
      const path = rel ? `${rel}/${name}` : name;
      if (skip(path)) continue;
      const childNames = [...names, child.localName];

      if (repeats.has(path)) {
        // Every match together, as one XML value per row
        if (!seen.has(path)) column('query', childNames, path).repeated = true;
        seen.add(path);
        continue;
      }

      const structured = child.attributes.length > 0 || childElements(child).length > 0;
      if (structured && !flatten) {
        column('query', childNames, path);
      } else if (structured) {
        visit(child, path, childNames);
        const text = directText(child).trim();
        if (text) record(column('value', childNames, textPath(path)), text);
      } else {
        record(column('value', childNames, textPath(path)), directText(child));
      }
    }
  };

  for (const row of rows) {
    visit(row, '', baseNames);
    // Rows that are just values, such as <id>1</id><id>2</id>
    if (childElements(row).length === 0) {
      const text = directText(row);
      if (text.trim() || row.attributes.length === 0) record(column('value', baseNames.length ? baseNames : ['value'], textPath('')), text);
    }
  }

  // Elements that are plain text in some rows and structured in others: a query() column already returns
  // them whole, and an always-empty text column adds nothing next to the columns read from inside them
  const all = [...columns.values()];
  const queried = new Set(all.filter((c) => c.kind === 'query').map((c) => c.path));
  return all.filter((c) => {
    if (c.kind !== 'value') return true;
    const inner = c.path.match(/^\((.+)\/text\(\)\)\[1\]$/)?.[1];
    if (inner === undefined) return true;
    if (queried.has(inner)) return false;
    return c.values.length > 0 || !all.some((other) => other !== c && other.path.startsWith(`(${inner}/`));
  });
}

function decide(stats: Stats): { type: string; note?: string } {
  const values = stats.values.map((v) => v.trim());
  if (values.length === 0) return { type: 'NVARCHAR(100)', note: 'always empty in sample' };

  const all = (re: RegExp) => values.every((v) => re.test(v));
  const maxLength = Math.max(...stats.values.map((v) => v.length));

  if (values.every((v) => v === 'true' || v === 'false')) return { type: 'BIT' };
  if (all(INT_RE)) {
    const digits = Math.max(...values.map((v) => v.replace('-', '').length));
    if (digits > 18) return { type: digits > 38 ? nvarcharFor(maxLength) : `DECIMAL(${digits}, 0)` };
    const big = values.some((v) => Math.abs(Number(v)) > 2147483647);
    return { type: big ? 'BIGINT' : 'INT' };
  }
  if (values.every((v) => INT_RE.test(v) || DECIMAL_RE.test(v))) {
    const intDigits = Math.max(...values.map((v) => v.replace('-', '').split('.')[0].length));
    const scale = Math.min(18, Math.max(...values.map((v) => (v.split('.')[1] ?? '').length)));
    const precision = Math.min(38, Math.max(18, intDigits + scale));
    return { type: `DECIMAL(${precision}, ${scale})` };
  }
  if (values.every((v) => INT_RE.test(v) || DECIMAL_RE.test(v) || FLOAT_RE.test(v))) return { type: 'FLOAT' };
  if (all(DATE_RE)) return { type: 'DATE' };
  if (all(OFFSET_RE)) return { type: 'DATETIMEOFFSET' };
  if (all(DATETIME_RE)) return { type: 'DATETIME2' };
  if (all(GUID_RE)) return { type: 'UNIQUEIDENTIFIER' };

  // Mostly numbers with the odd exception usually means a placeholder like "n/a" that would fail a numeric type
  const numeric = values.filter((v) => INT_RE.test(v) || DECIMAL_RE.test(v));
  if (numeric.length && numeric.length >= values.length / 2) {
    const example = values.find((v) => !INT_RE.test(v) && !DECIMAL_RE.test(v))!;
    return { type: nvarcharFor(maxLength), note: `mostly numbers, but also "${example.slice(0, 20)}"` };
  }
  return { type: nvarcharFor(maxLength) };
}

// ---- The query

export function buildXmlNodes(xmlText: string, options: XmlNodesOptions): XmlNodesResult {
  const text = xmlText.trim();
  if (!text) throw new Error('Paste an XML sample.');

  const doc = parseXml(text);
  const root = doc.documentElement;
  const ns = new Namespaces(root);

  let rows: Element[];
  if (options.path.trim()) {
    const steps = parseSteps(options.path, true);
    if (steps[0] !== root.localName) throw new Error(`The document's root element is <${root.nodeName}>, so the path must start /${root.localName}.`);
    rows = follow([root], steps.slice(1));
    if (!rows.length) throw new Error(`Nothing found at ${options.path.trim()}. Element names are case-sensitive.`);
  } else {
    rows = detectRows(root);
  }
  const path = pathTo(rows[0], ns);

  let children: Element[] = [];
  let childPath = '';
  if (options.child.trim()) {
    const steps = parseSteps(options.child, false);
    children = follow(rows, steps);
    if (!children.length) throw new Error(`No ${options.child.trim()} elements found under ${path}.`);
    childPath = relativePath(rows.find((r) => r.contains(children[0]))!, children[0], ns);
  }

  // The row's columns leave out whatever the child rows cover
  const rowStats = collectColumns(rows, ns, options.flatten, [], (p) => childPath !== '' && (childPath === p || childPath.startsWith(`${p}/`)));
  const childStats = children.length ? collectColumns(children, ns, options.flatten, [children[0].localName], () => false) : [];

  const suggestedChild = childPath ? undefined : repeatedPaths(rows, ns).sort((a, b) => a.split('/').length - b.split('/').length)[0];

  // Column names: letters, digits and _, unique across both levels
  const used = new Set<string>();
  const columns: XmlNodesColumn[] = [];
  const addColumns = (list: Stats[], alias: string) => {
    for (const stats of list) {
      const base = stats.names.join('_').replace(/[^\p{L}\p{N}_]+/gu, '_') || 'value';
      let name = base;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
      used.add(name.toLowerCase());

      const literal = `'${stats.path.replace(/'/g, "''")}'`;
      if (stats.kind === 'query') {
        columns.push({ name, expression: `${alias}.n.query(${literal})`, type: 'XML', note: stats.repeated ? 'repeats: shred with CROSS APPLY' : undefined });
      } else {
        const { type, note } = decide(stats);
        columns.push({ name, expression: `${alias}.n.value(${literal}, '${type}')`, type, note });
      }
    }
  };
  addColumns(rowStats, 'r');
  addColumns(childStats, 'c');
  if (!columns.length) throw new Error(`The elements at ${path} have no attributes, child elements or text to read.`);

  const width = Math.max(...columns.map((c) => c.expression.length));
  const selectLines = columns.map((c, i) => {
    const comma = i < columns.length - 1 ? ',' : '';
    const note = c.note ? `  -- ${c.note}` : '';
    return `  ${c.expression.padEnd(width)} AS ${quoteName(c.name)}${comma}${note}`;
  });

  // An encoding declaration in an N'' string fails the cast to XML ("unable to switch the encoding")
  const sample = text.replace(/^<\?xml[\s\S]*?\?>\s*/, '');
  const declare = options.includeSample
    ? `DECLARE @xml XML = ${sqlString(sample)};`
    : "DECLARE @xml XML = N'';  -- set to your XML, or load a file with OPENROWSET(BULK ..., SINGLE_BLOB)";

  const namespaces = ns.declaration();
  const childApply = childPath
    ? [
        `-- OUTER APPLY instead keeps ${rows[0].localName} elements that have no ${children[0].localName}`,
        `CROSS APPLY r.n.nodes('${childPath.replace(/'/g, "''")}') AS c(n)`,
      ]
    : [];

  const sql = [
    declare,
    '',
    ...(namespaces ? [namespaces] : []),
    'SELECT',
    ...selectLines,
    ...(options.intoTemp ? ['INTO #xml_rows'] : []),
    `FROM @xml.nodes('${path.replace(/'/g, "''")}') AS r(n)`,
    ...childApply,
  ].join('\n') + ';';

  return {
    sql,
    path,
    rows: rows.length,
    child: childPath ? { path: childPath, rows: children.length } : undefined,
    suggestedChild,
    columns,
  };
}
