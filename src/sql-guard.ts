const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN']);
const EXPLAINABLE_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;
const SELECT_INTO = /\bINTO\b/i;
const LOCKING_CLAUSE = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export type ValidationResult = { valid: true } | { valid: false; reason: string };

function isEscapeStringStart(sql: string, quoteIndex: number): boolean {
  if (quoteIndex === 0) {
    return false;
  }
  const prefix = sql[quoteIndex - 1];
  if (prefix !== 'E' && prefix !== 'e') {
    return false;
  }
  return quoteIndex === 1 || !/[A-Za-z0-9_$]/.test(sql[quoteIndex - 2]);
}

/**
 * Replaces string literals, quoted identifiers, and comments with spaces so the
 * remaining text can be inspected for statement separators and keywords without
 * matching content inside literals.
 *
 * Returns null when a literal, identifier, or comment is not terminated.
 */
function stripLiteralsAndComments(sql: string): string | null {
  const output: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      const lineEnd = sql.indexOf('\n', index + 2);
      const stop = lineEnd === -1 ? sql.length : lineEnd;
      output.push(' '.repeat(stop - index));
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
        } else if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) {
        return null;
      }
      output.push(' '.repeat(cursor - index));
      index = cursor;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      const escapeString = quote === "'" && isEscapeStringStart(sql, index);
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
        if (escapeString && sql[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        return null;
      }
      output.push(' '.repeat(cursor - index));
      index = cursor;
      continue;
    }

    if (char === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closing = sql.indexOf(tag, index + tag.length);
        if (closing === -1) {
          return null;
        }
        const stop = closing + tag.length;
        output.push(' '.repeat(stop - index));
        index = stop;
        continue;
      }
    }

    output.push(char);
    index += 1;
  }

  return output.join('');
}

function firstWord(text: string): string | undefined {
  return /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase();
}

function skipOptionsClause(text: string): string {
  let cursor = 0;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  if (text[cursor] !== '(') {
    return text;
  }

  let depth = 0;
  while (cursor < text.length) {
    if (text[cursor] === '(') {
      depth += 1;
    } else if (text[cursor] === ')') {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
    cursor += 1;
  }
  return text.slice(cursor);
}

function consumeBareExplainOptions(text: string): string {
  let remaining = text;
  for (;;) {
    const match = /^\s*(ANALYZE|ANALYSE|VERBOSE)\b/i.exec(remaining);
    if (!match) {
      return remaining;
    }
    remaining = remaining.slice(match[0].length);
  }
}

interface AnalysedStatement {
  text: string;
  keyword: string;
}

/**
 * Returns the statement that will actually run. For EXPLAIN, this is the
 * explained statement, so DDL hidden behind EXPLAIN ANALYZE cannot slip past
 * the keyword checks. Returns null when an EXPLAIN target is not a read-only
 * query.
 */
function analyseStatement(statement: string): AnalysedStatement | null {
  const keyword = firstWord(statement);
  if (!keyword) {
    return null;
  }
  if (keyword !== 'EXPLAIN') {
    return { text: statement, keyword };
  }

  const explained = consumeBareExplainOptions(
    skipOptionsClause(statement.replace(/^\s*EXPLAIN\b/i, ''))
  ).trim();
  const explainedKeyword = firstWord(explained);
  if (!explainedKeyword || !EXPLAINABLE_KEYWORDS.has(explainedKeyword)) {
    return null;
  }
  return { text: explained, keyword: explainedKeyword };
}

export function checkReadOnlySql(sql: string): ValidationResult {
  if (!sql.trim()) {
    return { valid: false, reason: 'SQL statement is empty.' };
  }

  const stripped = stripLiteralsAndComments(sql);
  if (stripped === null) {
    return { valid: false, reason: 'SQL contains an unterminated string, identifier, or comment.' };
  }

  const statements = stripped
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  if (statements.length > 1) {
    return { valid: false, reason: 'Only a single statement is allowed per query.' };
  }

  const leadingKeyword = firstWord(statements[0] ?? '');
  if (!leadingKeyword || !ALLOWED_LEADING_KEYWORDS.has(leadingKeyword)) {
    return {
      valid: false,
      reason: `Only read-only statements are allowed (SELECT, WITH, TABLE, VALUES, SHOW, EXPLAIN); received '${leadingKeyword ?? 'unknown'}'.`,
    };
  }

  const analysed = analyseStatement(statements[0]);
  if (!analysed) {
    return {
      valid: false,
      reason: 'EXPLAIN is only allowed for read-only SELECT, WITH, VALUES, or TABLE statements.',
    };
  }

  if (SELECT_INTO.test(analysed.text)) {
    return { valid: false, reason: 'SELECT INTO creates a table and is not allowed.' };
  }

  if (analysed.keyword === 'WITH' && WRITE_KEYWORDS.test(analysed.text)) {
    return { valid: false, reason: 'Data-modifying statements are not allowed, including inside CTEs.' };
  }

  if (LOCKING_CLAUSE.test(analysed.text)) {
    return { valid: false, reason: 'Locking clauses (FOR UPDATE/SHARE) are not allowed in read-only queries.' };
  }

  return { valid: true };
}

export function checkTableName(tableName: string): ValidationResult {
  const parts = tableName.split('.');
  if (parts.length > 2) {
    return { valid: false, reason: `Invalid table name '${tableName}'. Use table or schema.table.` };
  }
  for (const part of parts) {
    if (!IDENTIFIER_PART.test(part)) {
      return {
        valid: false,
        reason: `Invalid table name '${tableName}'. Use unquoted identifiers with letters, digits, or underscores.`,
      };
    }
  }
  return { valid: true };
}

export function checkWhereClause(whereClause: string): ValidationResult {
  const stripped = stripLiteralsAndComments(whereClause);
  if (stripped === null) {
    return { valid: false, reason: 'WHERE clause contains an unterminated string, identifier, or comment.' };
  }
  if (!stripped.trim()) {
    return { valid: false, reason: 'WHERE clause is empty.' };
  }
  if (stripped.includes(';')) {
    return { valid: false, reason: 'WHERE clause must be a single expression without statement separators.' };
  }
  return { valid: true };
}
