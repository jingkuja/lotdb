/**
 * Split a SQL script into individual statements on `;`,
 * skipping semicolons inside:
 *   - single-quoted strings ('it''s', 'a\'b')
 *   - double-quoted identifiers ("col name")
 *   - backtick identifiers (`col name`, MySQL)
 *   - line comments (double-dash, hash for MySQL)
 *   - block comments (slash-star delimited)
 *   - dollar-quoted bodies ($$ … $$, $body$ … $body$ — PG functions)
 *
 * Trailing semicolon is stripped per statement; whitespace-only results are
 * dropped (including statements that were only comments).
 */
export function splitStatements(sql: string, dialect: "mysql" | "postgres" = "mysql"): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i]!;

    // Line comments: -- and # (MySQL)
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end; // keep the newline itself
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "#" && dialect === "mysql") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Block comment
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Quoted string / identifier — consume to the closing quote.
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && quote === "'" && (dialect === "mysql" || (i > 0 && /[eE]/.test(sql[i - 1]!)))) {
          j += 2; // backslash escape inside '...'
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2; // doubled-quote escape
            continue;
          }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }

    // Dollar-quoted body: $tag$ … $tag$
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // Statement separator
    if (c === ";") {
      const trimmed = current.trim();
      if (trimmed && !isCommentOnly(trimmed, dialect)) out.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += c;
    i += 1;
  }

  const tail = current.trim();
  if (tail && !isCommentOnly(tail, dialect)) out.push(tail);
  return out;
}

/** True when the fragment contains nothing but comments and whitespace. */
function isCommentOnly(fragment: string, dialect: "mysql" | "postgres"): boolean {
  const stripped = fragment
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(dialect === "mysql" ? /#[^\n]*/g : /$^/g, "")
    .trim();
  return stripped === "";
}
