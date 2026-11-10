use super::{popup, show_main, Desktop};
use crate::Result;
use serde_json::{json, Value};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct Updates {
    version: String,
    revision: u64,
    phase: &'static str,
    error: Option<&'static str>,
    progress: f64,
    pending: Option<Update>,
    installer: Option<Vec<u8>>,
}
impl Updates {
    pub fn new(version: String, enabled: bool) -> Self {
        Self {
            version,
            revision: 0,
            phase: if enabled { "idle" } else { "disabled" },
            error: None,
            progress: 0.,
            pending: None,
            installer: None,
        }
    }
    pub fn snapshot(&self) -> Value {
        json!({"revision":self.revision,"phase":self.phase,"currentVersion":self.version,"error":self.error,
            "progress":self.progress,"version":self.pending.as_ref().map(|update| &update.version)})
    }
}

fn edit(app: &AppHandle, change: impl FnOnce(&mut Updates)) -> Value {
    let state = app.state::<Desktop>();
    let mut updates = state.updates.lock().unwrap();
    change(&mut updates);
    updates.revision += 1;
    let snapshot = updates.snapshot();
    drop(updates);
    let _ = app.emit_to("main", "hotdeal:update", snapshot.clone());
    snapshot
}

pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            check(&app).await;
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

async fn check(app: &AppHandle) {
    let state = app.state::<Desktop>();
    if state.shutting.load(Ordering::Acquire)
        || !matches!(state.updates.lock().unwrap().phase, "idle" | "error")
    {
        return;
    }
    edit(app, |u| {
        u.phase = "checking";
        u.error = None;
    });
    let outcome = async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            .build()?
            .check()
            .await
    }
    .await;
    match outcome {
        Ok(update) => {
            let update = update.filter(|update| update.download_url.scheme() == "https");
            if let Some(info) = &update {
                state.core.log(
                    "info",
                    format!("새 앱 버전 {}을 사용할 수 있습니다.", info.version),
                );
            }
            edit(app, |u| {
                u.phase = if update.is_some() {
                    "available"
                } else {
                    "idle"
                };
                u.pending = update;
            });
        }
        Err(error) => {
            // A signed build may be used before the first Tauri release is published.
            // An absent or inaccessible feed does not prevent collection.
            eprintln!("업데이트 확인 실패: {error}");
            state.core.log(
                "error",
                "업데이트 확인에 실패했습니다. 인터넷 연결 또는 공개 릴리즈를 확인하세요.",
            );
            edit(app, |u| {
                u.phase = "error";
                u.error = Some("업데이트 확인에 실패했습니다.");
            });
        }
    }
}

pub async fn download(app: &AppHandle) -> Result<Value> {
    let state = app.state::<Desktop>();
    let update = {
        let mut updates = state.updates.lock().unwrap();
        if updates.phase != "available" {
            return Err("다운로드할 업데이트가 없습니다.".into());
        }
        updates.phase = "downloading";
        updates
            .pending
            .clone()
            .ok_or("업데이트 정보를 찾지 못했습니다.")?
    };
    edit(app, |u| {
        u.progress = 0.;
        u.error = None;
    });
    let mut received = 0u64;
    let mut last = 0u64;
    let result = update
        .download(
            |length, total| {
                received += length as u64;
                if let Some(total) = total.filter(|&n| n > 0) {
                    let percent = (received.saturating_mul(100) / total).min(100);
                    if percent > last {
                        last = percent;
                        edit(app, |u| u.progress = percent as f64);
                    }
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => Ok(edit(app, |u| {
            u.installer = Some(bytes);
            u.phase = "downloaded";
            u.progress = 100.;
        })),
        Err(_) => {
            state.core.log(
                "error",
                "업데이트를 다운로드하거나 서명을 검증하지 못했습니다.",
            );
            Ok(edit(app, |u| {
                u.phase = "available";
                u.error = Some("다운로드 또는 서명 검증에 실패했습니다. 다시 시도하세요.");
            }))
        }
    }
}

pub async fn install(app: &AppHandle) -> Result<Value> {
    let state = app.state::<Desktop>();
    let (update, bytes) = {
        let mut updates = state.updates.lock().unwrap();
        if updates.phase != "downloaded" {
            return Err("업데이트 다운로드를 먼저 완료하세요.".into());
        }
        if state.shutting.swap(true, Ordering::AcqRel) {
            return Err("앱 종료가 이미 진행 중입니다.".into());
        }
        updates.phase = "installing";
        (
            updates.pending.clone().expect("downloaded update"),
            updates.installer.take().expect("verified installer"),
        )
    };
    edit(app, |u| u.error = None);
    popup::dismiss(app);
    let result = async {
        state.core.stop().await?;
        state.exit_ready.store(true, Ordering::Release);
        update.install(&bytes).map_err(|e| e.to_string())
    }
    .await;
    if let Err(error) = result {
        state.exit_ready.store(false, Ordering::Release);
        state.shutting.store(false, Ordering::Release);
        state
            .core
            .log("error", "업데이트 설치를 시작하지 못했습니다.");
        eprintln!("업데이트 설치 실패: {error}");
        show_main(app);
        return Ok(edit(app, |u| {
            u.phase = "downloaded";
            u.installer = Some(bytes);
            u.error = Some("업데이트 설치에 실패했습니다. 다시 시도하세요.");
        }));
    }
    let snapshot = state.updates.lock().unwrap().snapshot();
    Ok(snapshot)
}
