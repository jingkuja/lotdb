//! Shared row-value → JSON converters for MySQL and PostgreSQL.
//!
//! Every display path (query results, table grid, export) goes through these
//! two functions so values can't silently degrade to NULL on one path while
//! rendering correctly on another.
//!
//! Conversion rules:
//! - uuid / json / jsonb / arrays → JSON string
//! - bytea / BLOB → `\x`-prefixed hex (small) or a size placeholder (large)
//! - DECIMAL / NUMERIC / BIGINT UNSIGNED → string, to survive JS number precision
//! - undecodable types → "(不支持的类型: NAME)" instead of NULL

use sqlx::{Row, TypeInfo, ValueRef};

/// Placeholder prefix used for binary values too large to inline as hex.
const BLOB_HEX_LIMIT: usize = 2048;

const UNSUPPORTED: &str = "(不支持的类型";

fn unsupported(type_name: &str) -> serde_json::Value {
    serde_json::json!(format!("{UNSUPPORTED}: {type_name})"))
}

fn bytes_to_json(b: &[u8]) -> serde_json::Value {
    if b.len() > BLOB_HEX_LIMIT {
        return serde_json::json!(format!("(BLOB, {} 字节)", b.len()));
    }
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    serde_json::json!(format!("\\x{hex}"))
}

// ─── MySQL ────────────────────────────────────────────────────────

pub fn mysql_value_to_json(row: &sqlx::mysql::MySqlRow, i: usize) -> serde_json::Value {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    let Ok(raw) = row.try_get_raw(i) else {
        return serde_json::Value::Null;
    };
    if raw.is_null() {
        return serde_json::Value::Null;
    }
    let t = raw.type_info().name().to_ascii_lowercase();

    // Integer types. BIGINT UNSIGNED can exceed i64/JS safe range → string.
    if t.contains("bigint") && t.contains("unsigned") {
        if let Ok(n) = row.try_get::<u64, _>(i) {
            return serde_json::json!(n.to_string());
        }
    } else if t.contains("int") {
        if let Ok(n) = row.try_get::<i64, _>(i) {
            return serde_json::json!(n);
        }
        if let Ok(n) = row.try_get::<u64, _>(i) {
            return serde_json::json!(n);
        }
    }

    if t == "bit" {
        if let Ok(b) = row.try_get::<bool, _>(i) {
            return serde_json::json!(b);
        }
        if let Ok(b) = row.try_get::<Vec<u8>, _>(i) {
            return bytes_to_json(&b);
        }
    }

    if t.contains("float") || t.contains("double") {
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n);
        }
    }

    // DECIMAL — exact text, no f64 rounding.
    if t.contains("decimal") || t == "newdecimal" {
        if let Ok(s) = row.try_get::<String, _>(i) {
            return serde_json::json!(s);
        }
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n.to_string());
        }
    }

    if t == "datetime" || t == "timestamp" {
        if let Ok(dt) = row.try_get::<NaiveDateTime, _>(i) {
            return serde_json::json!(dt.to_string());
        }
    }
    if t == "date" {
        if let Ok(d) = row.try_get::<NaiveDate, _>(i) {
            return serde_json::json!(d.to_string());
        }
    }
    if t == "time" {
        if let Ok(v) = row.try_get::<NaiveTime, _>(i) {
            return serde_json::json!(v.to_string());
        }
    }

    // JSON → canonical compact string (grid/cell viewer treat it as text).
    if t == "json" {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
            return serde_json::json!(v.to_string());
        }
    }

    // Binary types.
    if t.contains("blob") || t.contains("binary") || t == "geometry" || t == "point" {
        if let Ok(b) = row.try_get::<Vec<u8>, _>(i) {
            return bytes_to_json(&b);
        }
    }

    // Text-ish: varchar / char / text / enum / set / year …
    if let Ok(s) = row.try_get::<String, _>(i) {
        return serde_json::json!(s);
    }
    if let Ok(b) = row.try_get::<Vec<u8>, _>(i) {
        return bytes_to_json(&b);
    }

    unsupported(&t)
}

// ─── PostgreSQL ───────────────────────────────────────────────────

pub fn pg_value_to_json(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};

    let Ok(raw) = row.try_get_raw(i) else {
        return serde_json::Value::Null;
    };
    if raw.is_null() {
        return serde_json::Value::Null;
    }
    let t = raw.type_info().name().to_ascii_lowercase();

    if ["int2", "int4", "int8", "oid", "xid", "cid"].contains(&t.as_str()) {
        if let Ok(n) = row.try_get::<i64, _>(i) {
            return serde_json::json!(n);
        }
    }

    if t == "float4" || t == "float8" {
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n);
        }
    }

    // NUMERIC — exact text, no f64 rounding.
    if t == "numeric" {
        // BigDecimal keeps the exact digits + scale; String/f64 alone can't
        // decode PG's binary NUMERIC format.
        if let Ok(d) = row.try_get::<sqlx::types::BigDecimal, _>(i) {
            return serde_json::json!(d.to_string());
        }
        if let Ok(s) = row.try_get::<String, _>(i) {
            return serde_json::json!(s);
        }
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n.to_string());
        }
    }

    if t == "bool" {
        if let Ok(b) = row.try_get::<bool, _>(i) {
            return serde_json::json!(b);
        }
    }

    // JSON / JSONB → compact string.
    if t == "json" || t == "jsonb" {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
            return serde_json::json!(v.to_string());
        }
        if let Ok(s) = row.try_get::<String, _>(i) {
            return serde_json::json!(s);
        }
    }

    if t == "timestamptz" {
        if let Ok(dt) = row.try_get::<DateTime<Utc>, _>(i) {
            return serde_json::json!(dt.to_rfc3339());
        }
    }
    if t == "timestamp" {
        if let Ok(dt) = row.try_get::<NaiveDateTime, _>(i) {
            return serde_json::json!(dt.to_string());
        }
    }
    if t == "date" {
        if let Ok(d) = row.try_get::<NaiveDate, _>(i) {
            return serde_json::json!(d.to_string());
        }
    }
    if t == "time" || t == "timetz" {
        if let Ok(v) = row.try_get::<NaiveTime, _>(i) {
            return serde_json::json!(v.to_string());
        }
    }

    if t == "uuid" {
        if let Ok(u) = row.try_get::<uuid::Uuid, _>(i) {
            return serde_json::json!(u.to_string());
        }
    }

    if t == "bytea" {
        if let Ok(b) = row.try_get::<Vec<u8>, _>(i) {
            return bytes_to_json(&b);
        }
    }

    // Arrays (`int[]`, `_text`, …) → PG array literal string.
    if t.ends_with("[]") || t.starts_with('_') {
        if let Some(lit) = pg_array_literal(row, i) {
            return serde_json::json!(lit);
        }
        return unsupported(&t);
    }

    // Text-ish fallback (varchar / text / name / citext / enum-as-text …).
    if let Ok(s) = row.try_get::<String, _>(i) {
        return serde_json::json!(s);
    }

    unsupported(&t)
}

/// Try to decode a PG array column into its textual literal `{1,2,3}`.
fn pg_array_literal(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
    macro_rules! try_vec {
        ($ty:ty) => {
            if let Ok(v) = row.try_get::<Vec<$ty>, _>(i) {
                let body = v
                    .iter()
                    .map(|e| pg_array_elem(&e.to_string()))
                    .collect::<Vec<_>>()
                    .join(",");
                return Some(format!("{{{body}}}"));
            }
        };
    }

    try_vec!(i16);
    try_vec!(i32);
    try_vec!(i64);
    try_vec!(f32);
    try_vec!(f64);
    try_vec!(bool);
    try_vec!(String);
    try_vec!(uuid::Uuid);
    None
}

/// Quote one array element only when the literal form requires it.
fn pg_array_elem(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s == "NULL"
        || s.chars()
            .any(|c| matches!(c, '"' | '\\' | '{' | '}' | ',' | ' '));
    if !needs_quote {
        return s.to_string();
    }
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_placeholder_for_large_binary() {
        let small_out = bytes_to_json(&[0u8; 16]);
        assert!(small_out.as_str().unwrap().starts_with("\\x"));
        let big_out = bytes_to_json(&vec![0u8; BLOB_HEX_LIMIT + 1]);
        let s = big_out.as_str().unwrap();
        assert!(s.starts_with("(BLOB,"));
        assert!(s.contains("字节"));
    }

    #[test]
    fn unsupported_mentions_type_name() {
        assert_eq!(
            unsupported("weirdtype").as_str().unwrap(),
            "(不支持的类型: weirdtype)"
        );
    }

    #[test]
    fn pg_array_elem_quoting() {
        assert_eq!(pg_array_elem("plain"), "plain");
        assert_eq!(pg_array_elem(""), "\"\"");
        assert_eq!(pg_array_elem("NULL"), "\"NULL\"");
        assert_eq!(pg_array_elem("a,b"), "\"a,b\"");
        assert_eq!(pg_array_elem("a b"), "\"a b\"");
        assert_eq!(pg_array_elem("q\"x"), "\"q\\\"x\"");
        assert_eq!(pg_array_elem("back\\slash"), "\"back\\\\slash\"");
    }
}
