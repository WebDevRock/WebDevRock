// Converts XML to JSON and back, using the same conventions both ways so a round trip keeps the shape:
//
//   <order id="7"><line>A</line><line>B</line></order>   <->   { "order": { "@id": "7", "line": ["A", "B"] } }
//
// Attributes get a prefix (@ by default), text next to attributes or child elements goes in "#text", and an
// element that repeats becomes an array. XML is parsed with the browser's DOMParser.

export type XmlJsonDirection = 'auto' | 'xml-to-json' | 'json-to-xml';

export type XmlJsonOptions = {
  direction: XmlJsonDirection;
  attributePrefix: string; // '' puts attributes alongside child elements
  arrays: string[]; // element names that are always arrays, even when they appear once
  types: boolean; // read numbers and true/false as JSON numbers and booleans
  root: string; // wrapper element when the JSON has no single top-level property
};

export type XmlJsonResult = {
  output: string;
  direction: 'xml-to-json' | 'json-to-xml';
  elements: number;
  warnings: string[];
};

export const TEXT_KEY = '#text';

// Element and attribute names: letters, digits, _ . - and one optional namespace prefix
const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.\-]*(?::[\p{L}_][\p{L}\p{N}_.\-]*)?$/u;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/; // no leading zeros, so codes like 00123 stay text
const INVALID_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g; // not allowed anywhere in XML 1.0

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function detectDirection(text: string): 'xml-to-json' | 'json-to-xml' {
  return text.trimStart().startsWith('<') ? 'xml-to-json' : 'json-to-xml';
}

export function convertXmlJson(input: string, options: XmlJsonOptions): XmlJsonResult {
  const text = input.trim();
  if (!text) throw new Error('Paste some XML or JSON.');

  const direction = options.direction === 'auto' ? detectDirection(text) : options.direction;
  return direction === 'xml-to-json' ? xmlToJson(text, options) : jsonToXml(text, options);
}

// ---- XML to JSON

export function parseXml(text: string): Document {
  const parser = new DOMParser();
  // Browsers report errors as a <parsererror> element in their own namespace: find out which one
  const errorNs = parser.parseFromString('<', 'application/xml').getElementsByTagName('parsererror')[0]?.namespaceURI ?? '';
  const doc = parser.parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagNameNS(errorNs, 'parsererror')[0];
  if (error) {
    const detail = (error.textContent ?? '')
      .replace(/^This page contains the following errors:/, '')
      .replace(/Below is a rendering of the page up to the first error\.?$/, '')
      .trim();
    throw new Error(`Not valid XML: ${detail || 'the document could not be read.'}`);
  }
  return doc;
}

function typed(value: string, types: boolean): unknown {
  if (!types) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (NUMBER.test(value)) {
    const n = Number(value);
    // Keep ids too long for a JavaScript number as text, rather than silently rounding them
    if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) return n;
  }
  return value;
}

function xmlToJson(text: string, options: XmlJsonOptions): XmlJsonResult {
  const doc = parseXml(text);
  const root = doc.documentElement;
  const forceArrays = new Set(options.arrays);
  let elements = 0;
  let mixed = 0;
  const clashes = new Set<string>();

  const convert = (el: Element): unknown => {
    elements++;
    const obj: Record<string, unknown> = {};
    for (const attr of Array.from(el.attributes)) obj[options.attributePrefix + attr.name] = typed(attr.value, options.types);

    const groups = new Map<string, unknown[]>();
    const texts: string[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === ELEMENT_NODE) {
        const name = child.nodeName;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(convert(child as Element));
      } else if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
        texts.push(child.nodeValue ?? '');
      }
      // Comments and processing instructions have no JSON equivalent and are left out
    }

    for (const [name, values] of groups) {
      if (name in obj) clashes.add(name);
      obj[name] = values.length > 1 || forceArrays.has(name) ? values : values[0];
    }

    const hasAttributes = el.attributes.length > 0;
    const content = texts.join('');
    if (groups.size === 0 && !hasAttributes) return content === '' ? null : typed(content, options.types);

    // Next to child elements, whitespace is only indentation
    const textValue = groups.size ? texts.map((t) => t.trim()).filter(Boolean).join(' ') : content;
    if (textValue !== '') {
      if (groups.size) mixed++;
      obj[TEXT_KEY] = typed(textValue, options.types);
    }
    return obj;
  };

  const value = convert(root);
  const json = { [root.nodeName]: forceArrays.has(root.nodeName) ? [value] : value };

  const warnings: string[] = [];
  if (mixed) warnings.push(`${mixed} element${mixed === 1 ? ' mixes' : 's mix'} text with child elements: the text was joined into "${TEXT_KEY}", so its position is lost`);
  if (clashes.size) warnings.push(`attributes and child elements share the name${clashes.size === 1 ? '' : 's'} ${[...clashes].join(', ')}: set an attribute prefix to keep both`);

  return { output: JSON.stringify(json, null, 2), direction: 'xml-to-json', elements, warnings };
}

// ---- JSON to XML

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (s: string) => escapeText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');

function jsonToXml(text: string, options: XmlJsonOptions): XmlJsonResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`);
  }

  const prefix = options.attributePrefix;
  const renamed = new Map<string, string>();
  let elements = 0;
  let removedChars = 0;

  const safeName = (name: string): string => {
    if (XML_NAME.test(name)) return name;
    let fixed = name.replace(/[^\p{L}\p{N}_.\-]/gu, '_');
    if (!/^[\p{L}_]/u.test(fixed)) fixed = `_${fixed}`;
    renamed.set(name, fixed);
    return fixed;
  };

  const plain = (value: unknown): string => {
    const s = String(value);
    const cleaned = s.replace(INVALID_CHARS, '');
    removedChars += s.length - cleaned.length;
    return cleaned;
  };

  const lines: string[] = [];

  const write = (rawName: string, value: unknown, depth: number) => {
    const name = safeName(rawName);
    const pad = '  '.repeat(depth);

    if (Array.isArray(value)) {
      // Each item repeats the element. An array directly inside an array has no name of its own.
      for (const item of value) {
        if (Array.isArray(item)) write(name, { item }, depth);
        else write(name, item, depth);
      }
      return;
    }

    elements++;
    if (value === null || value === undefined) {
      lines.push(`${pad}<${name}/>`);
      return;
    }
    if (!isObject(value)) {
      lines.push(`${pad}<${name}>${escapeText(plain(value))}</${name}>`);
      return;
    }

    const attributes: string[] = [];
    const children: [string, unknown][] = [];
    let content: string | undefined;
    for (const [key, child] of Object.entries(value)) {
      if (key === TEXT_KEY) {
        content = child === null ? '' : plain(child);
      } else if (prefix && key.startsWith(prefix) && key.length > prefix.length) {
        if (typeof child === 'object' && child !== null) throw new Error(`Attribute ${key} on <${name}> must be a plain value, not an object or array.`);
        if (child !== null) attributes.push(` ${safeName(key.slice(prefix.length))}="${escapeAttribute(plain(child))}"`);
      } else {
        children.push([key, child]);
      }
    }

    const open = `${pad}<${name}${attributes.join('')}`;
    if (!children.length) {
      lines.push(content ? `${open}>${escapeText(content)}</${name}>` : `${open}/>`);
      return;
    }
    lines.push(`${open}>`);
    if (content) lines.push(`${pad}  ${escapeText(content)}`);
    for (const [key, child] of children) write(key, child, depth + 1);
    lines.push(`${pad}</${name}>`);
  };

  // A single top-level property is the root element, as in the XML to JSON output. Anything else is wrapped.
  const keys = isObject(data) ? Object.keys(data) : [];
  const single = isObject(data) && keys.length === 1 && keys[0] !== TEXT_KEY && !(prefix && keys[0].startsWith(prefix));
  if (single && !Array.isArray(data[keys[0]])) {
    write(keys[0], data[keys[0]], 0);
  } else {
    const wrapper = safeName(options.root.trim() || 'root');
    if (Array.isArray(data)) write(wrapper, data.length ? { item: data } : null, 0);
    else write(wrapper, isObject(data) ? data : { [TEXT_KEY]: data }, 0);
  }

  const warnings: string[] = [];
  if (renamed.size) {
    const sample = [...renamed].slice(0, 5).map(([from, to]) => `${from} → ${to}`).join(', ');
    warnings.push(`${renamed.size} name${renamed.size === 1 ? ' isn’t a valid XML name and was' : 's aren’t valid XML names and were'} changed: ${sample}${renamed.size > 5 ? '…' : ''}`);
  }
  // JSON.parse has already rounded these, so the warning comes from the source text
  if (/[:[,]\s*-?\d{16,}(?![\d.eE])/.test(text)) warnings.push('numbers with 16 or more digits lose precision when read: put long ids in quotes so they stay exact');
  if (removedChars) warnings.push(`${removedChars} control character${removedChars === 1 ? '' : 's'} removed: XML can't hold them, even escaped`);

  return { output: lines.join('\n'), direction: 'json-to-xml', elements, warnings };
}
