//! SQL text that differs between MySQL and PostgreSQL: identifier quoting,
//! table references, literals and placeholders. Commands build statements
//! through a [`Dialect`] instead of matching on the pool for each string.
//! Catalog queries stay per database: they share no SQL to abstract.

use crate::utils::sql::{quote_ident_mysql, quote_ident_pg, string_literal};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    MySQL,
    Postgres,
}

impl Dialect {
    pub fn is_mysql(self) -> bool {
        self == Dialect::MySQL
    }

    pub fn quote_ident(self, ident: &str) -> String {
        match self {
            Dialect::MySQL => quote_ident_mysql(ident),
            Dialect::Postgres => quote_ident_pg(ident),
        }
    }

    /// `a`.`b` / "a"."b".
    pub fn qualified(self, a: &str, b: &str) -> String {
        format!("{}.{}", self.quote_ident(a), self.quote_ident(b))
    }

    /// A table in the user's selection. MySQL qualifies it with the
    /// database; PostgreSQL with the schema (the pool already points at the
    /// database), defaulting to `public`.
    pub fn table_ref(self, database: &str, schema: Option<&str>, table: &str) -> String {
        match self {
            Dialect::MySQL => self.qualified(database, table),
            Dialect::Postgres => self.qualified(schema.unwrap_or("public"), table),
        }
    }

    /// Quoted, comma-separated column names; `*` when none are given.
    pub fn column_list(self, columns: &[String]) -> String {
        if columns.is_empty() {
            return "*".into();
        }
        columns
            .iter()
            .map(|c| self.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `?` for MySQL, `$n` (1-based) for PostgreSQL.
    pub fn placeholder(self, n: usize) -> String {
        match self {
            Dialect::MySQL => "?".into(),
            Dialect::Postgres => format!("${n}"),
        }
    }

    pub fn string_literal(self, s: &str) -> String {
        string_literal(s, self.is_mysql())
    }

    /// Hex-encoded bytes as a literal.
    pub fn binary_literal(self, hex: &str) -> String {
        match self {
            Dialect::MySQL => format!("X'{hex}'"),
            Dialect::Postgres => format!("decode('{hex}', 'hex')"),
        }
    }

    /// Empties a table inside a transaction. MySQL's TRUNCATE commits
    /// implicitly, so it has to be DELETE there; PostgreSQL's is transactional.
    pub fn clear_table_sql(self, table_ref: &str) -> String {
        match self {
            Dialect::MySQL => format!("DELETE FROM {table_ref}"),
            Dialect::Postgres => format!("TRUNCATE TABLE {table_ref}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_dialect_specific_text() {
        let (m, p) = (Dialect::MySQL, Dialect::Postgres);
        assert_eq!(m.table_ref("db", Some("ignored"), "t`1"), "`db`.`t``1`");
        assert_eq!(p.table_ref("db", None, "T\"1"), "\"public\".\"T\"\"1\"");
        assert_eq!(p.table_ref("db", Some("s"), "t"), "\"s\".\"t\"");
        assert_eq!(m.column_list(&[]), "*");
        assert_eq!(p.column_list(&["a".into(), "B".into()]), "\"a\", \"B\"");
        assert_eq!(
            (m.placeholder(3), p.placeholder(3)),
            ("?".into(), "$3".into())
        );
        assert_eq!(m.binary_literal("00ff"), "X'00ff'");
        assert_eq!(p.binary_literal("00ff"), "decode('00ff', 'hex')");
        assert_eq!(m.clear_table_sql("`t`"), "DELETE FROM `t`");
    }
}
