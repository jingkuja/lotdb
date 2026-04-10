use crate::db::ssh_tunnel::SshTunnel;
use crate::models::connection::{ConnectionConfig, DbType, SslConfig};
use dashmap::DashMap;
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode},
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
    MySqlPool, PgPool,
};
use std::{str::FromStr, time::Duration};

/// A live connection — pool plus an optional SSH tunnel keeping it alive.
pub struct ActiveConnection {
    pub pool: DbPool,
    /// Kept alive until this connection is closed.
    _tunnel: Option<SshTunnel>,
}

/// A live database connection pool — either MySQL or PostgreSQL.
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

    pub async fn close(&self) {
        match self {
            DbPool::MySQL(p) => p.close().await,
            DbPool::Postgres(p) => p.close().await,
        }
    }
}

/// Global manager — holds all active connections keyed by connection ID.
pub struct PoolManager {
    pub pools: DashMap<String, ActiveConnection>,
}

impl PoolManager {
    pub fn new() -> Self {
        Self {
            pools: DashMap::new(),
        }
    }

    /// Open a connection (with optional SSH tunnel + SSL) for the given config.
    pub async fn open(&self, config: &ConnectionConfig) -> Result<(), String> {
        self.close(&config.id).await;
        let conn = build_connection(config).await?;
        self.pools.insert(config.id.clone(), conn);
        Ok(())
    }

    /// Close and remove a connection by ID.
    pub async fn close(&self, id: &str) {
        if let Some((_, conn)) = self.pools.remove(id) {
            conn.pool.close().await;
            // _tunnel dropped here → SSH session closed
        }
    }

    /// Return IDs of all currently open connections.
    pub fn active_ids(&self) -> Vec<String> {
        self.pools.iter().map(|e| e.key().clone()).collect()
    }

    /// Check if a connection is currently open.
    pub fn is_open(&self, id: &str) -> bool {
        self.pools.contains_key(id)
    }

    /// Run a closure with a MySQL pool reference.
    pub fn with_mysql<F, T>(&self, id: &str, f: F) -> Result<T, String>
    where
        F: FnOnce(&MySqlPool) -> T,
    {
        let entry = self
            .pools
            .get(id)
            .ok_or_else(|| format!("连接 {id} 未打开"))?;
        match &entry.pool {
            DbPool::MySQL(p) => Ok(f(p)),
            DbPool::Postgres(_) => Err("该连接是 PostgreSQL，不是 MySQL".into()),
        }
    }

    /// Run a closure with a Postgres pool reference.
    pub fn with_postgres<F, T>(&self, id: &str, f: F) -> Result<T, String>
    where
        F: FnOnce(&PgPool) -> T,
    {
        let entry = self
            .pools
            .get(id)
            .ok_or_else(|| format!("连接 {id} 未打开"))?;
        match &entry.pool {
            DbPool::Postgres(p) => Ok(f(p)),
            DbPool::MySQL(_) => Err("该连接是 MySQL，不是 PostgreSQL".into()),
        }
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

    let pool = match &config.db_type {
        DbType::MySQL => {
            let opts = build_mysql_opts(&config.user, &config.password, &host, port, config)
                .map_err(|e| format!("MySQL 连接配置错误: {e}"))?;
            let p = MySqlPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(timeout)
                .connect_with(opts)
                .await
                .map_err(|e| format!("MySQL 连接失败: {e}"))?;
            DbPool::MySQL(p)
        }
        DbType::Postgres => {
            let opts = build_pg_opts(&config.user, &config.password, &host, port, config)
                .map_err(|e| format!("PostgreSQL 连接配置错误: {e}"))?;
            let p = PgPoolOptions::new()
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
        _tunnel: tunnel,
    })
}

fn build_mysql_opts(
    user: &str,
    password: &str,
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<MySqlConnectOptions, String> {
    let url = format!(
        "mysql://{}:{}@{}:{}/{}",
        user,
        password,
        host,
        port,
        config.database.as_deref().unwrap_or(""),
    );
    let mut opts = MySqlConnectOptions::from_str(&url).map_err(|e| format!("URL 解析失败: {e}"))?;

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

    Ok(opts)
}

fn build_pg_opts(
    user: &str,
    password: &str,
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<PgConnectOptions, String> {
    let url = format!(
        "postgres://{}:{}@{}:{}/{}",
        user,
        password,
        host,
        port,
        config.database.as_deref().unwrap_or("postgres"),
    );
    let mut opts = PgConnectOptions::from_str(&url).map_err(|e| format!("URL 解析失败: {e}"))?;

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

    Ok(opts)
}

/// Return the SSL config only when it's enabled.
fn ssl_if_enabled(ssl: &Option<SslConfig>) -> Option<&SslConfig> {
    ssl.as_ref().filter(|s| s.enabled)
}
