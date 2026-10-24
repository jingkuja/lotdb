//! Categorized application error.
//!
//! Every Tauri command returns `Result<_, AppError>`; the error serializes to
//! `{ code: "connection" | "sql" | "io", message }` so the frontend can offer
//! one-click reconnect for connection-class failures instead of showing a raw
//! driver message.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// Connection refused / dropped / pool failure — reconnect may fix it.
    Connection,
    /// The server rejected the statement (syntax, permissions, constraints).
    Sql,
    /// Local IO (files, keychain, tunnels).
    Io,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn connection(msg: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Connection,
            message: msg.into(),
        }
    }

    pub fn sql(msg: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Sql,
            message: msg.into(),
        }
    }

    pub fn io(msg: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Io,
            message: msg.into(),
        }
    }

    /// Wrap a sqlx error with a context prefix, keeping its category.
    pub fn from_sqlx(prefix: &str, e: sqlx::Error) -> Self {
        Self {
            code: classify_sqlx(&e),
            message: format!("{prefix}: {e}"),
        }
    }
}

/// Errors from LotDB's own SQLite store are local IO, never "reconnect".
pub fn local_store(prefix: &str) -> impl FnOnce(sqlx::Error) -> AppError + '_ {
    move |e| AppError::io(format!("{prefix}: {e}"))
}

/// Plain messages (validation, "not supported") are statement-level errors.
impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::sql(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::sql(message)
    }
}

/// `.ctx("查询失败")` turns any error into an [`AppError`] with the prefix,
/// classified by its source: sqlx errors keep their category (see
/// [`classify_sqlx`]); file and format errors are local IO.
pub trait ResultExt<T> {
    fn ctx(self, prefix: &str) -> Result<T, AppError>;
}

impl<T> ResultExt<T> for Result<T, sqlx::Error> {
    fn ctx(self, prefix: &str) -> Result<T, AppError> {
        self.map_err(|e| AppError::from_sqlx(prefix, e))
    }
}

macro_rules! io_context {
    ($($ty:ty),*) => {$(
        impl<T> ResultExt<T> for Result<T, $ty> {
            fn ctx(self, prefix: &str) -> Result<T, AppError> {
                self.map_err(|e| AppError::io(format!("{prefix}: {e}")))
            }
        }
    )*};
}

io_context!(
    std::io::Error,
    serde_json::Error,
    csv::Error,
    rust_xlsxwriter::XlsxError,
    tokio::task::JoinError
);

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

/// Classify a sqlx error. Connection-lost errors (socket failures, pool
/// timeouts, MySQL "server has gone away" 2006/2013, PG terminated
/// connections) become ErrorCode::Connection so the UI can offer reconnect.
pub fn classify_sqlx(e: &sqlx::Error) -> ErrorCode {
    use sqlx::Error as E;

    match e {
        E::Io(_) | E::Tls(_) | E::PoolTimedOut | E::PoolClosed | E::WorkerCrashed => {
            ErrorCode::Connection
        }
        E::Database(db) => {
            // MySQL client error codes arrive inside the message for
            // connection losses (2006 CR_SERVER_GONE / 2013 CR_SERVER_LOST
            // / "server has gone away"); PG reports terminated connections
            // as "terminating connection due to administrator command" or
            // "connection closed unexpectedly" via Io.
            let msg = db.message().to_lowercase();
            let is_conn = msg.contains("server has gone away")
                || msg.contains("server lost")
                || msg.contains("connection refused")
                || msg.contains("connection closed")
                || msg.contains("connection reset")
                || msg.contains("broken pipe")
                || msg.contains("terminating connection");
            if is_conn {
                ErrorCode::Connection
            } else {
                ErrorCode::Sql
            }
        }
        _ => ErrorCode::Sql,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_are_connection_class() {
        let e = sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        ));
        assert_eq!(classify_sqlx(&e), ErrorCode::Connection);
        assert_eq!(
            AppError::from_sqlx("查询失败", e).code,
            ErrorCode::Connection
        );
    }

    #[test]
    fn pool_timeout_is_connection_class() {
        assert_eq!(
            classify_sqlx(&sqlx::Error::PoolTimedOut),
            ErrorCode::Connection
        );
    }

    #[test]
    fn display_keeps_message() {
        let e = AppError::connection("连接已断开");
        assert_eq!(e.to_string(), "连接已断开");
        assert_eq!(e.code, ErrorCode::Connection);
    }
}
