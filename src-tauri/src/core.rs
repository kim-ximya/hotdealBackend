use crate::{
    api,
    browser::{BrowserStatus, Collector},
    model::{
        self, Article, Articles, Config, Interests, NewArticles, NotificationSettings, CHANNEL,
    },
    Result,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    net::Ipv4Addr,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Notify},
    task::JoinHandle,
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub enum Event {
    Changed,
    Logs,
    New(Vec<Article>),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub mode: String,
    pub channel: String,
    pub interval_seconds: u64,
    pub running: bool,
    pub is_collecting: bool,
    pub next_run_at: Option<String>,
    pub last_started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error: Option<Value>,
    pub attempts: u64,
    pub successes: u64,
    pub consecutive_failures: u64,
    pub article_count: usize,
    pub browser: Value,
}

impl Status {
    fn new(seconds: u64, articles: &Articles, browser: BrowserStatus, running: bool) -> Self {
        Self {
            mode: "selenium".into(),
            channel: CHANNEL.into(),
            interval_seconds: seconds,
            running,
            is_collecting: false,
            next_run_at: None,
            last_started_at: None,
            last_finished_at: None,
            last_success_at: articles.updated_at.clone(),
            last_error: None,
            attempts: 0,
            successes: 0,
            consecutive_failures: 0,
            article_count: articles.total,
            browser: json!(browser),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Log {
    pub id: u64,
    pub at: String,
    pub level: &'static str,
    pub message: String,
}

struct Data {
    revision: u64,
    article_reset_revision: u64,
    phase: &'static str,
    owned: bool,
    base: Option<String>,
    error: Option<String>,
    status: Status,
    articles: Articles,
    ua: String,
    logs: std::collections::VecDeque<Log>,
    log_id: u64,
    log_revision: u64,
    interests: Interests,
    interest_error: Option<String>,
    notifications: NotificationSettings,
}

struct Running {
    cancel: CancellationToken,
    task: JoinHandle<()>,
    api: Option<JoinHandle<std::io::Result<()>>>,
    _data_lock: Option<File>,
}

struct Shared {
    config: Config,
    data: Mutex<Data>,
    running: tokio::sync::Mutex<Option<Running>>,
    wake: Notify,
    events: broadcast::Sender<Event>,
    client: reqwest::Client,
}

#[derive(Clone)]
pub struct Core(Arc<Shared>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntervalSettings {
    interval_seconds: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserSettings {
    user_agent: String,
}

impl Core {
    pub fn new(config: Config) -> Self {
        let articles = model::load_articles(&config.directory, config.max_articles);
        let interval = load_interval(&config);
        let ua = load_user_agent(&config);
        let error = articles
            .as_ref()
            .err()
            .or(interval.as_ref().err())
            .or(ua.as_ref().err())
            .cloned();
        let articles = articles.unwrap_or_default();
        let ua = ua.unwrap_or_default();
        let status = Status::new(
            interval.unwrap_or(180),
            &articles,
            BrowserStatus::new(ua.clone(), "closed"),
            false,
        );
        let interests =
            model::read_json::<Interests>(&config.user_data.join("interest-settings.json"))
                .and_then(|value| value.unwrap_or_default().normalize());
        let interest_error = interests.as_ref().err().cloned();
        let notifications = model::read_json::<NotificationSettings>(
            &config.user_data.join("notification-settings.json"),
        );
        let notification_error = notifications.as_ref().err().cloned();
        let (events, _) = broadcast::channel(128);
        let core = Self(Arc::new(Shared {
            config,
            data: Mutex::new(Data {
                revision: 0,
                article_reset_revision: 0,
                phase: if error.is_some() { "error" } else { "stopped" },
                owned: false,
                base: None,
                error: error.clone(),
                status,
                articles,
                ua,
                logs: Default::default(),
                log_id: 0,
                log_revision: 0,
                interests: interests.unwrap_or_default(),
                interest_error: interest_error.clone(),
                notifications: notifications
                    .unwrap_or_else(|_| {
                        Some(NotificationSettings {
                            enabled: false,
                            sound_enabled: true,
                        })
                    })
                    .unwrap_or_default(),
            }),
            running: tokio::sync::Mutex::new(None),
            wake: Notify::new(),
            events,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .expect("loopback HTTP client"),
        }));
        core.log(
            "info",
            "준비되었습니다. 서버를 시작하면 첫 수집이 실행됩니다.",
        );
        for error in [error, interest_error, notification_error]
            .into_iter()
            .flatten()
        {
            core.log("error", error);
        }
        core
    }

    fn data(&self) -> MutexGuard<'_, Data> {
        self.0.data.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn config(&self) -> &Config {
        &self.0.config
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.events.subscribe()
    }
    fn update(&self, edit: impl FnOnce(&mut Data)) {
        let mut data = self.data();
        edit(&mut data);
        data.revision += 1;
        drop(data);
        let _ = self.0.events.send(Event::Changed);
    }

    pub fn snapshot(&self) -> Value {
        let data = self.data();
        json!({"revision":data.revision,"articleResetRevision":data.article_reset_revision,"localArticleCount":data.articles.total,
            "phase":data.phase,"owned":data.owned,"baseUrl":data.base,"error":data.error,
            "dataDirectory":self.config().directory,"intervalSeconds":data.status.interval_seconds,"userAgent":data.ua,"status":data.status})
    }
    pub fn status(&self) -> Status {
        self.data().status.clone()
    }
    pub fn logs(&self) -> Value {
        let data = self.data();
        json!({"revision":data.log_revision,"logs":data.logs})
    }
    pub fn log(&self, level: &'static str, message: impl AsRef<str>) {
        let mut data = self.data();
        data.log_id += 1;
        data.log_revision += 1;
        let id = data.log_id;
        if data.logs.len() == 500 {
            data.logs.pop_front();
        }
        data.logs.push_back(Log {
            id,
            at: model::timestamp(),
            level,
            message: message.as_ref().chars().take(8000).collect(),
        });
        drop(data);
        let _ = self.0.events.send(Event::Logs);
    }
    pub fn clear_logs(&self) -> Value {
        let mut data = self.data();
        data.logs.clear();
        data.log_revision += 1;
        drop(data);
        let _ = self.0.events.send(Event::Logs);
        self.logs()
    }
    pub fn interests(&self) -> Value {
        let data = self.data();
        json!({"keywords":data.interests.keywords,"notifyOnlyMatches":data.interests.notify_only_matches,"error":data.interest_error})
    }
    pub fn set_interests(&self, value: Interests) -> Result<Value> {
        let value = value.normalize()?;
        {
            let mut data = self.data();
            model::write_json(
                &self.config().user_data.join("interest-settings.json"),
                &value,
            )?;
            data.interests = value;
            data.interest_error = None;
        }
        self.log("info", "관심 품목 설정을 저장했습니다.");
        Ok(self.interests())
    }
    pub fn filter_notifications(&self, rows: Vec<Article>) -> Vec<Article> {
        let data = self.data();
        if data.interest_error.is_some() || !data.notifications.enabled {
            return vec![];
        }
        rows.into_iter()
            .filter(|row| !data.interests.notify_only_matches || data.interests.matches(&row.title))
            .collect()
    }
    pub fn notifications(&self) -> NotificationSettings {
        self.data().notifications.clone()
    }
    pub fn set_notifications(&self, value: NotificationSettings) -> Result<NotificationSettings> {
        let mut data = self.data();
        model::write_json(
            &self.config().user_data.join("notification-settings.json"),
            &value,
        )?;
        data.notifications = value.clone();
        Ok(value)
    }

    pub async fn start(&self, allow_external: bool) -> Result<Value> {
        let mut running = self.0.running.lock().await;
        if running.as_ref().is_some_and(|run| !run.task.is_finished()) {
            return Ok(self.snapshot());
        }
        if let Some(run) = running.take() {
            run.cancel.cancel();
            if let Some(api) = run.api {
                api.abort();
            }
        }
        self.update(|d| {
            d.phase = "starting";
            d.error = None;
        });
        match self.launch(allow_external).await {
            Ok(run) => {
                *running = Some(run);
                Ok(self.snapshot())
            }
            Err(error) => {
                self.update(|d| {
                    d.phase = "error";
                    d.owned = false;
                    d.error = Some(error.clone());
                    d.base = None;
                });
                self.log("error", format!("서버 시작 실패: {error}"));
                Err(error)
            }
        }
    }

    async fn launch(&self, allow_external: bool) -> Result<Running> {
        let config = self.config();
        let cancel = CancellationToken::new();
        let ua = load_user_agent(config)?;
        if allow_external && config.port != 0 {
            let base = format!("http://127.0.0.1:{}", config.port);
            if let Ok(status) = self.remote::<Status>(&base, "/api/status", None).await {
                if status.mode == "selenium"
                    && status.channel == CHANNEL
                    && status.running
                    && model::valid_interval(status.interval_seconds)
                {
                    let baseline: Articles = self
                        .remote(&base, "/api/articles?limit=1000&offset=0", None)
                        .await?;
                    self.update(|d| {
                        d.phase = "running";
                        d.owned = false;
                        d.base = Some(base.clone());
                        d.status = status;
                        d.ua = ua;
                    });
                    self.log("info", "별도로 실행 중인 수집 서버에 연결했습니다.");
                    let core = self.clone();
                    let token = cancel.clone();
                    let task =
                        tokio::spawn(
                            async move { core.poll_external(base, baseline, token).await },
                        );
                    return Ok(Running {
                        cancel,
                        task,
                        api: None,
                        _data_lock: None,
                    });
                }
            }
        }
        let lock = lock_data_directory(config)?;
        // Reload under the lock so a preceding writer cannot leave a stale baseline.
        let articles = model::load_articles(&config.directory, config.max_articles)?;
        let interval = load_interval(config)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
            .await
            .map_err(|e| format!("로컬 HTTP API 시작 실패: {e}"))?;
        let base = format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let mut tracker = NewArticles::default();
        if articles.updated_at.is_some() {
            tracker.observe(&articles.articles);
        }
        self.update(|d| {
            d.phase = "running";
            d.owned = true;
            d.base = Some(base.clone());
            d.ua = ua.clone();
            d.status = Status::new(
                interval,
                &articles,
                BrowserStatus::new(ua.clone(), "idle"),
                true,
            );
            d.status.is_collecting = true;
            d.articles = articles;
        });
        self.log("info", format!("Selenium 핫딜 수집 서버: {base}"));
        let app = api::router(self.clone(), base);
        let api_token = cancel.clone();
        let api = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(api_token.cancelled_owned())
                .await
        });
        let core = self.clone();
        let token = cancel.clone();
        let collector = Collector::new(config.clone(), ua);
        let task = tokio::spawn(async move { core.schedule(collector, tracker, token).await });
        Ok(Running {
            cancel,
            task,
            api: Some(api),
            _data_lock: Some(lock),
        })
    }

    pub async fn stop(&self) -> Result<Value> {
        let mut running = self.0.running.lock().await;
        if let Some(mut run) = running.take() {
            self.update(|d| {
                d.phase = "stopping";
                d.status.running = false;
                d.status.next_run_at = None;
            });
            run.cancel.cancel();
            if let Err(error) = (&mut run.task).await {
                self.log("error", format!("수집 작업 종료 중 오류: {error}"));
            }
            if let Some(mut api) = run.api.take() {
                if timeout(Duration::from_secs(5), &mut api).await.is_err() {
                    api.abort();
                }
            }
            self.log(
                "info",
                if run._data_lock.is_some() {
                    "수집 서버와 전용 브라우저를 종료했습니다."
                } else {
                    "외부 서버 연결을 해제했습니다."
                },
            );
        }
        let interval = load_interval(self.config());
        self.update(|d| {
            if !d.owned {
                if let Ok(interval) = interval {
                    d.status.interval_seconds = interval;
                }
            }
            d.phase = "stopped";
            d.owned = false;
            d.base = None;
            d.error = None;
            d.status.running = false;
            d.status.is_collecting = false;
            d.status.next_run_at = None;
            d.status.browser = json!(BrowserStatus::new(d.ua.clone(), "closed"));
        });
        Ok(self.snapshot())
    }

    pub async fn reset_articles(&self) -> Result<Value> {
        let running = self.0.running.lock().await;
        if running.is_some() {
            return Err(
                "수집 서버를 중지하거나 외부 서버 연결을 해제한 뒤 다시 시도하세요.".into(),
            );
        }
        let config = self.config();
        let _lock = lock_data_directory(config)?;
        match fs::remove_file(config.directory.join("articles.json")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("게시글 데이터를 초기화하지 못했습니다. {error}")),
        }
        let cleanup = crate::thumbnails::prune(&config.directory, &[]);
        self.update(|data| {
            data.article_reset_revision += 1;
            data.articles = Articles::default();
            data.status.article_count = 0;
            data.status.last_success_at = None;
            if data.phase == "error" {
                data.error = load_interval(config)
                    .err()
                    .or_else(|| load_user_agent(config).err());
                if data.error.is_none() {
                    data.phase = "stopped";
                }
            }
        });
        self.log("info", "저장된 핫딜 게시글을 초기화했습니다.");
        if let Err(error) = cleanup {
            let message =
                format!("게시글은 초기화했지만 일부 썸네일을 삭제하지 못했습니다. {error}");
            self.log("error", &message);
            return Err(message);
        }
        Ok(self.snapshot())
    }

    async fn schedule(
        &self,
        mut collector: Collector,
        mut tracker: NewArticles,
        cancel: CancellationToken,
    ) {
        loop {
            if cancel.is_cancelled() {
                break;
            }
            self.update(|d| {
                d.status.is_collecting = true;
                d.status.next_run_at = None;
                d.status.last_started_at = Some(model::timestamp());
                d.status.attempts += 1;
            });
            self.log("info", "핫딜 목록 수집을 시작합니다.");
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = collector.collect(|browser| {
                    let stage = browser.stage;
                    let changed = self.data().status.browser["stage"] != stage;
                    self.update(|d| d.status.browser = json!(browser));
                    if changed {
                        let message = match stage {
                            "starting-browser" => "전용 Chrome을 준비합니다.",
                            "navigating" => "핫딜 채널에 접속합니다.",
                            "waiting-for-list" => "게시글 목록을 기다립니다.",
                            "parsing" => "게시글 목록 HTML을 분석합니다.",
                            _ => return,
                        };
                        self.log("browser", message);
                    }
                }) => result,
            };
            if cancel.is_cancelled() {
                break;
            }
            let result = result.and_then(|rows| {
                let data = self.data().articles.clone();
                let (snapshot, committed) = model::merge_articles(
                    &data,
                    rows,
                    model::timestamp(),
                    self.config().max_articles,
                )?;
                Ok((snapshot, committed))
            });
            let result = match result {
                Ok((snapshot, committed)) => {
                    let agent = self.status().browser["effectiveUserAgent"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        _ = crate::thumbnails::collect(&self.config().directory, &self.0.client, &agent, &committed) => {}
                    }
                    if cancel.is_cancelled() {
                        break;
                    }
                    model::write_json(&self.config().directory.join("articles.json"), &snapshot)
                        .map(|()| {
                            let _ = crate::thumbnails::prune(
                                &self.config().directory,
                                &snapshot.articles,
                            );
                            (snapshot, committed)
                        })
                }
                Err(error) => Err(error),
            };
            match result {
                Ok((snapshot, committed)) => {
                    self.log(
                        "info",
                        format!(
                            "수집·저장 완료: 이번 목록 {}개, 총 보관 {}개",
                            snapshot.latest_count, snapshot.total
                        ),
                    );
                    self.update(|d| {
                        d.status.last_success_at = snapshot.updated_at.clone();
                        d.status.last_error = None;
                        d.status.successes += 1;
                        d.status.consecutive_failures = 0;
                        d.status.article_count = snapshot.total;
                        d.articles = snapshot;
                    });
                    self.announce(tracker.observe(&committed));
                }
                Err(error) => {
                    self.update(|d| {
                        d.status.consecutive_failures += 1;
                        d.status.last_error =
                            Some(json!({"at":model::timestamp(),"message":error}));
                    });
                    self.log(
                        "error",
                        format!("수집 실패: {error} 마지막으로 저장한 데이터를 유지합니다."),
                    );
                }
            }
            self.update(|d| {
                d.status.last_finished_at = Some(model::timestamp());
                d.status.is_collecting = false;
            });
            loop {
                let (collect, delay, next) = {
                    let data = self.data();
                    let last = data
                        .status
                        .last_started_at
                        .as_deref()
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map_or(Utc::now().timestamp_millis(), |t| t.timestamp_millis());
                    let now = Utc::now().timestamp_millis();
                    let next = next_tick(last, now, data.status.interval_seconds);
                    (
                        data.status.is_collecting,
                        Duration::from_millis((next - now).max(0) as u64),
                        next,
                    )
                };
                if collect || cancel.is_cancelled() {
                    break;
                }
                self.update(|d| {
                    if !d.status.is_collecting {
                        d.status.next_run_at = DateTime::from_timestamp_millis(next)
                            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                    }
                });
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    _ = self.0.wake.notified() => continue,
                    _ = sleep(delay) => break,
                }
            }
        }
        let browser = collector.close().await;
        self.update(|d| {
            d.status.browser = json!(browser);
            d.status.is_collecting = false;
        });
    }

    fn announce(&self, rows: Vec<Article>) {
        if !rows.is_empty() {
            let _ = self.0.events.send(Event::New(rows));
        }
    }

    async fn poll_external(&self, base: String, baseline: Articles, cancel: CancellationToken) {
        let mut tracker = NewArticles::default();
        if baseline.updated_at.is_some() {
            tracker.observe(&baseline.articles);
        }
        let mut seen_at = baseline.updated_at;
        loop {
            tokio::select! { _ = cancel.cancelled() => return, _ = sleep(Duration::from_millis(1500)) => {} }
            let remote = tokio::select! { _ = cancel.cancelled() => return, result = self.remote::<Status>(&base, "/api/status", None) => result };
            match remote {
                Ok(status)
                    if status.running
                        && status.mode == "selenium"
                        && status.channel == CHANNEL
                        && model::valid_interval(status.interval_seconds) =>
                {
                    let updated = status.last_success_at.clone();
                    if self.status().last_error != status.last_error {
                        if let Some(message) = status
                            .last_error
                            .as_ref()
                            .and_then(|error| error["message"].as_str())
                        {
                            self.log("error", message);
                        }
                    }
                    self.update(|d| d.status = status);
                    if updated.is_some() && updated != seen_at {
                        let page = tokio::select! { _ = cancel.cancelled() => return, result = self.remote::<Articles>(&base, "/api/articles?limit=1000&offset=0", None) => result };
                        match page {
                            Ok(page) => {
                                seen_at = page.updated_at;
                                self.announce(tracker.observe(&page.articles));
                                self.log(
                                    "info",
                                    format!("외부 서버 수집 완료: 총 보관 {}개", page.total),
                                );
                            }
                            Err(error) => {
                                self.log("error", format!("외부 서버 새 글 확인 실패: {error}"))
                            }
                        }
                    }
                }
                other => {
                    let message = other.err().unwrap_or_else(|| {
                        "외부 서버가 중지되었거나 응답 형식이 바뀌었습니다.".into()
                    });
                    self.update(|d| {
                        d.phase = "error";
                        d.status.running = false;
                        d.status.is_collecting = false;
                        d.status.next_run_at = None;
                        d.base = None;
                        d.error = Some(message.clone());
                    });
                    self.log("error", format!("외부 서버 연결 끊김: {message}"));
                    return;
                }
            }
        }
    }

    async fn remote<T: serde::de::DeserializeOwned>(
        &self,
        base: &str,
        route: &str,
        body: Option<(reqwest::Method, Value)>,
    ) -> Result<T> {
        let url = format!("{base}{route}");
        let builder = body.map_or_else(
            || self.0.client.get(&url),
            |(method, body)| self.0.client.request(method, &url).json(&body),
        );
        let mut response = builder
            .send()
            .await
            .map_err(|e| format!("외부 서버 요청 실패: {e}"))?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                return Err("외부 서버 응답이 너무 큽니다.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let value: Value = serde_json::from_slice(&bytes).unwrap_or_default();
            return Err(value["error"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("HTTP {status}")));
        }
        serde_json::from_slice(&bytes).map_err(|e| format!("외부 서버 응답을 읽지 못했습니다: {e}"))
    }

    pub fn api_articles(&self, limit: usize, offset: usize) -> Value {
        page(&self.data().articles, limit, offset, None)
    }

    pub(crate) fn api_thumbnail(&self, id: &str) -> Option<crate::thumbnails::Thumbnail> {
        let source = self
            .data()
            .articles
            .articles
            .iter()
            .find(|row| row.id == id)?
            .thumbnail_url
            .clone()?;
        crate::thumbnails::read(&self.config().directory, id, &source)
    }

    #[cfg(feature = "desktop")]
    pub(crate) async fn list_thumbnail(
        &self,
        id: &str,
        source: &str,
    ) -> Option<crate::thumbnails::Thumbnail> {
        if !model::valid_id(id) {
            return None;
        }
        if let Some(base) = self.external_base() {
            let response = self
                .0
                .client
                .get(format!("{base}/api/articles/{id}/thumbnail"))
                .send()
                .await
                .ok()?;
            return crate::thumbnails::read_response(response).await;
        }
        crate::thumbnails::read(&self.config().directory, id, source)
    }

    pub async fn list(
        &self,
        limit: usize,
        offset: usize,
        interest_only: bool,
        category: Option<&str>,
    ) -> Result<Value> {
        if !(1..=1000).contains(&limit) || (offset as u64) > 9_007_199_254_740_991 {
            return Err("limit는 1~1000, offset은 0 이상의 정수여야 합니다.".into());
        }
        let (phase, owned, base, interests) = {
            let data = self.data();
            (
                data.phase,
                data.owned,
                data.base.clone(),
                interest_only.then(|| data.interests.clone()),
            )
        };
        let view = |source| ListView {
            category: category.map(str::trim).filter(|name| !name.is_empty()),
            interests: interests.as_ref(),
            source,
        };
        if phase == "running" && owned {
            return Ok(page(
                &self.data().articles,
                limit,
                offset,
                Some(view("api")),
            ));
        }
        if let Some(base) = base.filter(|_| phase == "running") {
            // External servers provide unfiltered pages, so apply view filters after reading them.
            let mut data: Articles = self
                .remote(&base, "/api/articles?limit=1000&offset=0", None)
                .await?;
            if data.total > 100_000 || data.articles.len() != data.total.min(1000) {
                return Err("외부 서버 게시글 목록 응답이 올바르지 않습니다.".into());
            }
            while data.articles.len() < data.total {
                let start = data.articles.len();
                let chunk: Articles = self
                    .remote(
                        &base,
                        &format!("/api/articles?limit=1000&offset={start}"),
                        None,
                    )
                    .await?;
                if chunk.total != data.total
                    || chunk.updated_at != data.updated_at
                    || chunk.articles.len() != (data.total - start).min(1000)
                {
                    return Err("외부 게시글 목록이 갱신되었습니다. 목록을 새로고침하세요.".into());
                }
                data.articles.extend(chunk.articles);
            }
            return Ok(page(&data, limit, offset, Some(view("api"))));
        }
        let data = model::load_articles(&self.config().directory, self.config().max_articles)?;
        Ok(page(&data, limit, offset, Some(view("file"))))
    }

    pub fn api_collect(&self) -> Result<bool> {
        let mut already = false;
        let mut accepted = false;
        self.update(|d| {
            if d.owned && d.status.running {
                already = d.status.is_collecting;
                d.status.is_collecting = true;
                d.status.next_run_at = None;
                accepted = true;
            }
        });
        if !accepted {
            return Err("수집 서버가 종료 중이거나 시작되지 않았습니다.".into());
        }
        if !already {
            self.0.wake.notify_one();
        }
        Ok(already)
    }

    pub async fn collect(&self) -> Result<Value> {
        let _guard = self.0.running.lock().await;
        let external = self.external_base();
        if let Some(base) = external {
            let _: Value = self
                .remote(
                    &base,
                    "/api/collect",
                    Some((reqwest::Method::POST, json!({}))),
                )
                .await?;
        } else {
            self.api_collect()?;
        }
        Ok(self.snapshot())
    }

    fn external_base(&self) -> Option<String> {
        let data = self.data();
        if data.phase == "running" && !data.owned {
            data.base.clone()
        } else {
            None
        }
    }
    pub fn api_interval(&self, seconds: u64, require_running: bool) -> Result<()> {
        if !model::valid_interval(seconds) {
            return Err("수집 간격은 1~86400초 사이의 정수여야 합니다.".into());
        }
        {
            let mut data = self.data();
            if data.phase == "stopping" || (require_running && !(data.status.running && data.owned))
            {
                return Err("수집 서버가 종료 중이거나 시작되지 않았습니다.".into());
            }
            model::write_json(
                &self.config().directory.join("settings.json"),
                &IntervalSettings {
                    interval_seconds: seconds,
                },
            )?;
            data.status.interval_seconds = seconds;
            data.revision += 1;
        }
        let _ = self.0.events.send(Event::Changed);
        self.0.wake.notify_one();
        self.log("info", format!("수집 간격 변경: {seconds}초"));
        Ok(())
    }
    pub async fn set_interval(&self, seconds: u64) -> Result<Value> {
        let _guard = self.0.running.lock().await;
        if let Some(base) = self.external_base() {
            if !model::valid_interval(seconds) {
                return Err("수집 간격은 1~86400초 사이의 정수여야 합니다.".into());
            }
            let _: Value = self
                .remote(
                    &base,
                    "/api/settings",
                    Some((reqwest::Method::PUT, json!({"intervalSeconds":seconds}))),
                )
                .await?;
            self.update(|d| d.status.interval_seconds = seconds);
        } else {
            self.api_interval(seconds, false)?;
        }
        Ok(self.snapshot())
    }
    pub async fn set_user_agent(&self, value: &str) -> Result<Value> {
        let _guard = self.0.running.lock().await;
        if self.external_base().is_some() {
            return Err("외부 서버에서는 User-Agent를 변경할 수 없습니다.".into());
        }
        let value = model::user_agent(value)?;
        model::write_json(
            &self.config().directory.join("browser-settings.json"),
            &BrowserSettings {
                user_agent: value.clone(),
            },
        )?;
        self.update(|d| d.ua = value);
        self.log(
            "info",
            "User-Agent 설정을 저장했습니다. 다음 서버 시작부터 적용됩니다.",
        );
        Ok(self.snapshot())
    }
}

fn lock_data_directory(config: &Config) -> Result<File> {
    fs::create_dir_all(&config.directory).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.directory.join(".collector.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| "다른 수집기가 같은 저장 폴더를 사용 중입니다.")?;
    Ok(lock)
}

fn next_tick(last: i64, now: i64, seconds: u64) -> i64 {
    let span = (seconds as i64) * 1000;
    last + span * ((now - last).div_euclid(span) + 1).max(1)
}

fn load_interval(config: &Config) -> Result<u64> {
    if let Some(seconds) = config.interval_override {
        return Ok(seconds);
    }
    let seconds = model::read_json::<IntervalSettings>(&config.directory.join("settings.json"))?
        .map_or(180, |s| s.interval_seconds);
    if !model::valid_interval(seconds) {
        return Err("저장된 수집 간격이 올바르지 않습니다.".into());
    }
    Ok(seconds)
}

fn load_user_agent(config: &Config) -> Result<String> {
    if let Some(value) = &config.ua_override {
        return Ok(value.clone());
    }
    let value =
        model::read_json::<BrowserSettings>(&config.directory.join("browser-settings.json"))?
            .map_or_else(String::new, |s| s.user_agent);
    model::user_agent(&value)
}

struct ListView<'a> {
    category: Option<&'a str>,
    interests: Option<&'a Interests>,
    source: &'static str,
}

fn page(data: &Articles, limit: usize, offset: usize, view: Option<ListView<'_>>) -> Value {
    let visible = data
        .articles
        .iter()
        .filter(|row| view.is_none() || row.category.as_deref().map(str::trim) != Some("바이럴"));
    let all_total = view.as_ref().map(|_| visible.clone().count());
    let rows: Vec<_> = visible
        .filter(|row| {
            view.as_ref().is_none_or(|view| {
                view.category
                    .is_none_or(|name| row.category.as_deref().map(str::trim) == Some(name))
                    && view
                        .interests
                        .is_none_or(|filter| filter.matches(&row.title))
            })
        })
        .collect();
    let total = rows.len();
    let articles: Vec<_> = rows.into_iter().skip(offset).take(limit).collect();
    let mut value = json!({"schemaVersion":data.schema_version,"channel":data.channel,"sourceUrl":data.source_url,
        "updatedAt":data.updated_at,"latestCount":data.latest_count,"total":total,"limit":limit,"offset":offset,
        "returnedCount":articles.len(),"articles":articles});
    if let Some(view) = view {
        value["source"] = json!(view.source);
        value["allTotal"] = json!(all_total);
    }
    value
}

#[cfg(test)]
mod tests {
    #[test]
    fn scheduler_skips_missed_intervals() {
        assert_eq!(super::next_tick(1000, 1500, 2), 3000);
        assert_eq!(super::next_tick(1000, 7000, 2), 9000);
        assert_eq!(super::next_tick(1000, 8500, 2), 9000);
    }
}
