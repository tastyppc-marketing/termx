use anyhow::{Context, Result};
use std::sync::Arc;
use termx_host::{config, paths, registry::Registry, server};

fn parse_data_dir_arg() -> Option<std::path::PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            return args.next().map(std::path::PathBuf::from);
        }
    }
    None
}

/// True if a live host already serves this data dir.
fn already_running(data_dir: &std::path::Path) -> Option<server::RuntimeInfo> {
    let text = std::fs::read_to_string(paths::runtime_file(data_dir)).ok()?;
    let info: server::RuntimeInfo = serde_json::from_str(&text).ok()?;
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], info.port)),
        std::time::Duration::from_millis(500),
    )
    .ok()?;
    Some(info)
}

fn main() -> Result<()> {
    let override_dir = parse_data_dir_arg();
    let data_dir = paths::resolve_data_dir(override_dir.as_deref())?;

    if let Some(info) = already_running(&data_dir) {
        println!(
            "termx-host already running (pid {}, port {})",
            info.pid, info.port
        );
        return Ok(());
    }

    let logs = paths::logs_dir(&data_dir);
    std::fs::create_dir_all(&logs).context("creating logs dir")?;
    let file_appender = tracing_appender::rolling::daily(&logs, "host.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .with_ansi(false),
        )
        .init();

    let cfg = config::load_or_create(&data_dir)?;
    tracing::info!("termx-host starting; data dir {}", data_dir.display());

    let runtime = tokio::runtime::Runtime::new().context("tokio runtime")?;
    runtime.block_on(async {
        let reg = Arc::new(Registry::new(data_dir.clone(), cfg));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(server::run(
            Arc::clone(&reg),
            data_dir.clone(),
            shutdown_tx,
            ready_tx,
        ));
        match ready_rx.await {
            Ok(info) => tracing::info!("listening on 127.0.0.1:{}", info.port),
            Err(_) => {
                // Surface the ACTUAL failure (bind error, runtime.json write...)
                // instead of a generic "failed before ready".
                let cause = match server_task.await {
                    Ok(Err(e)) => format!("{e:#}"),
                    Ok(Ok(())) => "server exited before signaling ready".to_string(),
                    Err(join_err) => format!("server task panicked: {join_err}"),
                };
                anyhow::bail!("server failed to start: {cause}");
            }
        }
        // Wait for shutdown-flag flip (server exits its accept loop itself).
        while !*shutdown_rx.borrow() {
            if shutdown_rx.changed().await.is_err() {
                break;
            }
        }
        let _ = server_task.await;
        tracing::info!("termx-host exiting cleanly");
        Ok(())
    })
}
