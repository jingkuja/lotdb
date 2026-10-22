//! Shared row-value → JSON converters for MySQL and PostgreSQL.
//!
//! Every display path (query results, table grid) and every data-moving path
//! (export, transfer) goes through these functions so a value can't render on
//! one path and silently degrade on another.
//!
//! Conversion rules:
//! - uuid / json / jsonb / arrays / enums / intervals / inet → JSON string
//! - bytea / BLOB → complete `\x`-prefixed hex; exports use a binary type tag
//! - MySQL BINARY-flagged columns holding readable UTF-8 text (e.g. columns
//!   with a `_bin` collation, which the protocol reports as VARBINARY) → text
//! - DECIMAL / NUMERIC / BIGINT → string, to survive JS number precision
//! - undecodable types → "(不支持的类型: NAME)" for display; export and
//!   transfer refuse them instead of writing the placeholder as data

use sqlx::postgres::{PgTypeKind, PgValueFormat};
use sqlx::{Column, Row, TypeInfo, ValueRef};

const UNSUPPORTED: &str = "(不支持的类型";

fn unsupported(type_name: &str) -> serde_json::Value {
    serde_json::json!(format!("{UNSUPPORTED}: {type_name})"))
}

fn bytes_to_json(b: &[u8]) -> serde_json::Value {
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    serde_json::json!(format!("\\x{hex}"))
}

/// Readable UTF-8 is shown as text, anything else as hex. Text that itself
/// starts with `\x` stays hex so it can't be mistaken for the hex form.
fn bytes_to_display(b: &[u8]) -> serde_json::Value {
    match std::str::from_utf8(b) {
        Ok(s)
            if !s.starts_with("\\x")
                && s.chars()
                    .all(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r')) =>
        {
            serde_json::json!(s)
        }
        _ => bytes_to_json(b),
    }
}

/// Export failure for a column whose type has no lossless representation.
fn export_error(column: &str, type_name: &str) -> String {
    format!("列 {column} 的类型 {type_name} 暂不支持导出，已中止以免写入错误数据")
}

// ─── MySQL ────────────────────────────────────────────────────────

pub fn mysql_value_to_json(row: &sqlx::mysql::MySqlRow, i: usize) -> serde_json::Value {
    mysql_value(row, i).unwrap_or_else(|t| unsupported(&t))
}

/// Decode one MySQL cell; `Err` carries the type name when no decoder fits.
fn mysql_value(row: &sqlx::mysql::MySqlRow, i: usize) -> Result<serde_json::Value, String> {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    use serde_json::json;
    use sqlx::mysql::types::MySqlTime;

    let Ok(raw) = row.try_get_raw(i) else {
        return Ok(serde_json::Value::Null);
    };
    let t = raw.type_info().name().to_ascii_lowercase();
    if raw.is_null() {
        // sqlx reports binary-protocol zero dates as NULL; a real NULL has no
        // bytes at all, a zero date is the single length byte 0.
        if matches!(t.as_str(), "date" | "datetime" | "timestamp") {
            if let Some(s) = row
                .try_get_unchecked::<Vec<u8>, _>(i)
                .ok()
                .and_then(|b| mysql_temporal_text(&b, t != "date"))
            {
                return Ok(json!(s));
            }
        }
        return Ok(serde_json::Value::Null);
    }

    match t.as_str() {
        // TINYINT(1) is reported as BOOLEAN but may hold any TINYINT value;
        // render the number like the mysql CLI does instead of true/false.
        "boolean" => {
            if let Ok(n) = row.try_get::<i64, _>(i) {
                return Ok(json!(n));
            }
            if let Ok(n) = row.try_get::<u64, _>(i) {
                return Ok(json!(n));
            }
        }
        // Can exceed i64 / JS safe range → string.
        "bigint unsigned" => {
            if let Ok(n) = row.try_get::<u64, _>(i) {
                return Ok(json!(n.to_string()));
            }
        }
        "bigint" => {
            if let Ok(n) = row.try_get::<i64, _>(i) {
                return Ok(json!(n.to_string()));
            }
        }
        "tinyint" | "smallint" | "mediumint" | "int" => {
            if let Ok(n) = row.try_get::<i64, _>(i) {
                return Ok(json!(n));
            }
        }
        "tinyint unsigned" | "smallint unsigned" | "mediumint unsigned" | "int unsigned" => {
            if let Ok(n) = row.try_get::<u64, _>(i) {
                return Ok(json!(n));
            }
        }
        "year" => {
            if let Ok(n) = row.try_get::<u16, _>(i) {
                return Ok(json!(n));
            }
        }
        // BIT(n) arrives as big-endian bytes in both protocols.
        "bit" => {
            if let Ok(b) = row.try_get_unchecked::<Vec<u8>, _>(i) {
                if b.len() <= 8 {
                    return Ok(json!(b
                        .iter()
                        .fold(0u64, |acc, x| (acc << 8) | u64::from(*x))));
                }
                return Ok(bytes_to_json(&b));
            }
        }
        "float" | "double" => {
            if let Ok(n) = row.try_get::<f64, _>(i) {
                return Ok(json!(n));
            }
        }
        // DECIMAL — exact text, no f64 rounding.
        "decimal" => {
            if let Ok(n) = row.try_get::<sqlx::types::BigDecimal, _>(i) {
                return Ok(json!(n.to_string()));
            }
        }
        // sqlx only marks NaiveDateTime compatible with DATETIME, but the wire
        // format of TIMESTAMP is identical. Zero / partial-zero dates (legal
        // in MySQL, invalid in chrono) fall back to their literal form.
        "datetime" | "timestamp" => {
            if let Ok(dt) = row.try_get_unchecked::<NaiveDateTime, _>(i) {
                return Ok(json!(dt.to_string()));
            }
            if let Some(s) = row
                .try_get_unchecked::<Vec<u8>, _>(i)
                .ok()
                .and_then(|b| mysql_temporal_text(&b, true))
            {
                return Ok(json!(s));
            }
        }
        "date" => {
            if let Ok(d) = row.try_get::<NaiveDate, _>(i) {
                return Ok(json!(d.to_string()));
            }
            if let Some(s) = row
                .try_get_unchecked::<Vec<u8>, _>(i)
                .ok()
                .and_then(|b| mysql_temporal_text(&b, false))
            {
                return Ok(json!(s));
            }
        }
        // TIME is a duration in MySQL: negative values and > 24h are legal.
        "time" => {
            if let Ok(v) = row.try_get::<MySqlTime, _>(i) {
                return Ok(json!(v.to_string()));
            }
            if let Ok(v) = row.try_get::<NaiveTime, _>(i) {
                return Ok(json!(v.to_string()));
            }
        }
        // JSON → canonical compact string (grid/cell viewer treat it as text).
        "json" => {
            if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
                return Ok(json!(v.to_string()));
            }
        }
        "geometry" => {
            if let Ok(b) = row.try_get_unchecked::<Vec<u8>, _>(i) {
                return Ok(bytes_to_json(&b));
            }
        }
        // The BINARY column flag is also set for `_bin` collations, so these
        // names cover both real binary data and case-sensitive text.
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            if let Ok(b) = row.try_get_unchecked::<Vec<u8>, _>(i) {
                return Ok(bytes_to_display(&b));
            }
        }
        _ => {}
    }

    // Text-ish: varchar / char / text / enum / set …
    if let Ok(s) = row.try_get::<String, _>(i) {
        return Ok(json!(s));
    }
    Err(t)
}

/// Literal form of a DATE / DATETIME / TIMESTAMP that chrono can't represent.
/// Text protocol: the bytes are the literal. Binary protocol: a length byte
/// followed by little-endian fields (length 0 = all-zero date).
fn mysql_temporal_text(b: &[u8], with_time: bool) -> Option<String> {
    let (&first, rest) = b.split_first()?;
    if first.is_ascii_digit() {
        return std::str::from_utf8(b).ok().map(str::to_owned);
    }
    if first == 0 {
        return Some(
            if with_time {
                "0000-00-00 00:00:00"
            } else {
                "0000-00-00"
            }
            .into(),
        );
    }
    if rest.len() < 4 {
        return None;
    }
    let year = u16::from_le_bytes([rest[0], rest[1]]);
    let mut s = format!("{year:04}-{:02}-{:02}", rest[2], rest[3]);
    if with_time {
        let (h, m, sec) = match rest.get(4..7) {
            Some(&[h, m, sec]) => (h, m, sec),
            _ => (0, 0, 0),
        };
        s.push_str(&format!(" {h:02}:{m:02}:{sec:02}"));
        if let Some(&[a, b2, c, d]) = rest.get(7..11) {
            let micros = u32::from_le_bytes([a, b2, c, d]);
            if micros > 0 {
                s.push_str(&format!(".{micros:06}"));
            }
        }
    }
    Some(s)
}

// ─── PostgreSQL ───────────────────────────────────────────────────

pub fn pg_value_to_json(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    pg_value(row, i).unwrap_or_else(|t| unsupported(&t))
}

/// Decode one PostgreSQL cell; `Err` carries the type name when no decoder fits.
fn pg_value(row: &sqlx::postgres::PgRow, i: usize) -> Result<serde_json::Value, String> {
    use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    use serde_json::json;
    use sqlx::postgres::types::{Oid, PgInterval, PgMoney, PgTimeTz};

    let Ok(raw) = row.try_get_raw(i) else {
        return Ok(serde_json::Value::Null);
    };
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }
    let type_info = raw.type_info().into_owned();
    let t = type_info.name().to_ascii_lowercase();
    // Simple query protocol (editor without params, export, transfer)
    // returns every value in PG's own text output format.
    let text = (raw.format() == PgValueFormat::Text)
        .then(|| raw.as_str().ok().map(str::to_owned))
        .flatten();

    match t.as_str() {
        "int2" => {
            if let Ok(n) = row.try_get::<i16, _>(i) {
                return Ok(json!(n));
            }
        }
        "int4" => {
            if let Ok(n) = row.try_get::<i32, _>(i) {
                return Ok(json!(n));
            }
        }
        "int8" => {
            if let Ok(n) = row.try_get::<i64, _>(i) {
                return Ok(json!(n.to_string()));
            }
        }
        "float4" => {
            if let Ok(n) = row.try_get::<f32, _>(i) {
                return Ok(json!(n));
            }
        }
        "float8" => {
            if let Ok(n) = row.try_get::<f64, _>(i) {
                return Ok(json!(n));
            }
        }
        // NUMERIC — exact text, no f64 rounding. BigDecimal keeps the exact
        // digits + scale; String alone can't decode PG's binary NUMERIC.
        "numeric" => {
            if let Ok(d) = row.try_get::<sqlx::types::BigDecimal, _>(i) {
                return Ok(json!(d.to_string()));
            }
        }
        "bool" => {
            if let Ok(b) = row.try_get::<bool, _>(i) {
                return Ok(json!(b));
            }
        }
        // JSON / JSONB → compact string.
        "json" | "jsonb" => {
            if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
                return Ok(json!(v.to_string()));
            }
        }
        "timestamptz" => {
            if let Ok(dt) = row.try_get::<DateTime<Utc>, _>(i) {
                return Ok(json!(dt.to_rfc3339()));
            }
        }
        "timestamp" => {
            if let Ok(dt) = row.try_get::<NaiveDateTime, _>(i) {
                return Ok(json!(dt.to_string()));
            }
        }
        "date" => {
            if let Ok(d) = row.try_get::<NaiveDate, _>(i) {
                return Ok(json!(d.to_string()));
            }
        }
        "time" => {
            if let Ok(v) = row.try_get::<NaiveTime, _>(i) {
                return Ok(json!(v.to_string()));
            }
        }
        "timetz" => {
            if let Ok(v) = row.try_get::<PgTimeTz<NaiveTime, FixedOffset>, _>(i) {
                return Ok(json!(format!("{}{}", v.time, v.offset)));
            }
        }
        "interval" => {
            if let Ok(v) = row.try_get::<PgInterval, _>(i) {
                return Ok(json!(pg_interval_text(&v)));
            }
        }
        "inet" | "cidr" => {
            if let Some(s) = text
                .clone()
                .or_else(|| raw.as_bytes().ok().and_then(pg_inet_text))
            {
                return Ok(json!(s));
            }
        }
        "macaddr" | "macaddr8" => {
            if let Some(s) = text.clone().or_else(|| {
                raw.as_bytes().ok().map(|b| {
                    b.iter()
                        .map(|x| format!("{x:02x}"))
                        .collect::<Vec<_>>()
                        .join(":")
                })
            }) {
                return Ok(json!(s));
            }
        }
        "money" => {
            if let Ok(m) = row.try_get::<PgMoney, _>(i) {
                return Ok(json!(m.to_bigdecimal(2).to_string()));
            }
        }
        "oid" => {
            if let Ok(o) = row.try_get::<Oid, _>(i) {
                return Ok(json!(o.0));
            }
        }
        "uuid" => {
            if let Ok(u) = row.try_get::<uuid::Uuid, _>(i) {
                return Ok(json!(u.to_string()));
            }
        }
        "bytea" => {
            if let Ok(b) = row.try_get::<Vec<u8>, _>(i) {
                return Ok(bytes_to_json(&b));
            }
        }
        _ => {}
    }

    // Arrays (`int[]`, `_text`, …) → PG array literal string.
    if t.ends_with("[]") || t.starts_with('_') {
        if let Some(lit) = pg_array_literal(row, i) {
            return Ok(json!(lit));
        }
    }

    // Enum labels are sent as their text in both wire formats. The simple
    // query protocol leaves custom type OIDs unresolved (name "?"), and
    // `kind()` panics on those — their values are text and handled below.
    if t != "?" && matches!(type_info.kind(), PgTypeKind::Enum(_)) {
        if let Ok(s) = row.try_get_unchecked::<String, _>(i) {
            return Ok(json!(s));
        }
    }

    // Text-ish (varchar / text / name / citext …).
    if let Ok(s) = row.try_get::<String, _>(i) {
        return Ok(json!(s));
    }

    // Any other type in text format is already in PG's canonical output.
    text.map(|s| json!(s)).ok_or(t)
}

/// PostgreSQL-style interval output, e.g. `1 year 2 mons 3 days 04:05:06.5`.
fn pg_interval_text(iv: &sqlx::postgres::types::PgInterval) -> String {
    fn unit(n: i64, name: &str) -> String {
        format!("{n} {name}{}", if n.abs() == 1 { "" } else { "s" })
    }
    let mut parts = vec![];
    let (years, months) = (iv.months / 12, iv.months % 12);
    if years != 0 {
        parts.push(unit(years.into(), "year"));
    }
    if months != 0 {
        parts.push(unit(months.into(), "mon"));
    }
    if iv.days != 0 {
        parts.push(unit(iv.days.into(), "day"));
    }
    if iv.microseconds != 0 || parts.is_empty() {
        let sign = if iv.microseconds < 0 { "-" } else { "" };
        let us = iv.microseconds.unsigned_abs();
        let (h, rem) = (us / 3_600_000_000, us % 3_600_000_000);
        let (m, rem) = (rem / 60_000_000, rem % 60_000_000);
        let (s, frac) = (rem / 1_000_000, rem % 1_000_000);
        let mut clock = format!("{sign}{h:02}:{m:02}:{s:02}");
        if frac > 0 {
            let digits = format!("{frac:06}");
            clock.push('.');
            clock.push_str(digits.trim_end_matches('0'));
        }
        parts.push(clock);
    }
    parts.join(" ")
}

/// Binary inet/cidr: family (2 = v4, 3 = v6), prefix bits, is_cidr, length, address.
fn pg_inet_text(b: &[u8]) -> Option<String> {
    let [family, bits, is_cidr, len, addr @ ..] = b else {
        return None;
    };
    let ip: std::net::IpAddr = match (*family, *len) {
        (2, 4) => <[u8; 4]>::try_from(addr).ok()?.into(),
        (3, 16) => <[u8; 16]>::try_from(addr).ok()?.into(),
        _ => return None,
    };
    let full = if ip.is_ipv4() { 32 } else { 128 };
    Some(if *is_cidr != 0 || *bits != full {
        format!("{ip}/{bits}")
    } else {
        ip.to_string()
    })
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

// ─── Export values ────────────────────────────────────────────────

/// Binary values carry a type tag in exports; text beginning with \x stays
/// text. Columns without a lossless representation abort the export.
pub fn mysql_export_value(
    row: &sqlx::mysql::MySqlRow,
    i: usize,
) -> Result<serde_json::Value, String> {
    let value = mysql_value(row, i).map_err(|t| export_error(row.column(i).name(), &t))?;
    let t = row.column(i).type_info().name().to_ascii_lowercase();
    if t.contains("blob") || t.contains("binary") || t == "geometry" {
        if let Some(s) = value.as_str().and_then(|s| s.strip_prefix("\\x")) {
            return Ok(serde_json::json!({"$lotdbBinary": s}));
        }
    }
    Ok(value)
}

pub fn pg_export_value(row: &sqlx::postgres::PgRow, i: usize) -> Result<serde_json::Value, String> {
    let value = pg_value(row, i).map_err(|t| export_error(row.column(i).name(), &t))?;
    if row
        .column(i)
        .type_info()
        .name()
        .eq_ignore_ascii_case("bytea")
    {
        if let Some(s) = value.as_str().and_then(|s| s.strip_prefix("\\x")) {
            return Ok(serde_json::json!({"$lotdbBinary": s}));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_values_are_never_truncated() {
        let small_out = bytes_to_json(&[0u8; 16]);
        assert!(small_out.as_str().unwrap().starts_with("\\x"));
        let big_out = bytes_to_json(&vec![0u8; 2049]);
        let s = big_out.as_str().unwrap();
        assert!(s.starts_with("\\x"));
        assert_eq!(s.len(), 2 + 2049 * 2);
    }

    #[test]
    fn readable_binary_flagged_text_is_shown_as_text() {
        assert_eq!(bytes_to_display(b"Abc"), "Abc");
        assert_eq!(bytes_to_display("中文\tok\n".as_bytes()), "中文\tok\n");
        assert_eq!(bytes_to_display(&[0x00, 0xff]), "\\x00ff");
        assert_eq!(bytes_to_display(&[0x01]), "\\x01");
        // Would be ambiguous with the hex form.
        assert_eq!(bytes_to_display(b"\\x41"), "\\x5c783431");
    }

    #[test]
    fn unsupported_mentions_type_name() {
        assert_eq!(
            unsupported("weirdtype").as_str().unwrap(),
            "(不支持的类型: weirdtype)"
        );
    }

    #[test]
    fn mysql_zero_and_text_dates() {
        assert_eq!(
            mysql_temporal_text(&[0], true).as_deref(),
            Some("0000-00-00 00:00:00")
        );
        assert_eq!(
            mysql_temporal_text(&[0], false).as_deref(),
            Some("0000-00-00")
        );
        // Binary DATE 2024-00-00 (month/day zero).
        assert_eq!(
            mysql_temporal_text(&[4, 0xe8, 0x07, 0, 0], false).as_deref(),
            Some("2024-00-00")
        );
        // Binary DATETIME with microseconds.
        let mut b = vec![11, 0xe8, 0x07, 10, 22, 13, 5, 9];
        b.extend_from_slice(&1500u32.to_le_bytes());
        assert_eq!(
            mysql_temporal_text(&b, true).as_deref(),
            Some("2024-10-22 13:05:09.001500")
        );
        assert_eq!(
            mysql_temporal_text(b"0000-00-00 00:00:00", true).as_deref(),
            Some("0000-00-00 00:00:00")
        );
    }

    #[test]
    fn pg_interval_formatting() {
        use sqlx::postgres::types::PgInterval;
        let iv = |months, days, microseconds| PgInterval {
            months,
            days,
            microseconds,
        };
        assert_eq!(pg_interval_text(&iv(0, 1, 0)), "1 day");
        assert_eq!(
            pg_interval_text(&iv(14, 3, 14_706_500_000)),
            "1 year 2 mons 3 days 04:05:06.5"
        );
        assert_eq!(pg_interval_text(&iv(0, 0, 0)), "00:00:00");
        assert_eq!(
            pg_interval_text(&iv(0, -2, -60_000_000)),
            "-2 days -00:01:00"
        );
    }

    #[test]
    fn pg_inet_formatting() {
        assert_eq!(
            pg_inet_text(&[2, 32, 0, 4, 10, 0, 0, 1]).as_deref(),
            Some("10.0.0.1")
        );
        assert_eq!(
            pg_inet_text(&[2, 24, 1, 4, 10, 0, 0, 0]).as_deref(),
            Some("10.0.0.0/24")
        );
        let mut v6 = vec![3, 64, 0, 16];
        v6.extend_from_slice(
            &"2001:db8::1"
                .parse::<std::net::Ipv6Addr>()
                .unwrap()
                .octets(),
        );
        assert_eq!(pg_inet_text(&v6).as_deref(), Some("2001:db8::1/64"));
        assert_eq!(pg_inet_text(&[9, 0]), None);
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
