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
