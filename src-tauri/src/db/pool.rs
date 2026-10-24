use crate::db::dialect::Dialect;
use crate::db::ssh_tunnel::SshTunnel;
use crate::error::AppError;
use crate::models::connection::{ConnectionConfig, DbType, SslConfig};
use dashmap::DashMap;
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode},
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
    Column, Executor, MySqlPool, PgPool,
};
use std::time::Duration;

/// A live connection — pool plus an optional SSH tunnel keeping it alive.
pub struct ActiveConnection {
    pub pool: DbPool,
    /// Effective DB host for external tools (mysqldump / pg_dump).
    /// For SSH connections this is 127.0.0.1; otherwise the real host.
    pub effective_host: String,
    /// Effective DB port for external tools.
    /// For SSH connections this is the local tunnel port.
    pub effective_port: u16,
    /// Kept alive until this connection is closed.
    _tunnel: Option<SshTunnel>,
}

/// A live database connection pool — either MySQL or PostgreSQL.
#[derive(Clone)]
pub enum DbPool {
    MySQL(MySqlPool),
    Postgres(PgPool),
}

impl DbPool {
    pub fn db_type(&self) -> &'static str {
        match self {
            DbPool::MySQL(_) => "mysql",
            DbPool::Postgres(_) => "postgres",
        }
    }

    pub fn dialect(&self) -> Dialect {
        match self {
            DbPool::MySQL(_) => Dialect::MySQL,
            DbPool::Postgres(_) => Dialect::Postgres,
        }
    }

    pub async fn close(&self) {
        match self {
            DbPool::MySQL(p) => p.close().await,
            DbPool::Postgres(p) => p.close().await,
        }
    }

    /// Run one statement without arguments, returning rows affected. A bare
    /// `&str` goes over the text protocol, so DDL that cannot be prepared
    /// (MySQL rejects some) works too.
    pub async fn execute(&self, sql: &str) -> Result<u64, sqlx::Error> {
        Ok(match self {
            DbPool::MySQL(p) => Executor::execute(p, sql).await?.rows_affected(),
            DbPool::Postgres(p) => Executor::execute(p, sql).await?.rows_affected(),
        })
    }

    /// Result column names of `sql`, without running it.
    pub async fn describe_columns(&self, sql: &str) -> Result<Vec<String>, sqlx::Error> {
        fn names<C: Column>(columns: &[C]) -> Vec<String> {
            columns.iter().map(|c| c.name().to_owned()).collect()
        }
        Ok(match self {
            DbPool::MySQL(p) => names(Executor::describe(p, sql).await?.columns()),
            DbPool::Postgres(p) => names(Executor::describe(p, sql).await?.columns()),
        })
    }
}

/// Global manager — holds all active connections keyed by connection ID.
///
/// The maps are DashMaps: a guard returned by `get` locks its shard, so no
/// guard may live across an `.await` (a slow query would block disconnect,
/// reconnect and every other lookup in that shard). Callers use the
/// accessors below, which clone what they need and drop the guard.
pub struct PoolManager {
    pub pools: DashMap<String, ActiveConnection>,
    /// Cached per-database sub-pools for PG cross-database access.
    /// Key: "{connection_id}::{database}"
    pg_sub_pools: DashMap<String, PgPool>,
    /// Original configs (user/password/ssl) for building PG sub-pools.
    configs: DashMap<String, ConnectionConfig>,
}

fn not_open(id: &str) -> AppError {
    AppError::connection(format!("连接 {id} 未打开，请重新连接"))
}

impl PoolManager {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
            pg_sub_pools: DashMap::new(),
            configs: DashMap::new(),
        }
    }

    /// Open a connection (with optional SSH tunnel + SSL) for the given config.
    pub async fn open(&self, config: &ConnectionConfig) -> Result<(), AppError> {
        self.close(&config.id).await;
        let conn = build_connection(config)
            .await
            .map_err(AppError::connection)?;
        self.pools.insert(config.id.clone(), conn);
        self.configs.insert(config.id.clone(), config.clone());
        Ok(())
    }

    /// Close and remove a connection by ID.
    pub async fn close(&self, id: &str) {
        if let Some((_, conn)) = self.pools.remove(id) {
            conn.pool.close().await;
            // _tunnel dropped here → SSH session closed
        }
        self.configs.remove(id);
        // Drop all cached sub-pools for this connection
        let prefix = format!("{id}::");
        self.pg_sub_pools.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Close the cached PG sub-pool for `database`, e.g. before dropping it.
    pub async fn close_database_pool(&self, id: &str, database: &str) {
        if let Some((_, pool)) = self.pg_sub_pools.remove(&format!("{id}::{database}")) {
            pool.close().await;
        }
    }

    /// The connection's main pool (a cheap clone).
    pub fn pool(&self, id: &str) -> Result<DbPool, AppError> {
        self.pools
            .get(id)
            .map(|entry| entry.pool.clone())
            .ok_or_else(|| not_open(id))
    }

    pub fn dialect(&self, id: &str) -> Result<Dialect, AppError> {
        self.pools
            .get(id)
            .map(|entry| entry.pool.dialect())
            .ok_or_else(|| not_open(id))
    }

    /// The pool that runs statements in `database`. MySQL: the main pool —
    /// statements qualify the database. PostgreSQL: the sub-pool connected to
    /// that database, since a PG session cannot reach another database.
    pub async fn pool_for(&self, id: &str, database: &str) -> Result<DbPool, AppError> {
        match self.pool(id)? {
            DbPool::MySQL(p) => Ok(DbPool::MySQL(p)),
            DbPool::Postgres(_) => Ok(DbPool::Postgres(
                self.pg_pool_for_database(id, database).await?,
            )),
        }
    }

    /// For PostgreSQL-only features (`feature` names it in the error).
    pub async fn pg_pool(
        &self,
        id: &str,
        database: &str,
        feature: &str,
    ) -> Result<PgPool, AppError> {
        match self.dialect(id)? {
            Dialect::Postgres => self.pg_pool_for_database(id, database).await,
            Dialect::MySQL => Err(AppError::sql(format!("{feature}仅支持 PostgreSQL"))),
        }
    }

    /// For PostgreSQL: return (or lazily build) a PgPool connected to `database`.
    /// Caches sub-pools so repeated calls are cheap.
    pub async fn pg_pool_for_database(&self, id: &str, database: &str) -> Result<PgPool, AppError> {
        let (main_pool, host, port) = {
            let entry = self.pools.get(id).ok_or_else(|| not_open(id))?;
            match &entry.pool {
                DbPool::Postgres(p) => (
                    p.clone(),
                    entry.effective_host.clone(),
                    entry.effective_port,
                ),
                DbPool::MySQL(_) => {
                    return Err(AppError::sql("该连接是 MySQL，无法切换 PG 数据库"))
                }
            }
        };

        let sub_key = format!("{id}::{database}");

        // Return cached sub-pool if already built
        if let Some(p) = self.pg_sub_pools.get(&sub_key).map(|p| p.clone()) {
            return Ok(p);
        }

        // Check whether main pool is already connected to this database
        // by running a quick query — avoids building a new pool for the default db
        let current_db: String = sqlx::query_scalar("SELECT current_database()::text")
            .fetch_one(&main_pool)
            .await
            .map_err(|e| AppError::from_sqlx("查询当前数据库失败", e))?;

        if current_db == database {
            return Ok(main_pool);
        }

        // Build a new pool for the requested database
        let config = self
            .configs
            .get(id)
            .map(|c| c.clone())
            .ok_or_else(|| not_open(id))?;

        let opts =
            build_pg_opts(&config.user, &config.password, &host, port, &config).database(database);

        let readonly = config.readonly;
        let pool = PgPoolOptions::new()
            .after_connect(move |conn, _| {
                Box::pin(async move {
                    if readonly {
                        sqlx::query("SET default_transaction_read_only = on")
                            .execute(conn)
                            .await?;
                    }
                    Ok(())
                })
            })
            .max_connections(3)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts)
            .await
            .map_err(|e| AppError::from_sqlx(&format!("连接数据库 {database} 失败"), e))?;

        // Two callers may race to build the same sub-pool; keep the first.
        let pool = self.pg_sub_pools.entry(sub_key).or_insert(pool).clone();
        Ok(pool)
    }

    /// Return IDs of all currently open connections.
    pub fn active_ids(&self) -> Vec<String> {
        self.pools.iter().map(|e| e.key().clone()).collect()
    }

    /// Check if a connection is currently open.
    pub fn is_open(&self, id: &str) -> bool {
        self.pools.contains_key(id)
    }

    pub fn ensure_writable(&self, id: &str) -> Result<(), AppError> {
        if !self.is_open(id) {
            return Err(not_open(id));
        }
        if self.is_readonly(id) {
            return Err(AppError::sql("该连接为只读模式，已拦截数据或结构变更"));
        }
        Ok(())
    }

    /// (user, password) of an open connection, as loaded when it was opened.
    pub fn credentials(&self, id: &str) -> Option<(String, String)> {
        self.configs
            .get(id)
            .map(|c| (c.user.clone(), c.password.clone()))
    }

    /// Host and port external tools must use (the tunnel's local end for SSH).
    pub fn effective_address(&self, id: &str) -> Result<(String, u16), AppError> {
        self.pools
            .get(id)
            .map(|e| (e.effective_host.clone(), e.effective_port))
            .ok_or_else(|| not_open(id))
    }

    /// Whether this connection blocks DML/DDL (readonly mode).
    pub fn is_readonly(&self, id: &str) -> bool {
        self.configs.get(id).map(|c| c.readonly).unwrap_or(false)
    }
}

impl Default for PoolManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Public entry point used by `test_connection`.
pub async fn build_connection_pub(config: &ConnectionConfig) -> Result<ActiveConnection, String> {
    build_connection(config).await
}

async fn build_connection(config: &ConnectionConfig) -> Result<ActiveConnection, String> {
    let timeout = Duration::from_secs(10);

    // If SSH config present, open tunnel first and connect through it.
    let (host, port, tunnel) = if let Some(ssh) = &config.ssh {
        let t = SshTunnel::open(ssh, &config.host, config.port).await?;
        let local_port = t.local_port;
        ("127.0.0.1".to_string(), local_port, Some(t))
    } else {
        (config.host.clone(), config.port, None)
    };

    let readonly = config.readonly;
    let pool = match &config.db_type {
        DbType::MySQL => {
            let opts = build_mysql_opts(&config.user, &config.password, &host, port, config);
            let p = MySqlPoolOptions::new()
                .after_connect(move |conn, _| {
                    Box::pin(async move {
                        if readonly {
                            sqlx::query("SET SESSION TRANSACTION READ ONLY")
                                .execute(conn)
                                .await?;
                        }
                        Ok(())
                    })
                })
                .max_connections(5)
                .acquire_timeout(timeout)
                .connect_with(opts)
                .await
                .map_err(|e| format!("MySQL 连接失败: {e}"))?;
            DbPool::MySQL(p)
        }
        DbType::Postgres => {
            let opts = build_pg_opts(&config.user, &config.password, &host, port, config);
            let p = PgPoolOptions::new()
                .after_connect(move |conn, _| {
                    Box::pin(async move {
                        if readonly {
                            sqlx::query("SET default_transaction_read_only = on")
                                .execute(conn)
                                .await?;
                        }
                        Ok(())
                    })
                })
                .max_connections(5)
                .acquire_timeout(timeout)
                .connect_with(opts)
                .await
                .map_err(|e| format!("PostgreSQL 连接失败: {e}"))?;
            DbPool::Postgres(p)
        }
    };

    Ok(ActiveConnection {
        pool,
        effective_host: host,
        effective_port: port,
        _tunnel: tunnel,
    })
}

/// MySQL options built field by field: credentials are never pasted into a
/// URL, so passwords containing `#`, `/`, `?`, `%` or `@` work verbatim.
///
/// sqlx's MySQL defaults are tuned for applications, not a general client:
/// they force `time_zone='+00:00'` (NOW()/TIMESTAMP shift away from the
/// server zone) and add `PIPES_AS_CONCAT` to sql_mode (`a || b` stops meaning
/// OR). Both are turned off so sessions behave like the mysql CLI.
fn build_mysql_opts(
    user: &str,
    password: &str,
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> MySqlConnectOptions {
    let mut opts = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .timezone(None)
        .pipes_as_concat(false);
    if !password.is_empty() {
        opts = opts.password(password);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }

    if let Some(ssl) = ssl_if_enabled(&config.ssl) {
        opts = opts.ssl_mode(if ssl.ca_path.is_some() || ssl.client_cert_path.is_some() {
            MySqlSslMode::VerifyCa
        } else {
            MySqlSslMode::Required
        });

        if let Some(ca) = &ssl.ca_path {
            opts = opts.ssl_ca(ca);
        }
        if let Some(cert) = &ssl.client_cert_path {
            opts = opts.ssl_client_cert(cert);
        }
        if let Some(key) = &ssl.client_key_path {
            opts = opts.ssl_client_key(key);
        }
    } else {
        opts = opts.ssl_mode(MySqlSslMode::Preferred);
    }

    opts
}

/// PostgreSQL options built field by field (see [`build_mysql_opts`]).
fn build_pg_opts(
    user: &str,
    password: &str,
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> PgConnectOptions {
    let mut opts = PgConnectOptions::new_without_pgpass()
        .host(host)
        .port(port)
        .username(user)
        .database(
            config
                .database
                .as_deref()
                .filter(|d| !d.is_empty())
                .unwrap_or("postgres"),
        );
    if !password.is_empty() {
        opts = opts.password(password);
    }

    if let Some(ssl) = ssl_if_enabled(&config.ssl) {
        opts = opts.ssl_mode(if ssl.ca_path.is_some() {
            PgSslMode::VerifyCa
        } else {
            PgSslMode::Require
        });

        if let Some(ca) = &ssl.ca_path {
            opts = opts.ssl_root_cert(ca);
        }
        if let Some(cert) = &ssl.client_cert_path {
            opts = opts.ssl_client_cert(cert);
        }
        if let Some(key) = &ssl.client_key_path {
            opts = opts.ssl_client_key(key);
        }
    }

    opts
}

/// Return the SSL config only when it's enabled.
fn ssl_if_enabled(ssl: &Option<SslConfig>) -> Option<&SslConfig> {
    ssl.as_ref().filter(|s| s.enabled)
}
