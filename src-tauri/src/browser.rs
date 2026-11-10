use crate::{
    model::{parse_articles, Article, Config, SOURCE_URL},
    Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::{Ipv4Addr, TcpListener},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    time::{sleep, timeout, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub headless: bool,
    pub stage: &'static str,
    pub running: bool,
    pub version: Option<String>,
    pub effective_user_agent: Option<String>,
    pub title: Option<String>,
    pub http_status: Option<u16>,
    pub attention_required: bool,
    pub user_agent: String,
}

impl BrowserStatus {
    pub fn new(user_agent: String, stage: &'static str) -> Self {
        Self {
            headless: true,
            stage,
            running: false,
            version: None,
            effective_user_agent: None,
            title: None,
            http_status: None,
            attention_required: false,
            user_agent,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    title: String,
    has_article_list: bool,
    challenge_detected: bool,
    http_status: Option<u16>,
    url: String,
}

const INSPECT: &str = r#"
const navigation = performance.getEntriesByType('navigation')[0];
return {
    title: document.title, hasArticleList: !!document.querySelector('.article-list .list-table'),
    challengeDetected: /just a moment|잠시만/i.test(document.title) ||
        !!document.querySelector('#challenge-running, #cf-challenge-running, #challenge-stage'),
    httpStatus: navigation?.responseStatus > 0 ? navigation.responseStatus : null,
    url: location.origin + location.pathname
};
"#;

struct Driver {
    child: Child,
    url: String,
    session: Option<String>,
    #[cfg(windows)]
    _job: job::Job,
}

pub struct Collector {
    config: Config,
    client: reqwest::Client,
    driver: Option<Driver>,
    status: BrowserStatus,
}

impl Collector {
    pub fn new(config: Config, user_agent: String) -> Self {
        Self {
            config,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(40))
                .build()
                .expect("local HTTP client"),
            driver: None,
            status: BrowserStatus::new(user_agent, "idle"),
        }
    }

    async fn manager(&self) -> Result<(PathBuf, Option<String>)> {
        if !self.config.manager.is_file() {
            return Err("Selenium Manager를 찾지 못했습니다. 앱 설치 또는 SE_MANAGER_PATH 설정을 확인하세요.".into());
        }
        let mut cmd = hidden(&self.config.manager);
        cmd.args([
            "--browser",
            "chrome",
            "--output",
            "json",
            "--language-binding",
            "javascript",
        ])
        .env("SE_CACHE_PATH", self.config.directory.join("driver-cache"))
        .env("SE_AVOID_STATS", "true")
        .env("SE_AVOID_BROWSER_DOWNLOAD", "true")
        .env("SE_TIMEOUT", "60");
        if let Some(binary) = &self.config.chrome_binary {
            cmd.arg("--browser-path").arg(binary);
        }
        let output = timeout(Duration::from_secs(75), cmd.output())
            .await
            .map_err(|_| "Selenium Manager 응답 시간이 초과되었습니다.")?
            .map_err(|e| e.to_string())?;
        let response: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
            "Selenium Manager 응답을 읽지 못했습니다. Chrome 설치와 네트워크를 확인하세요."
        })?;
        let result = &response["result"];
        let path = result["driver_path"]
            .as_str()
            .filter(|p| !p.is_empty() && output.status.success())
            .ok_or_else(|| {
                format!(
                    "ChromeDriver 준비 실패: {}",
                    result["message"].as_str().unwrap_or("Chrome을 확인하세요.")
                )
            })?;
        let browser = result["browser_path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .map(str::to_owned);
        Ok((PathBuf::from(path), browser))
    }

    async fn connect(&mut self, emit: &impl Fn(BrowserStatus)) -> Result<()> {
        if self.driver.as_ref().is_some_and(|d| d.session.is_some()) {
            return Ok(());
        }
        self.status.stage = "starting-browser";
        emit(self.status.clone());
        let (binary, chrome_path) = self.manager().await?;
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.local_addr())
            .map_err(|e| e.to_string())?
            .port();
        let mut cmd = hidden(&binary);
        cmd.arg(format!("--port={port}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("ChromeDriver 시작 실패: {e}"))?;
        #[cfg(windows)]
        let assigned = match job::Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error);
            }
        };
        self.driver = Some(Driver {
            child,
            url: format!("http://127.0.0.1:{port}"),
            session: None,
            #[cfg(windows)]
            _job: assigned,
        });
        let url = self.driver.as_ref().unwrap().url.clone();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self
                .driver
                .as_mut()
                .unwrap()
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("ChromeDriver가 시작 중 종료되었습니다.".into());
            }
            if self
                .client
                .get(format!("{url}/status"))
                .timeout(Duration::from_millis(500))
                .send()
                .await
                .is_ok_and(|res| res.status().is_success())
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("ChromeDriver 시작 시간이 초과되었습니다.".into());
            }
            sleep(Duration::from_millis(100)).await;
        }
        let mut args = vec![
            "--headless=new".to_string(),
            "--window-size=1200,900".to_string(),
            format!(
                "--user-data-dir={}",
                self.config.directory.join("profile").display()
            ),
        ];
        if !self.status.user_agent.is_empty() {
            args.push(format!("--user-agent={}", self.status.user_agent));
        }
        let mut options = json!({"args":args});
        if let Some(path) = self.config.chrome_binary.as_ref().or(chrome_path.as_ref()) {
            options["binary"] = json!(path);
        }
        let value = request(self.client.post(format!("{url}/session")).json(&json!({
            "capabilities":{"alwaysMatch":{"browserName":"chrome","goog:chromeOptions":options,
                "timeouts":{"pageLoad":30000,"script":10000,"implicit":0}}}
        })))
        .await?;
        let session = value["sessionId"]
            .as_str()
            .filter(|id| {
                !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
            .ok_or("ChromeDriver 세션 ID를 읽지 못했습니다.")?;
        self.driver.as_mut().unwrap().session = Some(session.into());
        self.status.running = true;
        self.status.version = value["capabilities"]["browserVersion"]
            .as_str()
            .map(str::to_owned);
        self.status.effective_user_agent = self
            .execute("return navigator.userAgent")
            .await?
            .as_str()
            .map(str::to_owned);
        Ok(())
    }

    fn session_url(&self) -> Result<String> {
        let driver = self
            .driver
            .as_ref()
            .ok_or("ChromeDriver가 준비되지 않았습니다.")?;
        Ok(format!(
            "{}/session/{}",
            driver.url,
            driver.session.as_deref().ok_or("Chrome 세션이 없습니다.")?
        ))
    }

    async fn execute(&self, script: &str) -> Result<Value> {
        request(
            self.client
                .post(format!("{}/execute/sync", self.session_url()?))
                .json(&json!({"script":script,"args":[]})),
        )
        .await
    }

    pub async fn collect(&mut self, emit: impl Fn(BrowserStatus)) -> Result<Vec<Article>> {
        let outcome = self.collect_inner(SOURCE_URL, &emit).await;
        if let Err(error) = &outcome {
            if self.driver.as_ref().is_some_and(|d| d.session.is_none())
                || [
                    "invalid session id",
                    "no such window",
                    "chrome not reachable",
                    "disconnected",
                    "ChromeDriver 요청 실패",
                ]
                .iter()
                .any(|fragment| error.to_lowercase().contains(&fragment.to_lowercase()))
            {
                self.release().await;
            }
            self.status.stage = "error";
            emit(self.status.clone());
        }
        outcome
    }

    async fn collect_inner(
        &mut self,
        source: &str,
        emit: &impl Fn(BrowserStatus),
    ) -> Result<Vec<Article>> {
        self.connect(emit).await?;
        self.status.stage = "navigating";
        emit(self.status.clone());
        let base = self.session_url()?;
        if let Err(error) = request(
            self.client
                .post(format!("{base}/url"))
                .json(&json!({"url":source})),
        )
        .await
        {
            if !error.starts_with("timeout:") {
                return Err(error);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(self.config.wait_seconds);
        loop {
            let page: Page =
                serde_json::from_value(self.execute(INSPECT).await?).map_err(|e| e.to_string())?;
            self.status.title = Some(page.title.chars().take(300).collect());
            self.status.http_status = page.http_status;
            self.status.attention_required = page.challenge_detected;
            if page.has_article_list && !page.challenge_detected && page.url == source {
                self.status.stage = "parsing";
                emit(self.status.clone());
                let source = request(self.client.get(format!("{base}/source"))).await?;
                let articles =
                    parse_articles(source.as_str().ok_or("목록 HTML이 문자열이 아닙니다.")?)?;
                self.status.stage = "idle";
                emit(self.status.clone());
                return Ok(articles);
            }
            self.status.stage = "waiting-for-list";
            emit(self.status.clone());
            if Instant::now() >= deadline {
                let detail = if page.challenge_detected {
                    "사이트 보안 확인이 감지되었습니다."
                } else {
                    "접속 상태나 사이트 HTML 구조를 확인하세요."
                };
                return Err(format!(
                    "게시글 목록을 {}초 동안 확인하지 못했습니다. {detail} (페이지: {}, HTTP: {})",
                    self.config.wait_seconds,
                    self.status.title.as_deref().unwrap_or(""),
                    page.http_status
                        .map_or("알 수 없음".into(), |n| n.to_string())
                ));
            }
            sleep(Duration::from_secs(1)).await;
        }
    }

    async fn release(&mut self) {
        if let Some(mut driver) = self.driver.take() {
            if let Some(session) = &driver.session {
                let _ = self
                    .client
                    .delete(format!("{}/session/{session}", driver.url))
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await;
            }
            let _ = driver.child.kill().await;
        }
        self.status.running = false;
    }

    pub async fn close(&mut self) -> BrowserStatus {
        self.release().await;
        self.status.stage = "closed";
        self.status.attention_required = false;
        self.status.clone()
    }
}

async fn request(builder: reqwest::RequestBuilder) -> Result<Value> {
    let response = builder
        .send()
        .await
        .map_err(|error| format!("ChromeDriver 요청 실패: {error}"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("ChromeDriver 응답 실패: {e}"))?;
    let value = &body["value"];
    if !status.is_success() || value.get("error").is_some() {
        let code = value["error"].as_str().unwrap_or("WebDriver");
        let message = value["message"].as_str().unwrap_or("요청 실패");
        return Err(format!(
            "{code}: {}",
            message.chars().take(600).collect::<String>()
        ));
    }
    Ok(value.clone())
}

fn hidden(binary: &std::path::Path) -> Command {
    let mut cmd = Command::new(binary);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model;
    use axum::{response::Html, routing::get, Router};

    #[tokio::test]
    #[ignore = "requires installed Chrome and an available ChromeDriver"]
    async fn chrome_reads_a_fixture_persists_articles_and_releases_the_driver() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().to_path_buf();
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let target = format!("http://{}/b/hotdeal", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/b/hotdeal",
                    get(|| async { Html(include_str!("../../test/fixtures/hotdeal-list.html")) }),
                ),
            )
            .await
            .unwrap();
        });
        let config = Config {
            directory: data.clone(),
            user_data: data.clone(),
            manager: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources/selenium-manager.exe"),
            chrome_binary: None,
            port: 0,
            max_articles: 100,
            wait_seconds: 10,
            origins: vec![],
            interval_override: None,
            ua_override: None,
        };
        let mut collector = Collector::new(config, "Hotdeal-Local-Smoke/2.0".into());
        let outcome = collector.collect_inner(&target, &|_| {}).await;
        let driver = collector.driver.as_ref().map(|driver| driver.url.clone());
        assert_eq!(
            collector.status.effective_user_agent.as_deref(),
            Some("Hotdeal-Local-Smoke/2.0")
        );
        assert_eq!(collector.close().await.stage, "closed");
        if let Some(driver) = driver {
            assert!(reqwest::get(format!("{driver}/status")).await.is_err());
        }
        let (articles, _) = model::merge_articles(
            &Default::default(),
            outcome.unwrap(),
            model::timestamp(),
            100,
        )
        .unwrap();
        model::write_json(&data.join("articles.json"), &articles).unwrap();
        assert_eq!(model::load_articles(&data, 100).unwrap().total, 4);
        println!("Chrome parsed and saved four fixture posts; its ChromeDriver stopped");
        server.abort();
    }
}

#[cfg(windows)]
mod job {
    use crate::Result;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use tokio::process::Child;
    use windows_sys::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    // Closing the only job handle also reaps Chrome descendants after a crash.
    pub struct Job {
        _handle: OwnedHandle,
    }
    impl Job {
        pub fn attach(child: &Child) -> Result<Self> {
            let process = child
                .raw_handle()
                .ok_or("ChromeDriver 프로세스 핸들이 없습니다.")?;
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let job = Self {
                    _handle: OwnedHandle::from_raw_handle(handle),
                };
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, process as HANDLE) == 0
                {
                    return Err(format!(
                        "Chrome 프로세스 종료 관리를 설정하지 못했습니다: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                Ok(job)
            }
        }
    }
}
