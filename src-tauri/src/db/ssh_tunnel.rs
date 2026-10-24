use crate::models::connection::SshConfig;
use russh::{
    client::{self, Handle},
    keys::{PrivateKey, PrivateKeyWithHashAlg},
    ChannelMsg,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// A running SSH tunnel. Dropping it closes the SSH session and stops port forwarding.
pub struct SshTunnel {
    /// The local port to connect through instead of the real DB host/port.
    pub local_port: u16,
    session: Arc<Handle<TunnelHandler>>,
    /// The accept loop. It owns the listener and every forwarding task, so
    /// aborting it frees the local port and all channel clones of `session`.
    accept_loop: tokio::task::AbortHandle,
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Dropping an AbortHandle does not stop the task; abort explicitly,
        // otherwise the listener stays open on 127.0.0.1 for any local process.
        self.accept_loop.abort();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let session = self.session.clone();
            rt.spawn(async move {
                let _ = session
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            });
        }
    }
}

impl SshTunnel {
    /// Establish an SSH tunnel: local_port → ssh_host → db_host:db_port.
    pub async fn open(ssh: &SshConfig, db_host: &str, db_port: u16) -> Result<Self, String> {
        // 1. Connect to SSH server. Keepalives detect a dead link (laptop
        // sleep, NAT timeout) instead of leaving queries hanging forever.
        let config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let addr = format!("{}:{}", ssh.host, ssh.port);
        let connect = client::connect(
            config,
            addr.as_str(),
            TunnelHandler {
                host: ssh.host.clone(),
                port: ssh.port,
                fingerprint: ssh.host_key_fingerprint.clone(),
            },
        );
        let mut session = tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| format!("SSH 连接超时（{}s）", CONNECT_TIMEOUT.as_secs()))?
            .map_err(|e| format!("SSH 连接失败: {e}"))?;

        // 2. Authenticate
        let authed = match ssh.auth_type.as_str() {
            "key" => {
                let key_path = ssh
                    .private_key_path
                    .as_deref()
                    .ok_or("SSH 密钥路径未设置")?;
                let private_key = load_private_key(key_path, ssh.passphrase.as_deref())?;
                // RSA keys need an explicit SHA-2 signature algorithm: servers
                // with OpenSSH >= 8.8 reject the legacy ssh-rsa (SHA-1) default.
                let hash_alg = if private_key.algorithm().is_rsa() {
                    session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|e| format!("SSH 协商失败: {e}"))?
                        .flatten()
                } else {
                    None
                };
                let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(private_key), hash_alg);
                session
                    .authenticate_publickey(&ssh.user, key_with_alg)
                    .await
                    .map_err(|e| format!("SSH 公钥认证失败: {e}"))?
            }
            _ => {
                let password = ssh.password.as_deref().unwrap_or("");
                session
                    .authenticate_password(&ssh.user, password)
                    .await
                    .map_err(|e| format!("SSH 密码认证失败: {e}"))?
            }
        };

        if !matches!(authed, russh::client::AuthResult::Success) {
            return Err("SSH 认证失败，请检查用户名/密码".into());
        }

        // 3. Bind a random local port
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("本地端口绑定失败: {e}"))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("获取本地端口失败: {e}"))?
            .port();

        // 4. Wrap session in Arc for sharing across forwarding tasks
        let session = Arc::new(session);
        let session_bg = session.clone();
        let db_host = db_host.to_string();

        // 5. Spawn the accept loop. Forwarders live in a JoinSet owned by the
        // loop, so they are aborted together with it.
        let task = tokio::spawn(async move {
            let mut forwarders = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((tcp, _)) = accepted else { break };
                        let db_host = db_host.clone();
                        let session = session_bg.clone();
                        forwarders.spawn(async move {
                            let _ = forward_connection(session, tcp, &db_host, db_port).await;
                        });
                    }
                    // Reap finished forwarders so the set does not grow.
                    Some(_) = forwarders.join_next(), if !forwarders.is_empty() => {}
                }
            }
        });

        Ok(SshTunnel {
            local_port,
            session,
            accept_loop: task.abort_handle(),
        })
    }
}

fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 SSH 密钥失败: {e}"))?;
    let passphrase = passphrase.filter(|p| !p.is_empty());
    russh::keys::decode_secret_key(&text, passphrase).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => "SSH 私钥已加密，请填写私钥口令".to_string(),
        e if passphrase.is_some() => format!("解析 SSH 密钥失败（口令可能不正确）: {e}"),
        e => format!("解析 SSH 密钥失败: {e}"),
    })
}

/// Forward a single TCP connection through an SSH direct-tcpip channel.
async fn forward_connection(
    session: Arc<Handle<TunnelHandler>>,
    mut local: TcpStream,
    remote_host: &str,
    remote_port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut channel = session
        .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
        .await?;

    let (mut lr, mut lw) = local.split();
    let mut buf = vec![0u8; 16384];

    loop {
        tokio::select! {
            // Local → SSH channel
            n = lr.read(&mut buf) => {
                match n? {
                    0 => break,
                    n => channel.data(&buf[..n]).await?,
                }
            }
            // SSH channel → local
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        lw.write_all(&data).await?;
                    }
                    Some(ChannelMsg::Eof) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

/// Host authentication happens before database/SSH credentials are sent.
pub struct TunnelHandler {
    host: String,
    port: u16,
    fingerprint: Option<String>,
}

impl client::Handler for TunnelHandler {
    type Error = anyhow::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let actual = key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        if let Some(expected) = self.fingerprint.as_deref().filter(|s| !s.trim().is_empty()) {
            if expected.trim() == actual {
                return Ok(true);
            }
            anyhow::bail!("SSH 主机指纹不匹配，已拒绝连接。服务器指纹：{actual}");
        }
        match russh::keys::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => Ok(true),
            Ok(false) => anyhow::bail!("未知 SSH 主机，已拒绝连接。请先校验并记录 known_hosts，或在连接设置中填写已确认的指纹：{actual}"),
            Err(error) => anyhow::bail!("SSH 主机密钥校验失败：{error}。服务器指纹：{actual}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::client::Handler;
    #[tokio::test]
    async fn pinned_host_key_must_match() {
        let key = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap();
        let fingerprint = key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let mut handler = TunnelHandler {
            host: "localhost".into(),
            port: 22,
            fingerprint: Some(fingerprint),
        };
        assert!(handler.check_server_key(&key).await.unwrap());
        handler.fingerprint = Some("SHA256:unexpected".into());
        assert!(handler.check_server_key(&key).await.is_err());
    }
}
