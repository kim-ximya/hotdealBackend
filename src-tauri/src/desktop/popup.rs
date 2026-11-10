use super::{internal, open_article, show_main, Desktop};
use crate::{model::Article, Result};
use serde_json::{json, Value};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "notification";
const INSET: f64 = 16.;

#[derive(Clone, Copy)]
struct Drag {
    start: f64,
    origin: PhysicalPosition<i32>,
    width: u32,
    scale: f64,
    edge: i32,
}

#[derive(Default)]
pub struct Popup {
    sequence: u64,
    timer: u64,
    rows: Vec<Article>,
    test: bool,
    payload: Option<Value>,
    building: bool,
    ready: bool,
    hovered: bool,
    drag: Option<Drag>,
    settling: bool,
    closing: bool,
    animation: u64,
    queued: Option<(Vec<Article>, bool)>,
}

pub fn show(app: &AppHandle, rows: Vec<Article>, test: bool) -> Result<()> {
    let state = app.state::<Desktop>();
    let rows = if test {
        rows
    } else {
        state.core.filter_notifications(rows)
    };
    if (!test && rows.is_empty()) || state.shutting.load(Ordering::Acquire) {
        return Ok(());
    }
    let (payload, create, visible) = {
        let mut popup = state.popup.lock().unwrap();
        if popup.closing {
            match &mut popup.queued {
                Some((queued, prior)) if *prior == test => queued.extend(rows),
                Some((_, false)) if test => {}
                _ => popup.queued = Some((rows, test)),
            }
            return Ok(());
        }
        if popup.test != test || popup.payload.is_none() {
            popup.rows.clear();
        }
        popup.test = test;
        popup.rows.extend(rows);
        popup
            .rows
            .sort_by_key(|row| std::cmp::Reverse(row.numeric_id()));
        popup.rows.dedup_by(|a, b| a.id == b.id);
        popup.rows.truncate(1000);
        popup.sequence += 1;
        let articles = if test {
            json!([{"id":null,"title":"새 핫딜 알림 미리보기","category":"테스트","author":null}])
        } else {
            json!(popup
                .rows
                .iter()
                .take(3)
                .map(
                    |a| json!({"id":a.id,"title":a.title.chars().take(300).collect::<String>(),
                "category":a.category.as_deref().map(|s| s.chars().take(100).collect::<String>()),
                "author":a.author.as_deref().map(|s| s.chars().take(80).collect::<String>())})
                )
                .collect::<Vec<_>>())
        };
        let payload = json!({"sequence":popup.sequence,"total":if test { 1 } else { popup.rows.len() },
            "test":test,"articles":articles,"sound":!cfg!(windows) && state.core.notifications().sound_enabled});
        popup.payload = Some(payload.clone());
        let create = !popup.building && app.get_webview_window(LABEL).is_none();
        if create {
            popup.building = true;
        }
        (payload, create, popup.ready)
    };
    if create {
        let result =
            WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notification.html".into()))
                .title("새 핫딜 알림")
                .inner_size(396., 240.)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .focused(false)
                .focusable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .visible(false)
                .on_navigation(internal)
                .build();
        state.popup.lock().unwrap().building = false;
        if let Err(error) = result {
            dismiss(app);
            return Err(error.to_string());
        }
    }
    if visible {
        if let Some(window) = app.get_webview_window(LABEL) {
            reposition(app);
            let _ = window.show();
            let _ = app.emit_to(LABEL, "hotdeal:notification", payload);
            if state.core.notifications().sound_enabled {
                chime();
            }
            arm(app);
        }
    }
    Ok(())
}

pub fn dismiss(app: &AppHandle) {
    let state = app.state::<Desktop>();
    {
        let mut popup = state.popup.lock().unwrap();
        popup.timer += 1;
        popup.animation += 1;
        popup.payload = None;
        popup.rows.clear();
        popup.hovered = false;
        popup.drag = None;
        popup.settling = false;
        popup.closing = false;
        popup.queued = None;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

fn arm(app: &AppHandle) {
    let state = app.state::<Desktop>();
    let epoch = {
        let mut popup = state.popup.lock().unwrap();
        popup.timer += 1;
        if popup.payload.is_none() || popup.hovered || popup.drag.is_some() || popup.settling {
            return;
        }
        popup.timer
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        let valid = app.state::<Desktop>().popup.lock().unwrap().timer == epoch;
        if valid {
            dismiss(&app);
        }
    });
}

pub fn reposition(app: &AppHandle) {
    let rows = app.try_state::<Desktop>().and_then(|state| {
        let popup = state.popup.lock().unwrap();
        if popup.drag.is_some() || popup.settling {
            return None;
        }
        popup
            .payload
            .as_ref()
            .and_then(|p| p["articles"].as_array())
            .map(Vec::len)
    });
    let Some(rows) = rows else {
        return;
    };
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let inset = (INSET * scale).round() as i32;
        let width = ((396. * scale).round() as u32).min(area.size.width);
        let height =
            (((150. + rows.max(1) as f64 * 76.) * scale).round() as u32).min(area.size.height);
        let x =
            (area.position.x + area.size.width as i32 - width as i32 - inset).max(area.position.x);
        let y = (area.position.y + area.size.height as i32 - height as i32 - inset)
            .max(area.position.y);
        let _ = window.set_position(PhysicalPosition::new(x, y));
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
}

pub async fn action(
    app: &AppHandle,
    window: &WebviewWindow,
    name: &str,
    value: Value,
) -> Result<Value> {
    let state = app.state::<Desktop>();
    if state.shutting.load(Ordering::Acquire) {
        return Ok(Value::Null);
    }
    match name {
        "ready" => {
            let payload = {
                let mut popup = state.popup.lock().unwrap();
                popup.ready = true;
                popup.payload.clone()
            };
            if payload.is_some() {
                reposition(app);
                window.show().map_err(|e| e.to_string())?;
                if state.core.notifications().sound_enabled {
                    chime();
                }
                arm(app);
            }
            Ok(payload.unwrap_or(Value::Null))
        }
        "close" => {
            dismiss(app);
            Ok(Value::Null)
        }
        "hover" => {
            state.popup.lock().unwrap().hovered = value
                .as_bool()
                .ok_or("알림 포인터 상태가 올바르지 않습니다.")?;
            arm(app);
            Ok(Value::Null)
        }
        "list" => {
            show_main(app);
            let _ = app.emit_to("main", "hotdeal:showArticles", ());
            dismiss(app);
            Ok(Value::Null)
        }
        "article" => {
            let id = value.as_str().ok_or("게시글 ID가 올바르지 않습니다.")?;
            let allowed = state
                .popup
                .lock()
                .unwrap()
                .payload
                .as_ref()
                .and_then(|p| p["articles"].as_array())
                .is_some_and(|rows| rows.iter().any(|row| row["id"].as_str() == Some(id)));
            if !allowed {
                return Err("표시 중인 게시글만 열 수 있습니다.".into());
            }
            open_article(app, id)?;
            dismiss(app);
            Ok(Value::Null)
        }
        "drag-start" => {
            let start = coordinate(&value)?;
            let origin = window.outer_position().map_err(|e| e.to_string())?;
            let width = window.outer_size().map_err(|e| e.to_string())?.width;
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            let edge = window
                .current_monitor()
                .ok()
                .flatten()
                .map_or(origin.x + width as i32, |monitor| {
                    monitor.work_area().position.x + monitor.work_area().size.width as i32
                });
            let mut popup = state.popup.lock().unwrap();
            if popup.payload.is_some() && !popup.settling {
                popup.timer += 1;
                popup.drag = Some(Drag {
                    start,
                    origin,
                    width,
                    scale,
                    edge,
                });
            }
            Ok(Value::Null)
        }
        "drag-move" => {
            let x = coordinate(&value)?;
            let drag = state.popup.lock().unwrap().drag;
            if let Some(drag) = drag {
                window
                    .set_position(position(drag, x))
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "drag-end" | "drag-cancel" => {
            let x = if name == "drag-end" {
                Some(coordinate(&value)?)
            } else {
                None
            };
            settle(app, window, x).await.map(Value::Bool)
        }
        _ => Err("알 수 없는 알림 명령입니다.".into()),
    }
}

fn coordinate(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 100_000.)
        .ok_or_else(|| "드래그 좌표가 올바르지 않습니다.".into())
}
fn position(drag: Drag, x: f64) -> PhysicalPosition<i32> {
    let offset = ((x - drag.start) * drag.scale)
        .round()
        .clamp(0., drag.width as f64) as i32;
    PhysicalPosition::new(drag.origin.x + offset, drag.origin.y)
}

async fn settle(app: &AppHandle, window: &WebviewWindow, x: Option<f64>) -> Result<bool> {
    let state = app.state::<Desktop>();
    let cursor = window.cursor_position().ok();
    let current_position = window.outer_position().ok();
    let (drag, from, to, closing, epoch) = {
        let mut popup = state.popup.lock().unwrap();
        let Some(drag) = popup.drag.take() else {
            return Ok(false);
        };
        let from = x.map_or_else(
            || current_position.unwrap_or(drag.origin),
            |x| position(drag, x),
        );
        let distance = (from.x - drag.origin.x).max(0) as f64 / drag.scale;
        let closing = x.is_some()
            && (distance >= (drag.width as f64 / drag.scale / 4.).min(96.)
                || (distance >= 12.
                    && cursor.is_some_and(|cursor| cursor.x >= (drag.edge - 2) as f64)));
        let to = if closing {
            drag.edge + (INSET * drag.scale) as i32
        } else {
            drag.origin.x
        };
        popup.settling = true;
        popup.closing = closing;
        popup.animation += 1;
        (drag, from, to, closing, popup.animation)
    };
    if closing {
        let _ = app.emit_to(LABEL, "hotdeal:notification-dismiss", ());
    }
    let time = Instant::now();
    let ms = if closing { 260. } else { 300. };
    loop {
        if state.popup.lock().unwrap().animation != epoch {
            return Ok(false);
        }
        let t = (time.elapsed().as_secs_f64() * 1000. / ms).min(1.);
        let eased = 1. - (1. - t).powi(3);
        let x = from.x + ((to - from.x) as f64 * eased).round() as i32;
        if window
            .set_position(PhysicalPosition::new(x, drag.origin.y))
            .is_err()
        {
            dismiss(app);
            return Ok(false);
        }
        if t >= 1. {
            break;
        }
        tokio::time::sleep(Duration::from_millis(16)).await;
    }
    if closing {
        let queued = state.popup.lock().unwrap().queued.take();
        dismiss(app);
        if let Some((articles, test)) = queued {
            show(app, articles, test)?;
        }
    } else {
        state.popup.lock().unwrap().settling = false;
        reposition(app);
        arm(app);
    }
    Ok(closing)
}

#[cfg(windows)]
fn chime() {
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    static WAV: &[u8] = include_bytes!("../../../desktop/assets/notification.wav");
    unsafe {
        PlaySoundW(
            WAV.as_ptr().cast(),
            std::ptr::null_mut(),
            SND_ASYNC | SND_MEMORY | SND_NODEFAULT,
        );
    }
}
#[cfg(not(windows))]
fn chime() {}
