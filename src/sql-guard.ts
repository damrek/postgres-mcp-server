const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN']);

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;
const LOCKING_CLAUSE = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export type ValidationResult = { valid: true } | { valid: false; reason: string };

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
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
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

  const leadingKeyword = /^([A-Za-z]+)/.exec(statements[0] ?? '')?.[1]?.toUpperCase();
  if (!leadingKeyword || !ALLOWED_LEADING_KEYWORDS.has(leadingKeyword)) {
    return {
      valid: false,
      reason: `Only read-only statements are allowed (SELECT, WITH, TABLE, VALUES, SHOW, EXPLAIN); received '${leadingKeyword ?? 'unknown'}'.`,
    };
  }

  if ((leadingKeyword === 'WITH' || leadingKeyword === 'EXPLAIN') && WRITE_KEYWORDS.test(statements[0])) {
    return { valid: false, reason: 'Data-modifying statements are not allowed, including inside CTEs.' };
  }

  if (LOCKING_CLAUSE.test(statements[0])) {
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
