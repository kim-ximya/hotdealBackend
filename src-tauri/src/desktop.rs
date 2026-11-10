mod popup;
mod startup;
mod updates;

use crate::{
    core::{Core, Event},
    model::{self, Config, Interests, NotificationSettings},
    Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const TRAY: &str = "hotdeal";

struct Desktop {
    core: Core,
    shutting: AtomicBool,
    exit_ready: AtomicBool,
    popup: Mutex<popup::Popup>,
    updates: Mutex<updates::Updates>,
    logs: tokio::sync::Mutex<()>,
}

impl Desktop {
    fn new(core: Core, version: String, updater_enabled: bool) -> Self {
        Self {
            core,
            shutting: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
            popup: Default::default(),
            updates: Mutex::new(updates::Updates::new(version, updater_enabled)),
            logs: Default::default(),
        }
    }
}

fn allow(window: &WebviewWindow, label: &str, page: &str) -> Result<()> {
    if window.label() != label {
        return Err("허용되지 않은 창의 요청입니다.".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    let local = (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"));
    if !local || !(url.path() == page || (label == "main" && url.path() == "/")) {
        return Err("허용되지 않은 화면의 요청입니다.".into());
    }
    Ok(())
}

fn internal(url: &url::Url) -> bool {
    (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main(app: &AppHandle) -> Result<()> {
    if app.tray_by_id(TRAY).is_none() {
        return Err("트레이 아이콘을 사용할 수 없습니다.".into());
    }
    for label in ["main", "logs"] {
        if let Some(window) = app.get_webview_window(label) {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn open_article(app: &AppHandle, id: &str) -> Result<()> {
    if !model::valid_id(id) {
        return Err("게시글 ID가 올바르지 않습니다.".into());
    }
    app.opener()
        .open_url(format!("{}/{id}", model::SOURCE_URL), None::<&str>)
        .map_err(|e| e.to_string())
}

async fn open_logs(app: &AppHandle, state: &Desktop) -> Result<()> {
    let _lock = state.logs.lock().await;
    let window = match app.get_webview_window("logs") {
        Some(window) => window,
        None => {
            let window =
                WebviewWindowBuilder::new(app, "logs", WebviewUrl::App("logs.html".into()))
                    .title("실행 로그 · 핫딜 수집 관리자")
                    .inner_size(960., 660.)
                    .min_inner_size(660., 420.)
                    .visible(false)
                    .on_navigation(internal)
                    .build()
                    .map_err(|e| e.to_string())?;
            window
        }
    };
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Query {
    limit: usize,
    offset: usize,
    interest_only: bool,
    category: Option<String>,
}
impl Default for Query {
    fn default() -> Self {
        Self {
            limit: 50,
            offset: 0,
            interest_only: false,
            category: None,
        }
    }
}

#[tauri::command]
async fn desktop_action(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Desktop>,
    name: String,
    value: Option<Value>,
) -> Result<Value> {
    allow(&window, "main", "/index.html")?;
    if state.shutting.load(Ordering::Acquire)
        && !matches!(name.as_str(), "snapshot" | "updateState")
    {
        return Err("앱 종료 또는 업데이트가 진행 중입니다.".into());
    }
    let value = value.unwrap_or(Value::Null);
    match name.as_str() {
        "snapshot" => Ok(state.core.snapshot()),
        "start" => state.core.start(true).await,
        "stop" => state.core.stop().await,
        "collect" => state.core.collect().await,
        "interval" => {
            state
                .core
                .set_interval(value.as_u64().ok_or("수집 간격이 올바르지 않습니다.")?)
                .await
        }
        "userAgent" => {
            state
                .core
                .set_user_agent(value.as_str().ok_or("User-Agent가 올바르지 않습니다.")?)
                .await
        }
        "articles" => {
            let query: Query = if value.is_null() {
                Query::default()
            } else {
                serde_json::from_value(value).map_err(|_| "목록 조회 조건이 올바르지 않습니다.")?
            };
            state
                .core
                .list(
                    query.limit,
                    query.offset,
                    query.interest_only,
                    query.category.as_deref(),
                )
                .await
        }
        "articleThumbnail" => {
            use base64::Engine;
            let id = value["id"]
                .as_str()
                .ok_or("게시글 ID가 올바르지 않습니다.")?;
            let source = value["source"]
                .as_str()
                .ok_or("썸네일 주소가 올바르지 않습니다.")?;
            Ok(state
                .core
                .list_thumbnail(id, source)
                .await
                .map_or(Value::Null, |image| {
                    json!(format!(
                        "data:{};base64,{}",
                        image.media_type,
                        base64::engine::general_purpose::STANDARD.encode(image.bytes)
                    ))
                }))
        }
        "openArticle" => {
            open_article(
                &app,
                value.as_str().ok_or("게시글 ID가 올바르지 않습니다.")?,
            )?;
            Ok(Value::Null)
        }
        "openLogs" => {
            open_logs(&app, &state).await?;
            Ok(Value::Null)
        }
        "openData" => {
            let snapshot = state.core.snapshot();
            if snapshot["phase"] == "running" && snapshot["owned"] == false {
                return Err("외부 서버의 저장 폴더를 열 수 없습니다.".into());
            }
            let path = &state.core.config().directory;
            std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "hideToTray" => {
            hide_main(&app)?;
            Ok(Value::Null)
        }
        "interestSettings" => Ok(state.core.interests()),
        "setInterestSettings" => {
            let settings: Interests =
                serde_json::from_value(value).map_err(|_| "관심 품목 설정이 올바르지 않습니다.")?;
            let result = state.core.set_interests(settings)?;
            popup::dismiss(&app);
            Ok(result)
        }
        "notificationSettings" => Ok(json!(state.core.notifications())),
        "setNotificationSettings" => {
            let settings: NotificationSettings =
                serde_json::from_value(value).map_err(|_| "알림 설정이 올바르지 않습니다.")?;
            let enabled = settings.enabled;
            let result = state.core.set_notifications(settings)?;
            if !enabled {
                popup::dismiss(&app);
            }
            state.core.log("info", "알림 설정을 저장했습니다.");
            Ok(json!(result))
        }
        "testNotification" => {
            popup::show(&app, vec![], true)?;
            Ok(Value::Null)
        }
        "startupSettings" => startup::read(),
        "setStartupSettings" => {
            let settings = startup::set(
                value
                    .as_bool()
                    .ok_or("자동 실행 설정은 켜기 또는 끄기로 지정하세요.")?,
            )?;
            state
                .core
                .log("info", "Windows 로그인 자동 실행 설정을 적용했습니다.");
            Ok(settings)
        }
        "updateState" => Ok(state.updates.lock().unwrap().snapshot()),
        "downloadUpdate" => updates::download(&app).await,
        "installUpdate" => updates::install(&app).await,
        _ => Err("알 수 없는 앱 명령입니다.".into()),
    }
}

#[tauri::command]
async fn logs_action(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    clear: bool,
) -> Result<Value> {
    allow(&window, "logs", "/logs.html")?;
    Ok(if clear {
        state.core.clear_logs()
    } else {
        state.core.logs()
    })
}

#[tauri::command]
async fn notification_action(
    window: WebviewWindow,
    app: AppHandle,
    name: String,
    value: Option<Value>,
) -> Result<Value> {
    allow(&window, "notification", "/notification.html")?;
    popup::action(&app, &window, &name, value.unwrap_or(Value::Null)).await
}

fn config(app: &AppHandle) -> Result<Config> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root");
    let debug = cfg!(debug_assertions);
    let default_user_data = if debug {
        source.join(".local/desktop")
    } else {
        app.path()
            .data_dir()
            .map_err(|e| e.to_string())?
            .join("HotdealCollector")
    };
    if debug && source.join(".env").is_file() {
        dotenvy::from_path(source.join(".env")).map_err(|e| e.to_string())?;
    }
    let user_data = std::env::var_os("HOTDEAL_USER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(default_user_data);
    let user_data = if user_data.is_absolute() {
        user_data
    } else {
        source.join(user_data)
    };
    let default_data = if debug && std::env::var_os("HOTDEAL_USER_DATA_DIR").is_none() {
        source.join(".local/selenium-server")
    } else {
        user_data.join("collector")
    };
    let root = if debug { source } else { &user_data };
    let manager = if debug {
        source.join("src-tauri/resources/selenium-manager.exe")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("selenium-manager.exe")
    };
    Config::load(root, user_data.clone(), default_data, manager, false)
}

fn update_tray(app: &AppHandle, snapshot: &Value) {
    let status = match snapshot["phase"].as_str() {
        Some("running") if snapshot["owned"] == true => "서버 실행 중",
        Some("running") => "외부 서버 연결",
        Some("starting") => "서버 시작 중",
        Some("stopping") => "서버 종료 중",
        Some("error") => "오류 확인 필요",
        _ => "서버 중지",
    };
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_tooltip(Some(format!("핫딜 수집 관리자 · {status}")));
    }
}

fn subscribe(app: AppHandle, core: Core) {
    let mut events = core.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(Event::Changed) => {
                    let snapshot = core.snapshot();
                    update_tray(&app, &snapshot);
                    let _ = app.emit_to("main", "hotdeal:snapshot", snapshot);
                }
                Ok(Event::Logs) => {
                    let _ = app.emit_to("logs", "hotdeal:logs", core.logs());
                }
                Ok(Event::New(articles))
                    if !app.state::<Desktop>().shutting.load(Ordering::Acquire) =>
                {
                    if let Err(e) = popup::show(&app, articles, false) {
                        core.log("error", format!("새 글 알림 실패: {e}"));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = app.emit_to("main", "hotdeal:snapshot", core.snapshot());
                    let _ = app.emit_to("logs", "hotdeal:logs", core.logs());
                }
                Err(_) => break,
                _ => {}
            }
        }
    });
}

fn autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Desktop>();
        if !state.shutting.load(Ordering::Acquire) && state.core.start(true).await.is_err() {
            show_main(&app);
        }
    });
}

fn request_exit(app: &AppHandle) {
    let state = app.state::<Desktop>();
    if state.shutting.swap(true, Ordering::AcqRel) {
        return;
    }
    popup::dismiss(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Desktop>();
        match state.core.stop().await {
            Ok(_) => {
                state.exit_ready.store(true, Ordering::Release);
                app.exit(0);
            }
            Err(error) => {
                state.shutting.store(false, Ordering::Release);
                state.core.log("error", error);
                show_main(&app);
            }
        }
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|arg| arg == startup::ARG) {
                autostart(app.clone());
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop_action,
            logs_action,
            notification_action
        ])
        .setup(|app| {
            let handle = app.handle();
            let core = Core::new(config(handle).map_err(std::io::Error::other)?);
            let enabled = !cfg!(debug_assertions)
                && handle
                    .config()
                    .plugins
                    .0
                    .get("updater")
                    .and_then(|v| v["pubkey"].as_str())
                    .is_some_and(|key| !key.is_empty());
            app.manage(Desktop::new(
                core.clone(),
                app.package_info().version.to_string(),
                enabled,
            ));
            let open = MenuItem::with_id(app, "open", "창 열기", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "앱 완전 종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &exit])?;
            let mut tray = TrayIconBuilder::with_id(TRAY)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("핫딜 수집 관리자 · 서버 중지")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "exit" => request_exit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            subscribe(handle.clone(), core);
            if enabled {
                updates::schedule(handle.clone());
            }
            if std::env::args().any(|arg| arg == startup::ARG) {
                autostart(handle.clone());
            } else {
                show_main(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            if let Some(state) = app.try_state::<Desktop>() {
                if state.exit_ready.load(Ordering::Acquire) {
                    return;
                }
                match (window.label(), event) {
                    ("main", WindowEvent::CloseRequested { api, .. }) => {
                        api.prevent_close();
                        let _ = hide_main(app);
                    }
                    ("main", WindowEvent::Resized(_)) if window.is_minimized().unwrap_or(false) => {
                        let _ = hide_main(app);
                    }
                    ("main", WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. }) => {
                        popup::reposition(app)
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("핫딜 수집 관리자를 시작하지 못했습니다.");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if let Some(state) = app.try_state::<Desktop>() {
                if !state.exit_ready.load(Ordering::Acquire) {
                    api.prevent_exit();
                    request_exit(app);
                }
            }
        }
    });
}
