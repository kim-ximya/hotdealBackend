use hotdeal_collector::{
    core::{Core, Event},
    model::Config,
    Result,
};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("서버 실행 실패: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let root = std::env::current_dir().map_err(|error| error.to_string())?;
    if root.join(".env").is_file() {
        dotenvy::from_path(root.join(".env")).map_err(|error| error.to_string())?;
    }
    let manager = manager_path(&root)?;
    let config = Config::load(
        &root,
        root.join(".local/desktop"),
        root.join(".local/selenium-server"),
        manager,
        true,
    )?;
    let core = Core::new(config);
    let mut events = core.subscribe();
    let worker = core.clone();
    let logger = tokio::spawn(async move {
        let mut last = 0;
        loop {
            for row in worker.logs()["logs"].as_array().into_iter().flatten() {
                if let Some(id) = row["id"].as_u64().filter(|id| *id > last) {
                    last = id;
                    println!(
                        "[{}] {}",
                        row["at"].as_str().unwrap_or(""),
                        row["message"].as_str().unwrap_or("")
                    );
                }
            }
            loop {
                match events.recv().await {
                    Ok(Event::Logs) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        break
                    }
                    Err(_) => return,
                    _ => {}
                }
            }
        }
    });
    core.start(false).await?;
    let signal = tokio::signal::ctrl_c().await;
    let result = core.stop().await;
    logger.abort();
    signal.map_err(|error| error.to_string())?;
    result.map(|_| ())
}

fn manager_path(root: &std::path::Path) -> Result<PathBuf> {
    let binary = if cfg!(windows) {
        "selenium-manager.exe"
    } else {
        "selenium-manager"
    };
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let beside = executable.with_file_name(binary);
    Ok(if beside.is_file() {
        beside
    } else {
        root.join("src-tauri/resources").join(binary)
    })
}
