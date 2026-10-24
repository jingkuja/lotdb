//! Small SQL text helpers shared across command modules.

/// Quote a MySQL identifier: escape inner backticks, wrap in backticks.
pub fn quote_ident_mysql(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

/// Quote a PostgreSQL identifier: escape inner double quotes, wrap in quotes.
pub fn quote_ident_pg(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Quote a PostgreSQL string literal ('' doubling). Safe under
/// standard_conforming_strings (on by default since PG 9.1, sqlx doesn't
/// disable it).
pub fn pg_string_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `db`.`name` — a fully qualified MySQL identifier.
pub fn qualified_mysql(a: &str, b: &str) -> String {
    format!("{}.{}", quote_ident_mysql(a), quote_ident_mysql(b))
}

/// "a"."b" — a fully qualified PostgreSQL identifier.
pub fn qualified_pg(a: &str, b: &str) -> String {
    format!("{}.{}", quote_ident_pg(a), quote_ident_pg(b))
}

/// String literals which also work with MySQL NO_BACKSLASH_ESCAPES and PG
/// standard_conforming_strings disabled. Binary values are handled separately.
pub fn string_literal(s: &str, mysql: bool) -> String {
    if mysql && (s.contains('\\') || s.contains('\0')) {
        let hex: String = s.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
        return format!("CONVERT(X'{hex}' USING utf8mb4)");
    }
    let escaped = s.replace('\'', "''");
    if !mysql && s.contains('\\') {
        format!("E'{}'", escaped.replace('\\', "\\\\"))
    } else {
        format!("'{escaped}'")
    }
}

/// Lex scripts without splitting quoted strings, dollar bodies or comments.
/// Comments are preserved (including MySQL executable comments). DELIMITER
/// directives are client syntax and are consumed rather than sent to the DB.
pub fn split_sql(sql: &str, mysql: bool) -> Result<Vec<String>, String> {
    scan_sql(sql, mysql).map(|(statements, _)| statements)
}

/// Statement gate for readonly connections. Queries also run inside a
/// `READ ONLY` transaction that is rolled back; this check covers what such a
/// transaction does not stop (files, session state, procedures) and gives a
/// clear message instead of a driver error.
///
/// The statement is judged by its verb and structure, not by keywords found
/// anywhere: `SHOW CREATE TABLE` or a column called `set`/`lock` is fine.
pub fn readonly_sql(sql: &str, mysql: bool) -> Result<(), String> {
    let (statements, tokens) = scan_sql(sql, mysql)?;
    let reject = || Err("该连接为只读模式，已拦截可能修改数据或会话的语句".into());
    if statements.len() != 1 || sql.contains("/*!") || sql.contains("/*M!") {
        return reject();
    }
    let tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();
    let start = tokens
        .iter()
        .position(|t| *t != "(")
        .unwrap_or(tokens.len());
    let ok = match tokens.get(start) {
        Some(&("SHOW" | "DESC" | "DESCRIBE")) => true,
        Some(&("SELECT" | "WITH" | "VALUES" | "TABLE")) => readonly_query(&tokens[start..]),
        Some(&"EXPLAIN") => readonly_explain(&tokens[start + 1..]),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        reject()
    }
}

/// EXPLAIN only plans the statement, unless ANALYZE makes it run.
fn readonly_explain(tokens: &[&str]) -> bool {
    let mut depth = 0;
    let mut analyze = false;
    for (i, t) in tokens.iter().enumerate() {
        match *t {
            "(" => depth += 1,
            ")" => depth -= 1,
            "ANALYZE" | "ANALYSE" => analyze = true,
            "SELECT" | "WITH" | "VALUES" | "TABLE" if depth == 0 => {
                return !analyze || readonly_query(&tokens[i..]);
            }
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "REPLACE" | "CREATE" | "EXECUTE"
                if depth == 0 =>
            {
                return !analyze;
            }
            _ => {}
        }
    }
    true
}

/// A SELECT-like statement, rejected when it writes: `INTO` (OUTFILE,
/// DUMPFILE, PG `SELECT INTO` a new table, MySQL variables), a top-level
/// DML verb after `WITH`, or a data-modifying CTE body.
fn readonly_query(tokens: &[&str]) -> bool {
    let mut depth = 0;
    for (i, t) in tokens.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| tokens[p]);
        let next = tokens.get(i + 1).copied();
        match *t {
            "(" => depth += 1,
            ")" => depth -= 1,
            "INTO" => return false,
            // MySQL's INSERT(str, pos, len, new) string function.
            "INSERT" if next == Some("(") => {}
            // Row locks: FOR UPDATE / FOR NO KEY UPDATE.
            "UPDATE" if matches!(prev, Some("FOR" | "KEY")) => {}
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" if depth == 0 || prev == Some("(") => {
                return false
            }
            _ => {}
        }
    }
    true
}

/// Mask password literals before SQL is written to query history: MySQL
/// `IDENTIFIED [WITH plugin] BY|AS '…'` (and `REPLACE '…'`), `PASSWORD('…')`,
/// `SET PASSWORD … = '…'`, PG `[ENCRYPTED] PASSWORD '…'`. Other literals and
/// a column merely named `password` are left alone.
pub fn redact_secrets(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut rest = sql;
    let mut prev_word = String::new();
    // Inside an IDENTIFIED clause, BY / AS / REPLACE introduce secrets.
    let mut identified = false;
    // `SET PASSWORD [FOR 'u'@'h'] = '…'`: the secret follows the `=`.
    let mut set_password = false;
    // The next string literal is a secret, if it comes before any other word.
    let mut armed = false;
    while let Some(c) = rest.chars().next() {
        if c == '\'' || c == '"' {
            let end = literal_end(rest, c);
            if armed {
                out.push(c);
                out.push_str("***");
                out.push(c);
                armed = false;
                set_password = false;
            } else {
                out.push_str(&rest[..end]);
            }
            rest = &rest[end..];
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let end = rest
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
                .unwrap_or(rest.len());
            let word = rest[..end].to_ascii_uppercase();
            armed = match word.as_str() {
                "PASSWORD" if prev_word == "SET" => {
                    set_password = true;
                    false
                }
                "PASSWORD" => true,
                "BY" | "AS" | "REPLACE" => identified,
                _ => false,
            };
            // `IDENTIFIED WITH plugin BY …` keeps the clause open up to BY/AS.
            identified = word == "IDENTIFIED"
                || (identified && (word == "WITH" || prev_word == "WITH"))
                || (identified && armed);
            prev_word = word;
            out.push_str(&rest[..end]);
            rest = &rest[end..];
            continue;
        }
        if c == '=' && set_password {
            armed = true;
        } else if !(c.is_whitespace() || c == '=' || c == '(') {
            armed = false;
        }
        if c == ';' {
            identified = false;
            set_password = false;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// Byte length of the quoted literal at the start of `s` (to its end when
/// unterminated). Backslash escapes are honored: over-masking is harmless.
fn literal_end(s: &str, quote: char) -> usize {
    let mut chars = s.char_indices().skip(1);
    while let Some((i, ch)) = chars.next() {
        if ch == '\\' {
            chars.next();
        } else if ch == quote {
            if s[i + 1..].starts_with(quote) {
                chars.next();
            } else {
                return i + 1;
            }
        }
    }
    s.len()
}

fn scan_sql(sql: &str, mysql: bool) -> Result<(Vec<String>, Vec<String>), String> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut words = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut meaningful = false;
    let mut delimiter = ";".to_string();
    while i < bytes.len() {
        let c = bytes[i];
        if mysql && (i == 0 || bytes[i - 1] == b'\n') {
            let end = sql[i..].find('\n').map(|n| i + n).unwrap_or(bytes.len());
            let line = sql[i..end].trim();
            if line.to_ascii_uppercase().starts_with("DELIMITER ") {
                if meaningful {
                    return Err("DELIMITER 必须位于语句之间".into());
                }
                delimiter = line[10..].trim().to_string();
                if delimiter.is_empty() {
                    return Err("DELIMITER 不能为空".into());
                }
                i = end;
                start = end;
                continue;
            }
        }
        if sql[i..].starts_with(&delimiter) {
            if meaningful {
                statements.push(sql[start..i].trim().to_string());
            }
            i += delimiter.len();
            start = i;
            meaningful = false;
            continue;
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if (c == b'-'
            && bytes.get(i + 1) == Some(&b'-')
            && (!mysql || bytes.get(i + 2).is_none_or(|b| b.is_ascii_whitespace())))
            || (mysql && c == b'#')
        {
            i = sql[i..].find('\n').map(|n| i + n).unwrap_or(bytes.len());
            continue;
        }
        if sql[i..].starts_with("/*") {
            if sql[i..].starts_with("/*!") || sql[i..].starts_with("/*M!") {
                meaningful = true;
            }
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if !mysql && sql[i..].starts_with("/*") {
                    depth += 1;
                    i += 2;
                } else if sql[i..].starts_with("*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += sql[i..].chars().next().unwrap().len_utf8();
                }
            }
            if depth != 0 {
                return Err("SQL 块注释未闭合".into());
            }
            continue;
        }
        meaningful = true;
        if matches!(c, b'\'' | b'"' | b'`') {
            let escape = (mysql && c != b'`')
                || (!mysql && c == b'\'' && i > 0 && matches!(bytes[i - 1], b'e' | b'E'));
            i += 1;
            let mut closed = false;
            while i < bytes.len() {
                if escape && bytes[i] == b'\\' {
                    i += 1;
                    if i < bytes.len() {
                        i += sql[i..].chars().next().unwrap().len_utf8();
                    }
                } else if bytes[i] == c {
                    i += 1;
                    if bytes.get(i) == Some(&c) {
                        i += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    i += sql[i..].chars().next().unwrap().len_utf8();
                }
            }
            if !closed {
                return Err("SQL 字符串或标识符未闭合".into());
            }
            continue;
        }
        if !mysql && c == b'$' {
            let mut end = i + 1;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            if bytes.get(end) == Some(&b'$') && (end == i + 1 || !bytes[i + 1].is_ascii_digit()) {
                let tag = &sql[i..=end];
                let stop = sql[end + 1..].find(tag).ok_or("SQL dollar quote 未闭合")?;
                i = end + 1 + stop + tag.len();
                continue;
            }
        }
        if c == b'(' || c == b')' {
            words.push((c as char).to_string());
            i += 1;
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let begin = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            words.push(sql[begin..i].to_ascii_uppercase());
        } else {
            i += sql[i..].chars().next().unwrap().len_utf8();
        }
    }
    if meaningful {
        statements.push(sql[start..].trim().to_string());
    }
    Ok((statements, words))
}

#[cfg(test)]
mod regression_tests {
    use super::*;
    #[test]
    fn exported_header_and_quoted_semicolons_survive_import() {
        let parts = split_sql("-- Generated by LotDB\nINSERT INTO t VALUES ('a;b'); INSERT INTO t VALUES ('it''s'); -- tail", false).unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("'a;b'"));
    }
    #[test]
    fn handles_dollar_quotes_nested_comments_and_mysql_delimiters() {
        assert_eq!(
            split_sql(
                "/* a /* b */ c */ DO $body$ BEGIN PERFORM 1; END $body$; SELECT 1;",
                false
            )
            .unwrap()
            .len(),
            2
        );
        assert_eq!(split_sql("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();", true).unwrap().len(), 2);
        assert!(split_sql("SELECT 'unterminated", false).is_err());
        assert_eq!(split_sql("SELECT 'a\\'; SELECT 2", false).unwrap().len(), 2);
    }
    #[test]
    fn read_only_rejects_writable_ctes_calls_and_session_changes() {
        for sql in [
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
            "CALL p()",
            "EXPLAIN ANALYZE DELETE FROM t",
            "SELECT 1; DELETE FROM t",
            "SET transaction_read_only=off",
            "SELECT 1 INTO OUTFILE '/tmp/a'",
        ] {
            assert!(readonly_sql(sql, false).is_err(), "{sql}");
        }
        for sql in [
            "SELECT 'DELETE'",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "EXPLAIN SELECT * FROM t",
        ] {
            assert!(readonly_sql(sql, false).is_ok(), "{sql}");
        }
    }
    #[test]
    fn read_only_allows_metadata_and_keyword_named_columns() {
        for (sql, mysql) in [
            ("SHOW CREATE TABLE `t`", true),
            ("SHOW CREATE PROCEDURE p", true),
            ("DESCRIBE t", true),
            ("SELECT lock, do, reset FROM t WHERE copy = 1", false),
            ("SELECT `set`, `call` FROM t", true),
            ("SELECT INSERT('abc', 1, 1, 'x')", true),
            ("SELECT * FROM t FOR UPDATE", true),
            ("SELECT * FROM t FOR NO KEY UPDATE", false),
            ("(SELECT 1) UNION (SELECT 2)", false),
            ("EXPLAIN ANALYZE SELECT * FROM t", true),
            ("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t", false),
            ("EXPLAIN DELETE FROM t", false),
            ("TABLE t", false),
        ] {
            assert!(readonly_sql(sql, mysql).is_ok(), "{sql}");
        }
        for (sql, mysql) in [
            ("EXPLAIN (ANALYZE) DELETE FROM t", false),
            ("EXPLAIN ANALYZE UPDATE t SET a = 1", true),
            (
                "EXPLAIN ANALYZE WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
                false,
            ),
            ("WITH x AS (SELECT 1) DELETE FROM t", false),
            (
                "WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x",
                false,
            ),
            (
                "WITH x AS NOT MATERIALIZED (DELETE FROM t RETURNING *) TABLE x",
                false,
            ),
            ("SELECT * INTO new_t FROM t", false),
            ("SELECT 1 INTO @v", true),
            ("TABLE t INTO OUTFILE '/tmp/a'", true),
            ("/*!40101 SET NAMES utf8 */ SELECT 1", true),
            ("LOCK TABLES t READ", true),
            ("DO 1", true),
            ("RESET ALL", false),
        ] {
            assert!(readonly_sql(sql, mysql).is_err(), "{sql}");
        }
    }
    #[test]
    fn redacts_passwords_but_not_other_literals() {
        for (sql, want) in [
            (
                "CREATE USER 'u'@'%' IDENTIFIED BY 'p''w'",
                "CREATE USER 'u'@'%' IDENTIFIED BY '***'",
            ),
            (
                "ALTER USER u IDENTIFIED WITH caching_sha2_password BY \"s3\" REPLACE 'old'",
                "ALTER USER u IDENTIFIED WITH caching_sha2_password BY \"***\" REPLACE '***'",
            ),
            ("SET PASSWORD FOR u = 'x\\'y'", "SET PASSWORD FOR u = '***'"),
            (
                "SET PASSWORD FOR 'u'@'%' = 'x'",
                "SET PASSWORD FOR 'u'@'%' = '***'",
            ),
            ("SELECT PASSWORD('abc')", "SELECT PASSWORD('***')"),
            (
                "create role r login encrypted password 'md5x'",
                "create role r login encrypted password '***'",
            ),
            (
                "ALTER ROLE r WITH PASSWORD 'a' VALID UNTIL '2030-01-01'",
                "ALTER ROLE r WITH PASSWORD '***' VALID UNTIL '2030-01-01'",
            ),
            (
                "SELECT password FROM users WHERE name = 'bob'",
                "SELECT password FROM users WHERE name = 'bob'",
            ),
            (
                "SELECT * FROM t WHERE a = 'IDENTIFIED BY x' AND b = 'keep'",
                "SELECT * FROM t WHERE a = 'IDENTIFIED BY x' AND b = 'keep'",
            ),
            ("GRANT r TO u; SELECT 'by'", "GRANT r TO u; SELECT 'by'"),
            (
                "CREATE USER u IDENTIFIED BY 'unterminated",
                "CREATE USER u IDENTIFIED BY '***'",
            ),
        ] {
            assert_eq!(redact_secrets(sql), want, "{sql}");
        }
    }
    #[test]
    fn literals_preserve_apostrophes_and_backslashes() {
        assert_eq!(string_literal("it's", false), "'it''s'");
        assert_eq!(string_literal("C:\\temp", false), "E'C:\\\\temp'");
        assert_eq!(
            string_literal("C:\\temp", true),
            "CONVERT(X'433a5c74656d70' USING utf8mb4)"
        );
    }
}
