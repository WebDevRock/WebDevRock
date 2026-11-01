// Reviews a T-SQL script written by an LLM before anyone runs it.
// It reads the text only: it never connects to a database, and it can be fooled.
// The real protection is the login the script runs as; this is a second pair of eyes.

export type Severity = 'danger' | 'warn' | 'info' | 'good';
export type Verdict = 'empty' | 'read' | 'write' | 'schema' | 'unknown';

export interface Finding {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  lines: number[];
}

export interface Review {
  verdict: Verdict;
  headline: string;
  summary: string;
  statements: number;
  findings: Finding[];
}

// ---------- Tokenising ----------
type TokType = 'word' | 'string' | 'number' | 'symbol';
interface Tok {
  t: TokType;
  v: string; // original text (for strings, the contents without quotes)
  u: string; // upper-case, for keyword matching
  line: number;
  depth: number; // bracket depth before this token
}

export function tokenise(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let depth = 0;
  const push = (t: TokType, v: string, at: number) => out.push({ t, v, u: v.toUpperCase(), line: at, depth });
  while (i < sql.length) {
    const c = sql[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Comments: -- to end of line, and /* */ which T-SQL lets you nest
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let nest = 0;
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          nest++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          nest--;
          i += 2;
          if (nest === 0) break;
        } else {
          if (sql[i] === '\n') line++;
          i++;
        }
      }
      continue;
    }
    // Strings: 'text' or N'text', with '' for a quote inside
    if (c === "'" || ((c === 'N' || c === 'n') && sql[i + 1] === "'")) {
      const at = line;
      i += c === "'" ? 1 : 2;
      let s = '';
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === '\n') line++;
        s += sql[i++];
      }
      push('string', s, at);
      continue;
    }
    // Quoted identifiers: [name] or "name"
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      let j = i + 1;
      let s = '';
      while (j < sql.length) {
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            s += close;
            j += 2;
            continue;
          }
          break;
        }
        s += sql[j++];
      }
      push('word', s, line);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      while (j < sql.length && /[0-9.eE]/.test(sql[j])) j++;
      push('number', sql.slice(i, j), line);
      i = j;
      continue;
    }
    if (/[A-Za-z_@#$]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_@#$]/.test(sql[j])) j++;
      push('word', sql.slice(i, j), line);
      i = j;
      continue;
    }
    if (c === '(') {
      push('symbol', c, line);
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      push('symbol', c, line);
      i++;
      continue;
    }
    // Two-character operators
    const two = sql.slice(i, i + 2);
    if (['<>', '!=', '<=', '>=', '!<', '!>'].includes(two)) {
      push('symbol', two, line);
      i += 2;
      continue;
    }
    push('symbol', c, line);
    i++;
  }
  return out;
}

// ---------- Splitting into statements ----------
const STARTERS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'EXEC', 'EXECUTE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'IF', 'ELSE', 'WHILE', 'DECLARE', 'SET', 'PRINT', 'THROW', 'RAISERROR',
  'RETURN', 'END', 'GRANT', 'DENY', 'REVOKE', 'USE', 'WITH', 'BACKUP', 'RESTORE', 'DBCC', 'KILL', 'SHUTDOWN',
  'WAITFOR', 'BREAK', 'CONTINUE', 'GOTO', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'BULK', 'GO',
]);
const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

interface Stmt {
  kind: string; // the leading keyword, or for WITH ... the statement the CTE belongs to
  toks: Tok[]; // every token, at any depth
}

function isCteStart(toks: Tok[], i: number) {
  // WITH name AS ( or WITH name (columns) AS (; table hints are WITH (NOLOCK)
  return toks[i + 1]?.t === 'word' && (toks[i + 2]?.u === 'AS' || toks[i + 2]?.v === '(');
}

export function splitStatements(toks: Tok[]): Stmt[] {
  const stmts: Stmt[] = [];
  let cur: Stmt | null = null;
  let caseDepth = 0;
  let setSeen = false; // an UPDATE's own SET clause
  let cteMain = false; // a WITH statement has reached its main statement

  const start = (kind: string) => {
    cur = { kind, toks: [] };
    stmts.push(cur);
    setSeen = false;
    cteMain = false;
  };

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.depth === 0 && tk.v === ';') {
      cur = null;
      continue;
    }
    if (tk.t === 'word' && tk.u === 'CASE') caseDepth++;
    let begins = false;
    if (tk.depth === 0 && tk.t === 'word' && STARTERS.has(tk.u)) {
      begins = true;
      const prev = toks[i - 1];
      const prevU = prev && prev.depth === 0 ? prev.u : '';
      const k: string = (cur as Stmt | null)?.kind ?? '';
      if (tk.u === 'END' && caseDepth > 0) {
        caseDepth--;
        begins = false;
      } else if (tk.u === 'WITH' && !isCteStart(toks, i)) begins = false;
      else if (['UNION', 'ALL', 'EXCEPT', 'INTERSECT'].includes(prevU)) begins = false;
      else if (['FOR', 'AFTER', 'OF', ','].includes(prevU) && ['INSERT', 'UPDATE', 'DELETE'].includes(tk.u)) begins = false; // triggers, cursors
      else if (tk.u === 'UPDATE' && toks[i + 1]?.v === '(') begins = false; // UPDATE(column) in a trigger
      else if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'END'].includes(prevU) && tk.u !== 'END' && ['TRAN', 'TRANSACTION'].includes(tk.u)) begins = false;
      else if (k === 'MERGE') begins = false; // MERGE has to end with a semicolon
      else if (k === 'UPDATE' && tk.u === 'SET' && !setSeen) {
        setSeen = true;
        begins = false;
      } else if (k === 'INSERT' && (tk.u === 'SELECT' || tk.u === 'EXEC' || tk.u === 'EXECUTE' || tk.u === 'WITH')) begins = false;
      else if (k === 'WITH' && !cteMain && DML.has(tk.u)) {
        // The statement the common table expression belongs to
        cteMain = true;
        (cur as unknown as Stmt).kind = tk.u;
        if (tk.u === 'UPDATE') setSeen = false;
        begins = false;
      } else if (k === 'CREATE' && prevU === 'AS' && tk.u === 'SELECT') begins = false; // CREATE VIEW ... AS SELECT
      else if (k === 'DECLARE' && tk.u === 'CURSOR') begins = false;
    }
    if (tk.u === 'GO' && tk.depth === 0 && begins) {
      cur = null;
      continue;
    }
    if (begins || !cur) start(tk.u);
    (cur as unknown as Stmt).toks.push(tk);
  }
  return stmts;
}

// ---------- Helpers ----------
const base = (s: Stmt) => s.toks[0]?.depth ?? 0;
const top = (s: Stmt) => s.toks.filter((t) => t.depth === base(s));
const hasTop = (s: Stmt, word: string) => top(s).some((t) => t.t === 'word' && t.u === word);

/** Read a possibly qualified name (db.schema.table) starting at index i of a token list */
function nameAt(toks: Tok[], i: number): { name: string; next: number } | null {
  if (toks[i]?.t !== 'word') return null;
  let name = toks[i].v;
  let j = i + 1;
  while (toks[j]?.v === '.' && toks[j + 1]?.t === 'word') {
    name += '.' + toks[j + 1].v;
    j += 2;
  }
  return { name, next: j };
}

const isLocal = (name: string) => {
  const last = name.split('.').pop() ?? '';
  return last.startsWith('#') || last.startsWith('@');
};

/** In UPDATE t ... FROM dbo.X AS t, t is an alias: find the table behind it */
function resolveAlias(s: Stmt, alias: string): string {
  const t = s.toks;
  const a = alias.toUpperCase();
  for (let i = 0; i < t.length; i++) {
    const n = nameAt(t, i);
    if (!n || n.name.toUpperCase() === a) continue;
    let j = n.next;
    if (t[j]?.u === 'AS') j++;
    if (t[j]?.t === 'word' && t[j].u === a && t[j].v.indexOf('.') < 0) return n.name;
  }
  return alias;
}

/** The table a data-changing statement writes to */
function writeTarget(s: Stmt): string | null {
  const t = top(s);
  const at = t.findIndex((x) => x.u === s.kind);
  if (at < 0) return null;
  let i = at + 1;
  if (s.kind === 'TRUNCATE' && t[i]?.u === 'TABLE') i++;
  if (t[i]?.u === 'TOP') {
    // TOP (n) is at a deeper bracket depth, so skip over it in the full token list
    const full = s.toks;
    let k = full.indexOf(t[i]) + 1;
    if (full[k]?.v === '(') {
      const d = full[k].depth;
      k++;
      while (k < full.length && !(full[k].v === ')' && full[k].depth === d)) k++;
      k++;
    } else k++;
    if (full[k]?.u === 'PERCENT') k++;
    i = t.indexOf(full[k]);
    if (i < 0) return null;
  }
  if (t[i]?.u === 'INTO' || (s.kind === 'DELETE' && t[i]?.u === 'FROM')) i++;
  const n = nameAt(t, i);
  if (!n) return null;
  if (s.kind === 'UPDATE' || s.kind === 'DELETE') {
    if (n.name.indexOf('.') < 0 && hasTop(s, 'FROM') && !(s.kind === 'DELETE' && t[at + 1]?.u === 'FROM')) return resolveAlias(s, n.name);
  }
  return n.name;
}

/** Tokens of the statement's own WHERE clause, at the statement's depth and any deeper */
function whereClause(s: Stmt): Tok[] {
  const b = base(s);
  const i = s.toks.findIndex((x) => x.depth === b && x.u === 'WHERE');
  if (i < 0) return [];
  const out: Tok[] = [];
  for (let j = i + 1; j < s.toks.length; j++) {
    const x = s.toks[j];
    if (x.depth === b && ['GROUP', 'ORDER', 'HAVING', 'OPTION', 'UNION', 'EXCEPT', 'INTERSECT', 'OUTPUT'].includes(x.u)) break;
    out.push(x);
  }
  return out;
}

const DATE_LIKE = /^\d{4}-?\d{2}-?\d{2}$/;
const COLUMN_FUNCS = new Set(['YEAR', 'MONTH', 'DAY', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM', 'LEFT', 'RIGHT', 'SUBSTRING', 'ISNULL', 'COALESCE', 'CAST']);
const SECOND_ARG_FUNCS = new Set(['CONVERT', 'DATEPART', 'DATENAME']);
const AGGREGATES = new Set(['COUNT', 'COUNT_BIG', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG']);
const ADMIN = new Set(['BACKUP', 'RESTORE', 'DBCC', 'KILL', 'SHUTDOWN']);
const PERMS = new Set(['GRANT', 'DENY', 'REVOKE']);
const OUTSIDE = new Set(['XP_CMDSHELL', 'OPENROWSET', 'OPENDATASOURCE', 'OPENQUERY', 'SP_CONFIGURE', 'SP_ADDLINKEDSERVER']);

// ---------- The review ----------
export function review(sql: string): Review {
  const toks = tokenise(sql);
  const stmts = splitStatements(toks);
  const found = new Map<string, Finding>();
  const add = (key: string, severity: Severity, title: string, detail: string, line?: number) => {
    const f = found.get(key) ?? { key, severity, title, detail, lines: [] };
    if (line && !f.lines.includes(line)) f.lines.push(line);
    found.set(key, f);
  };

  if (!stmts.length) {
    return { verdict: 'empty', headline: 'Nothing to check yet', summary: 'Paste a query or script.', statements: 0, findings: [] };
  }

  let writes = 0;
  let schema = 0;
  let opaque = 0;
  let firstWrite = -1;
  let copyBefore = false;
  let output = false;
  let begin = false;
  let lastTxn = '';
  const words = new Set(toks.filter((t) => t.t === 'word').map((t) => t.u));
  const rowcountCheck = words.has('@@ROWCOUNT') || words.has('ROWCOUNT_BIG');
  const xactAbort = stmts.some((s) => s.kind === 'SET' && s.toks[1]?.u === 'XACT_ABORT' && s.toks[2]?.u === 'ON');

  stmts.forEach((s, idx) => {
    const t = top(s);
    const line = s.toks[0].line;
    const k = s.kind;

    // Transactions
    if (k === 'BEGIN' && ['TRAN', 'TRANSACTION'].includes(s.toks[1]?.u)) begin = true;
    if (k === 'BEGIN' && s.toks[1]?.u === 'DISTRIBUTED') begin = true;
    if (k === 'COMMIT' || k === 'ROLLBACK') lastTxn = k;

    // Data changes
    if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE'].includes(k)) {
      const target = writeTarget(s);
      const local = target ? isLocal(target) : false;
      if (!local) {
        writes++;
        if (firstWrite < 0) firstWrite = idx;
        if (hasTop(s, 'OUTPUT')) output = true;
      } else if (k === 'INSERT' && firstWrite < 0) copyBefore = true; // INSERT INTO #before SELECT ...
      if (k === 'TRUNCATE' && !local) {
        add('truncate', 'danger', `TRUNCATE TABLE ${target}`, 'Removes every row in the table, with no WHERE clause possible. An AI-written script should never need this against production.', line);
      }
      if ((k === 'UPDATE' || k === 'DELETE') && !local) {
        const where = hasTop(s, 'WHERE');
        const join = hasTop(s, 'JOIN');
        if (!where && !join) {
          add(`nowhere-${idx}`, 'danger', `${k} with no WHERE clause`, `Changes every row in ${target ?? 'the table'}. If that's really intended, say so in a comment and check the row count first.`, line);
        } else if (!where && join) {
          add('joinonly', 'info', `${k} limited only by a JOIN`, 'The rows changed are the ones the JOIN matches. Run the same FROM ... JOIN as a SELECT COUNT(*) first, and check the join columns are unique on the other side.', line);
        }
      }
      if (k === 'MERGE' && !local) {
        add('merge', 'warn', 'MERGE statement', 'MERGE can insert, update and delete in one statement, and a WHEN NOT MATCHED BY SOURCE THEN DELETE clause removes every target row missing from the source. Check each WHEN clause separately.', line);
      }
    }

    // SELECT ... INTO creates a table
    if (k === 'SELECT' && hasTop(s, 'INTO')) {
      const i = t.findIndex((x) => x.u === 'INTO');
      const n = nameAt(t, i + 1);
      if (n && !isLocal(n.name)) {
        schema++;
        add('selectinto', 'info', `Creates a table: ${n.name}`, 'SELECT ... INTO needs CREATE TABLE permission and ALTER on the schema, so it fails under a read-only login. That\'s right for a backup copy before a fix, but not something to run unattended.', line);
      }
      if (firstWrite < 0) copyBefore = true;
    }

    // Structure, permissions and server administration
    if (['CREATE', 'ALTER', 'DROP'].includes(k)) {
      const what = s.toks[1]?.u ?? '';
      let i = 2;
      if (s.toks[i]?.u === 'IF' && s.toks[i + 1]?.u === 'EXISTS') i += 2;
      const n = nameAt(s.toks, i);
      const local = what === 'TABLE' && n && isLocal(n.name);
      if (!local) {
        schema++;
        const label = `${k} ${what}${n ? ' ' + n.name : ''}`;
        add(`ddl-${idx}`, k === 'DROP' ? 'danger' : 'warn', label, k === 'DROP' ? 'Removes the object and, for a table, all of its data. Rolling back is only possible inside an open transaction, and only until it commits.' : 'Changes the database structure. Schema changes belong in a reviewed migration, not an AI session.', line);
      }
    }
    if (PERMS.has(k)) {
      schema++;
      add(`perm-${idx}`, 'danger', `${k} permissions`, 'Changes who can do what. Never run permission changes suggested by a model without a person deciding to.', line);
    }
    if (ADMIN.has(k)) {
      schema++;
      add(`admin-${idx}`, 'danger', `${k} command`, 'Server administration, not a query. Nothing a model writes for you should include this.', line);
    }
    if (k === 'USE') add('use', 'info', `Switches database to ${s.toks[1]?.v ?? '?'}`, 'Everything after this runs in another database. Check it\'s the one you meant.', line);

    // Code the check can't see into
    if (k === 'EXEC' || k === 'EXECUTE' || (k === 'INSERT' && (hasTop(s, 'EXEC') || hasTop(s, 'EXECUTE')))) {
      const at = s.toks.findIndex((x) => x.u === 'EXEC' || x.u === 'EXECUTE');
      let i = at + 1;
      if (s.toks[i]?.t === 'word' && s.toks[i].v.startsWith('@') && s.toks[i + 1]?.v === '=') i += 2; // EXEC @rc = proc
      const n = nameAt(s.toks, i);
      const proc = n?.name ?? '';
      const last = (proc.split('.').pop() ?? '').toUpperCase();
      if (s.toks[i]?.v === '(' || last === 'SP_EXECUTESQL') {
        opaque++;
        add('dynamic', 'warn', 'Runs dynamic SQL', 'The statement is built at run time, so neither this check nor a reviewer can see what it does. Ask the model for the plain statement instead.', line);
      } else if (OUTSIDE.has(last)) {
        schema++;
        add(`outside-${idx}`, 'danger', `Calls ${proc}`, 'Reaches outside the database or changes server settings.', line);
      } else if (proc) {
        opaque++;
        add(`proc-${proc}`, 'info', `Runs stored procedure ${proc}`, 'This check can\'t see what the procedure does. Read it first, or ask what it changes.', line);
      }
    }
    for (const x of s.toks) {
      if (x.t === 'word' && OUTSIDE.has(x.u) && !(k === 'EXEC' || k === 'EXECUTE')) {
        schema++;
        add(`outside-${x.u}`, 'danger', `Uses ${x.v}`, 'Reads from or reaches outside this database. Not something an AI-written query should need.', x.line);
      }
    }

    // SET options worth knowing about
    if (k === 'SET') {
      const opt = s.toks[1]?.u;
      if (opt === 'TRANSACTION' && s.toks.some((x) => x.u === 'UNCOMMITTED')) {
        add('nolock', 'warn', 'Reads uncommitted data', 'READ UNCOMMITTED (or NOLOCK) can return changes that are later rolled back, and can miss rows or count them twice while other sessions change the table. Fine for a rough look, wrong for a number someone acts on.', line);
      }
      if (opt === 'QUERY_GOVERNOR_COST_LIMIT' || opt === 'LOCK_TIMEOUT' || opt === 'ROWCOUNT') {
        add(`set-${opt}`, 'warn', `Changes ${s.toks[1].v}`, 'The script changes a limit for its own connection. If your agent sets limits like this, it must also stop the model from changing them back.', line);
      }
    }

    // ---- How the query reads data: in any statement with a FROM or WHERE ----
    s.toks.forEach((x, j) => {
      if (x.t === 'word' && (x.u === 'NOLOCK' || x.u === 'READUNCOMMITTED') && ['(', ','].includes(s.toks[j - 1]?.v)) {
        add('nolock', 'warn', 'Reads uncommitted data', 'NOLOCK (READ UNCOMMITTED) can return changes that are later rolled back, and can miss rows or count them twice while other sessions change the table. Fine for a rough look, wrong for a number someone acts on.', x.line);
      }
      if (x.u === 'NOT' && s.toks[j + 1]?.u === 'IN' && s.toks[j + 2]?.v === '(' && s.toks[j + 3]?.u === 'SELECT') {
        add('notin', 'warn', 'NOT IN (SELECT ...)', 'If the subquery returns a single NULL, NOT IN matches nothing and the query quietly returns no rows. Use NOT EXISTS instead.', x.line);
      }
      if ((x.v === '=' || x.v === '<>' || x.v === '!=') && s.toks[j + 1]?.u === 'NULL' && !['SET', 'DECLARE', 'MERGE'].includes(k) && !(k === 'UPDATE' && !inWhere(s, j))) {
        add('eqnull', 'warn', `${x.v} NULL never matches`, 'A comparison with NULL is unknown, not true, so these rows are never returned. Use IS NULL or IS NOT NULL.', x.line);
      }
      if (x.u === 'LIKE' && s.toks[j + 1]?.t === 'string' && s.toks[j + 1].v.startsWith('%')) {
        add('likeleading', 'info', `LIKE '${s.toks[j + 1].v}' starts with a wildcard`, 'An index can\'t be used to find values by their middle or end, so SQL Server reads every row. Fine on small tables; slow on big ones.', x.line);
      }
      if (x.u === 'BETWEEN' && s.toks[j + 3]?.t === 'string' && DATE_LIKE.test(s.toks[j + 3].v) && s.toks[j + 1]?.t === 'string' && DATE_LIKE.test(s.toks[j + 1].v)) {
        add('betweendate', 'warn', `BETWEEN '${s.toks[j + 1].v}' AND '${s.toks[j + 3].v}'`, 'If the column holds a time as well as a date, this stops at midnight at the start of the last day and misses the rest of it. Use >= the first day and < the day after the last.', x.line);
      }
    });

    // The statement's own WHERE clause
    const where = whereClause(s);
    if (where.length) {
      // AND binds tighter than OR: flag OR and AND mixed at the clause's own level, without brackets
      const lvl = where[0].depth;
      let and = false;
      let or = false;
      let betweenPending = false;
      for (const x of where) {
        if (x.depth !== lvl || x.t !== 'word') continue;
        if (x.u === 'BETWEEN') betweenPending = true;
        else if (x.u === 'AND') {
          if (betweenPending) betweenPending = false;
          else and = true;
        } else if (x.u === 'OR') or = true;
      }
      if (and && or) {
        add(`andor-${idx}`, writesData(s) ? 'danger' : 'warn', 'AND and OR mixed without brackets', 'AND is worked out before OR, so a AND b OR c means (a AND b) OR c. Every row matching c is included, whatever a and b say. Add brackets to make the meaning explicit.', where[0].line);
      }
      // A function wrapped round a column can't use an index on it
      where.forEach((x, j) => {
        if (x.t !== 'word' || where[j + 1]?.v !== '(') return;
        let arg: Tok | undefined;
        if (COLUMN_FUNCS.has(x.u)) arg = where[j + 2];
        else if (SECOND_ARG_FUNCS.has(x.u)) {
          const d = where[j + 1].depth + 1;
          const comma = where.findIndex((y, m) => m > j + 1 && y.v === ',' && y.depth === d);
          arg = comma > 0 ? where[comma + 1] : undefined;
        }
        if (arg && arg.t === 'word' && !arg.v.startsWith('@') && !['GETDATE', 'SYSDATETIME', 'SYSUTCDATETIME', 'CURRENT_TIMESTAMP', 'NULL'].includes(arg.u)) {
          add('sargable', 'info', `${x.v}(${arg.v}...) in the WHERE clause`, 'Wrapping a column in a function stops SQL Server seeking an index on that column, so it reads every row. For dates, compare against a range instead, for example OrderDate >= \'2026-10-01\' AND OrderDate < \'2026-11-01\'.', x.line);
        }
      });
    }

    // Reads: the shape of the result
    if (k === 'SELECT' && !hasTop(s, 'INTO')) {
      const t0 = top(s);
      const sel = t0.findIndex((x) => x.u === 'SELECT');
      let i = sel + 1;
      if (t0[i]?.u === 'DISTINCT' || t0[i]?.u === 'ALL') i++;
      const hasTopN = t0[i]?.u === 'TOP';
      const from = t0.some((x) => x.u === 'FROM');
      // SELECT * or alias.* in the select list
      const fromAt = t0.findIndex((x) => x.u === 'FROM');
      const list = s.toks.slice(1, fromAt < 0 ? s.toks.length : s.toks.indexOf(t0[fromAt]));
      if (from && list.some((x, j) => x.v === '*' && x.depth === base(s) && (j === 0 || list[j - 1].u === 'SELECT' || list[j - 1].v === ',' || list[j - 1].v === '.' || list[j - 1].v === ')' || list[j - 1].u === 'DISTINCT'))) {
        add('star', 'info', 'SELECT * returns every column', 'Including any personal or sensitive columns, which then go into the model\'s context. Name the columns the answer needs.', s.toks[0].line);
      }
      if (hasTopN && !t0.some((x) => x.u === 'ORDER')) {
        add('topnoorder', 'warn', 'TOP without ORDER BY', 'Returns whichever rows SQL Server finds first, which can change from run to run. Add an ORDER BY if "top" is meant to mean something.', s.toks[0].line);
      }
      const aggregate = s.toks.some((x, j) => x.depth === base(s) && AGGREGATES.has(x.u) && s.toks[j + 1]?.v === '(');
      if (from && !hasTopN && !t0.some((x) => x.u === 'WHERE' || x.u === 'GROUP') && !aggregate && !t0.some((x) => x.u === 'OFFSET' || x.u === 'FETCH')) {
        add(`allrows-${idx}`, 'info', 'Returns every row', 'No WHERE, TOP or GROUP BY. Fine for a small lookup table; on a large table, it reads everything and sends it all back to the model.', s.toks[0].line);
      }
    }
  });

  // ---- The script as a whole ----
  if (writes) {
    if (!begin) {
      add('notran', 'warn', 'Changes data outside a transaction', 'Each statement is committed the moment it finishes, so there\'s no chance to check the result and undo it. Wrap the change in BEGIN TRANSACTION, and end with ROLLBACK until it\'s been checked.');
    } else {
      if (!lastTxn) add('opentran', 'warn', 'Leaves a transaction open', 'There\'s no COMMIT or ROLLBACK, so the changed rows stay locked until someone ends the transaction or the session closes.');
      if (lastTxn === 'ROLLBACK') add('dryrun', 'good', 'Ends with ROLLBACK: a dry run', 'You can run it, look at the results, and nothing is kept. Change the last ROLLBACK to COMMIT once the results are right.');
      if (lastTxn === 'COMMIT' && !rowcountCheck) add('commitblind', 'warn', 'Commits without checking the row count', 'Compare @@ROWCOUNT with the number of rows you expect straight after the change, and roll back if they differ.');
      if (!xactAbort) add('xact', 'info', 'No SET XACT_ABORT ON', 'Without it, a run-time error can roll back only the failing statement and let the rest of the transaction commit. Put SET XACT_ABORT ON at the top.');
    }
    if (rowcountCheck) add('rowcount', 'good', 'Checks how many rows changed', 'The script compares @@ROWCOUNT with what was expected, so a wrong filter is caught before anything is kept.');
    if (output || copyBefore) add('copy', 'good', output ? 'Records the old values with OUTPUT' : 'Copies the rows before changing them', 'There\'s a record of what the rows held before, so the change can be put back.');
    else add('nocopy', 'warn', 'Keeps no copy of the old values', 'Add OUTPUT deleted.* INTO an audit table, or copy the rows first, so the change can be put back later.');
  }

  const verdict: Verdict = schema ? 'schema' : writes ? 'write' : opaque ? 'unknown' : 'read';
  if (verdict === 'read') add('readonly', 'good', 'Only reads data', 'Run as a read-only login, nothing in this script can change anything. It can still be slow, or return more than it should.');

  const order: Severity[] = ['danger', 'warn', 'info', 'good'];
  const findings = [...found.values()].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const n = stmts.length;
  const counted = `${n} statement${n === 1 ? '' : 's'}`;
  const headlines: Record<Verdict, [string, string]> = {
    empty: ['Nothing to check yet', ''],
    read: [
      'Reads data only',
      `${counted}. Safe to run as a read-only login${findings.some((f) => f.severity === 'warn' || f.severity === 'danger') ? ', but check the points below before trusting the answer' : ''}.`,
    ],
    write: ['Changes data', `${counted}. Run it as a person, with a login that can write, after reviewing it. Never let an agent run it unattended.`],
    schema: ['Changes structure, permissions or the server', `${counted}. This goes beyond a data query. It needs a person, and probably a change process.`],
    unknown: ['Runs code this check can\'t see', `${counted}. It calls a procedure or dynamic SQL; what that does decides how safe this is.`],
  };
  return { verdict, headline: headlines[verdict][0], summary: headlines[verdict][1], statements: n, findings };
}

function writesData(s: Stmt) {
  return ['UPDATE', 'DELETE', 'MERGE'].includes(s.kind);
}

/** Is token j of an UPDATE inside its WHERE clause (rather than its SET clause, where = NULL is an assignment)? */
function inWhere(s: Stmt, j: number) {
  const b = base(s);
  const w = s.toks.findIndex((x) => x.depth === b && x.u === 'WHERE');
  return w >= 0 && j > w;
}

// ---------- Examples for the page ----------
export interface Sample {
  id: string;
  label: string;
  sql: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'report-first',
    label: 'Report: first attempt',
    sql: `-- Asked: "How much did each customer in Leeds spend in October?"
SELECT *
FROM dbo.Orders o WITH (NOLOCK)
JOIN dbo.Customers c ON c.CustomerId = o.CustomerId
WHERE c.City = 'Leeds'
  AND o.OrderDate BETWEEN '2026-10-01' AND '2026-10-31'
  AND o.Status NOT IN (SELECT Status FROM dbo.CancelledStatuses);`,
  },
  {
    id: 'report-fixed',
    label: 'Report: reviewed',
    sql: `-- Asked: "How much did each customer in Leeds spend in October?"
SELECT c.CustomerId, c.Name, SUM(o.Total) AS Spent, COUNT(*) AS Orders
FROM dbo.Orders AS o
JOIN dbo.Customers AS c ON c.CustomerId = o.CustomerId
WHERE c.City = N'Leeds'
  AND o.OrderDate >= '2026-10-01' AND o.OrderDate < '2026-11-01'
  AND NOT EXISTS (SELECT 1 FROM dbo.CancelledStatuses AS s WHERE s.Status = o.Status)
GROUP BY c.CustomerId, c.Name
ORDER BY Spent DESC;`,
  },
  {
    id: 'fix-first',
    label: 'Data fix: first attempt',
    sql: `-- Asked: "Void Acme's duplicate invoices from October"
UPDATE dbo.Invoices
SET Status = 'Void'
WHERE CustomerId = 4182
  AND InvoiceDate >= '2026-10-01'
  OR Reference LIKE '%DUP%';`,
  },
  {
    id: 'fix-safe',
    label: 'Data fix: made safe',
    sql: `-- Asked: "Void Acme's duplicate invoices from October"
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @expected int = 3;   -- from running the same WHERE as a SELECT first

UPDATE i
SET Status = 'Void'
OUTPUT deleted.InvoiceId, deleted.Status, inserted.Status, SYSUTCDATETIME()
  INTO dbo.DataFixAudit (InvoiceId, OldStatus, NewStatus, ChangedAt)
FROM dbo.Invoices AS i
WHERE i.CustomerId = 4182
  AND i.InvoiceDate >= '2026-10-01' AND i.InvoiceDate < '2026-11-01'
  AND i.Reference LIKE 'DUP-%';

IF @@ROWCOUNT <> @expected
BEGIN
    ROLLBACK TRANSACTION;
    THROW 50001, 'Unexpected row count, so nothing was changed.', 1;
END;

SELECT InvoiceId, Reference, Status
FROM dbo.Invoices
WHERE CustomerId = 4182 AND Status = 'Void';

ROLLBACK TRANSACTION;   -- a dry run: change to COMMIT once the results look right`,
  },
  {
    id: 'tidy',
    label: 'Agent "tidy-up"',
    sql: `-- Asked: "Clear out the old import data so the next run starts clean"
DELETE FROM dbo.ImportStaging;
TRUNCATE TABLE dbo.ImportErrors;
DROP TABLE dbo.Orders_Backup_2025;
EXEC sp_executesql @cleanup;`,
  },
];
