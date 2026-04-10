use crate::models::connection::SshConfig;
use russh::{
    client::{self, Handle},
    keys::PrivateKeyWithHashAlg,
    ChannelMsg,
};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A running SSH tunnel. Dropping it closes the SSH session and stops port forwarding.
pub struct SshTunnel {
    /// The local port to connect through instead of the real DB host/port.
    pub local_port: u16,
    /// Keep the session alive (dropped when tunnel is dropped).
    _session: Arc<Handle<TunnelHandler>>,
    /// Abort the listener background task on drop.
    _guard: tokio::task::AbortHandle,
}

impl SshTunnel {
    /// Establish an SSH tunnel: local_port → ssh_host → db_host:db_port.
    pub async fn open(ssh: &SshConfig, db_host: &str, db_port: u16) -> Result<Self, String> {
        // 1. Connect to SSH server
        let config = Arc::new(client::Config::default());
        let addr = format!("{}:{}", ssh.host, ssh.port);
        let mut session = client::connect(config, addr.as_str(), TunnelHandler)
            .await
            .map_err(|e| format!("SSH 连接失败: {e}"))?;

        // 2. Authenticate
        let authed = match ssh.auth_type.as_str() {
            "key" => {
                let key_path = ssh
                    .private_key_path
                    .as_deref()
                    .ok_or("SSH 密钥路径未设置")?;
                let key_bytes =
                    std::fs::read(key_path).map_err(|e| format!("读取 SSH 密钥失败: {e}"))?;
                let private_key = russh::keys::PrivateKey::from_openssh(&key_bytes)
                    .map_err(|e| format!("解析 SSH 密钥失败: {e}"))?;
                let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(private_key), None);
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

        // 5. Spawn the accept loop
        let task = tokio::spawn(async move {
            loop {
                let (tcp, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let db_host = db_host.clone();
                let session = session_bg.clone();
                tokio::spawn(async move {
                    let _ = forward_connection(session, tcp, &db_host, db_port).await;
                });
            }
        });

        Ok(SshTunnel {
            local_port,
            _session: session,
            _guard: task.abort_handle(),
        })
    }
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

/// Minimal SSH client handler — accepts all server keys.
/// TODO: verify against known_hosts in a future iteration.
pub struct TunnelHandler;

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}
