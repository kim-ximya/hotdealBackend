use crate::{core::Core, model::valid_interval};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
struct Api {
    core: Core,
    base: String,
}

pub fn router(core: Core, base: String) -> Router {
    Router::new()
        .fallback(handle)
        .with_state(Api { core, base })
}

fn error(status: StatusCode, message: impl AsRef<str>) -> Response {
    (status, Json(json!({"error":message.as_ref()}))).into_response()
}

async fn handle(State(api): State<Api>, request: Request) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if host != api.base.strip_prefix("http://") {
        return error(StatusCode::FORBIDDEN, "허용되지 않은 Host");
    }
    let origin = request.headers().get(header::ORIGIN).cloned();
    if origin.as_ref().is_some_and(|value| {
        !value.to_str().ok().is_some_and(|origin| {
            origin == api.base || api.core.config().origins.iter().any(|s| s == origin)
        })
    }) {
        return error(StatusCode::FORBIDDEN, "허용되지 않은 Origin");
    }
    let mut response = dispatch(&api.core, request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    response
}

async fn dispatch(core: &Core, request: Request) -> Response {
    let path = request.uri().path();
    let thumbnail_id = path
        .strip_prefix("/api/articles/")
        .and_then(|path| path.strip_suffix("/thumbnail"))
        .filter(|id| crate::model::valid_id(id));
    if request.method() == Method::OPTIONS
        && (thumbnail_id.is_some()
            || matches!(
                path,
                "/api/articles" | "/api/status" | "/api/settings" | "/api/collect"
            ))
    {
        return (
            StatusCode::NO_CONTENT,
            [
                (
                    header::ACCESS_CONTROL_ALLOW_METHODS,
                    "GET, PUT, POST, OPTIONS",
                ),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type"),
            ],
        )
            .into_response();
    }
    if let Some(id) = thumbnail_id.filter(|_| request.method() == Method::GET) {
        return match core.api_thumbnail(id) {
            Some(image) => {
                ([(header::CONTENT_TYPE, image.media_type)], image.bytes).into_response()
            }
            None => error(StatusCode::NOT_FOUND, "저장된 썸네일이 없습니다."),
        };
    }
    match (request.method(), path) {
        (&Method::GET, "/") => axum::response::Html(r#"<!doctype html><html lang="ko"><meta charset="utf-8">
<title>핫딜 수집 서버</title><h1>핫딜 수집 서버</h1><p>게시글을 수집해 JSON으로 저장합니다.</p>
<ul><li><a href="/api/articles">저장된 게시글 목록</a></li><li><a href="/api/status">수집 상태</a></li>
<li><a href="/api/settings">수집 간격</a></li></ul></html>"#).into_response(),
        (&Method::GET, "/api/status") => Json(core.status()).into_response(),
        (&Method::GET, "/api/settings") => Json(json!({"intervalSeconds":core.status().interval_seconds})).into_response(),
        (&Method::GET, "/api/articles") => {
            let (mut limit, mut offset) = (None, None);
            for (key, value) in url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()) {
                match key.as_ref() {
                    "limit" if limit.is_none() => limit = Some(value.into_owned()),
                    "offset" if offset.is_none() => offset = Some(value.into_owned()),
                    _ => {}
                }
            }
            let integer = |value: Option<String>, default| -> Option<usize> {
                match value { None => Some(default), Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) =>
                    value.parse().ok(), Some(_) => None }
            };
            let limit = integer(limit, 100).filter(|n| (1..=1000).contains(n));
            let offset = integer(offset, 0).filter(|n| (*n as u64) <= 9_007_199_254_740_991);
            match (limit, offset) {
                (Some(limit), Some(offset)) => Json(core.api_articles(limit, offset)).into_response(),
                _ => error(StatusCode::BAD_REQUEST, "limit는 1~1000, offset은 0 이상의 정수여야 합니다."),
            }
        }
        (&Method::PUT, "/api/settings") | (&Method::POST, "/api/collect") => {
            let update = path == "/api/settings";
            if !request.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
                .is_some_and(|v| v.split(';').next().is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))) {
                return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json이 필요합니다.");
            }
            let bytes = match tokio::time::timeout(Duration::from_secs(5), to_bytes(request.into_body(), 4096)).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "요청이 너무 큽니다."),
                Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "요청 시간이 초과되었습니다."),
            };
            let body = match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(body)) => body,
                _ => return error(StatusCode::BAD_REQUEST, "올바른 JSON 객체가 필요합니다."),
            };
            if update {
                let seconds = body.get("intervalSeconds").and_then(Value::as_u64).filter(|n| valid_interval(*n));
                let Some(seconds) = seconds.filter(|_| body.len() == 1) else {
                    return error(StatusCode::BAD_REQUEST, "intervalSeconds에 1~86400 사이의 정수를 지정하세요.");
                };
                return match core.api_interval(seconds, true) {
                    Ok(()) => Json(json!({"intervalSeconds":seconds})).into_response(),
                    Err(message) => error(StatusCode::SERVICE_UNAVAILABLE, message),
                };
            }
            match core.api_collect() {
                Ok(already) => (StatusCode::ACCEPTED, Json(json!({"accepted":true,"alreadyRunning":already,"statusUrl":"/api/status"}))).into_response(),
                Err(message) => error(StatusCode::SERVICE_UNAVAILABLE, message),
            }
        }
        _ => Response::builder().status(StatusCode::NOT_FOUND).header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Body::from(r#"{"error":"경로를 찾을 수 없습니다."}"#)).unwrap(),
    }
}
