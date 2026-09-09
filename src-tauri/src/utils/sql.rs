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

pub fn readonly_sql(sql: &str, mysql: bool) -> Result<(), String> {
    let (statements, words) = scan_sql(sql, mysql)?;
    let allowed = matches!(
        words.first().map(String::as_str),
        Some("SELECT" | "SHOW" | "EXPLAIN" | "WITH" | "VALUES" | "TABLE" | "DESC" | "DESCRIBE")
    );
    let writes = words.iter().any(|w| {
        matches!(
            w.as_str(),
            "INSERT"
                | "UPDATE"
                | "DELETE"
                | "MERGE"
                | "REPLACE"
                | "INTO"
                | "CALL"
                | "DO"
                | "CREATE"
                | "ALTER"
                | "DROP"
                | "TRUNCATE"
                | "GRANT"
                | "REVOKE"
                | "SET"
                | "RESET"
                | "COPY"
                | "EXECUTE"
                | "PREPARE"
                | "LOCK"
                | "UNLOCK"
                | "LOAD"
                | "OUTFILE"
                | "DUMPFILE"
        )
    });
    if statements.len() != 1 || !allowed || writes || sql.contains("/*!") || sql.contains("/*M!") {
        return Err("该连接为只读模式，已拦截可能修改数据或会话的语句".into());
    }
    Ok(())
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
    fn literals_preserve_apostrophes_and_backslashes() {
        assert_eq!(string_literal("it's", false), "'it''s'");
        assert_eq!(string_literal("C:\\temp", false), "E'C:\\\\temp'");
        assert_eq!(
            string_literal("C:\\temp", true),
            "CONVERT(X'433a5c74656d70' USING utf8mb4)"
        );
    }
}
