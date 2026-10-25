// Links that open a tool with its inputs filled in. The inputs travel after the # in the address, which
// browsers never send to the server (and the Umami tracker is told to ignore), so pasted data stays private
// to whoever has the link. Two forms, both read by src/scripts/tool-state.ts:
//
//   #retries=4&jitter=equal   readable, for "Open in tool" links written into snippets (toolLink below)
//   #z=<compressed>            compact, made by a tool's "Copy share link" button
//
// Keys are the tools' [data-field] names. Checkboxes use 1 and 0.

export type ToolValues = Record<string, string | number | boolean>;

// The inputs each tool saves and restores, and the button that shows the result
export const TOOL_FIELDS: Record<string, { fields: string[]; run: string }> = {
  'list-to-sql': { fields: ['input', 'format', 'header', 'dedupe'], run: 'generate' },
  'json-to-openjson': { fields: ['input', 'path', 'flatten', 'sample', 'temp'], run: 'generate' },
  'xml-to-nodes': { fields: ['input', 'path', 'child', 'flatten', 'sample', 'temp'], run: 'generate' },
  'xml-json-converter': { fields: ['input', 'direction', 'prefix', 'root', 'arrays', 'types'], run: 'convert' },
  'data-fix-script': {
    fields: ['action', 'table', 'keys', 'columns', 'mode', 'ticket', 'source', 'set', 'where', 'batched', 'batch-size'],
    run: 'generate',
  },
  'retry-schedule': { fields: ['retries', 'unit', 'base', 'multiplier', 'max', 'timeout', 'jitter'], run: 'calculate' },
  'timestamp-converter': { fields: ['input', 'kind', 'zone'], run: 'convert' },
};

export const toolPath = (tool: string) => `/tools/${tool}/`;

export function toolLink(tool: string, values: ToolValues): string {
  const known = TOOL_FIELDS[tool];
  if (!known) throw new Error(`Unknown tool "${tool}": add it to TOOL_FIELDS in src/lib/tool-links.ts`);
  const unknown = Object.keys(values).filter((key) => !known.fields.includes(key));
  if (unknown.length) throw new Error(`${tool} has no field(s) ${unknown.join(', ')}. Fields: ${known.fields.join(', ')}`);

  const params = new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value)]),
  );
  return `${toolPath(tool)}#${params}`;
}
