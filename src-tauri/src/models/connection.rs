use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DbType {
    #[serde(rename = "mysql")]
    MySQL,
    #[serde(rename = "postgres")]
    Postgres,
}

impl DbType {
    pub fn default_port(&self) -> u16 {
        match self {
            DbType::MySQL => 3306,
            DbType::Postgres => 5432,
        }
    }
}

impl std::fmt::Display for DbType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbType::MySQL => write!(f, "mysql"),
            DbType::Postgres => write!(f, "postgres"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key_fingerprint: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: String, // "password" | "key"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ca_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_cert_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// 只读模式：拦截 DML/DDL，保护生产库
    #[serde(default)]
    pub readonly: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl: Option<SslConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}
