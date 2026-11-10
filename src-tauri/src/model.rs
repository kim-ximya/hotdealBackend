use crate::Result;
use chrono::{DateTime, Utc};
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
};
use unicode_normalization::UnicodeNormalization;
use url::Url;

pub const SOURCE_URL: &str = "https://arca.live/b/hotdeal";
pub const CHANNEL: &str = "/b/hotdeal";
pub const MAX_HTML_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Config {
    pub directory: PathBuf,
    pub user_data: PathBuf,
    pub manager: PathBuf,
    pub chrome_binary: Option<String>,
    pub port: u16,
    pub max_articles: usize,
    pub wait_seconds: u64,
    pub origins: Vec<String>,
    pub interval_override: Option<u64>,
    pub ua_override: Option<String>,
}

impl Config {
    pub fn load(
        root: &Path,
        user_data: PathBuf,
        default_data: PathBuf,
        manager: PathBuf,
        cli: bool,
    ) -> Result<Self> {
        let env = |key: &str| std::env::var(key).ok();
        let number = |key: &str, default, min, max| -> Result<u64> {
            env(key).map_or(Ok(default), |v| {
                v.trim()
                    .parse()
                    .ok()
                    .filter(|n| (min..=max).contains(n))
                    .ok_or_else(|| format!("{key}는 {min}~{max} 사이의 정수여야 합니다."))
            })
        };
        let origins = env("FRONTEND_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        for origin in &origins {
            if !Url::parse(origin).ok().is_some_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.origin().ascii_serialization() == *origin
            }) {
                return Err(format!(
                    "FRONTEND_ORIGINS에 정확한 HTTP(S) 출처가 필요합니다: {origin}"
                ));
            }
        }
        let directory = env("DATA_DIR")
            .filter(|s| !s.is_empty())
            .map_or(default_data, |s| root.join(s));
        let directory = if directory.is_absolute() {
            directory
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(directory)
        };
        Ok(Self {
            directory,
            user_data,
            manager: env("SE_MANAGER_PATH").map_or(manager, |s| root.join(s)),
            chrome_binary: env("SELENIUM_CHROME_BINARY").filter(|s| !s.is_empty()),
            port: number("PORT", 38471, 0, 65535)? as u16,
            max_articles: number("MAX_ARTICLES", 10000, 1, 100000)? as usize,
            wait_seconds: number("SELENIUM_WAIT_SECONDS", 120, 1, 600)?,
            origins,
            interval_override: if cli && env("CRAWL_INTERVAL_SECONDS").is_some() {
                Some(number("CRAWL_INTERVAL_SECONDS", 180, 1, 86400)?)
            } else {
                None
            },
            ua_override: if cli {
                env("SELENIUM_USER_AGENT")
                    .map(|s| user_agent(&s))
                    .transpose()?
            } else {
                None
            },
        })
    }
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{} 읽기 실패: {error}", path.display())),
    };
    let limit = if path.file_name().is_some_and(|name| name == "articles.json") {
        64 * 1024 * 1024
    } else {
        1024 * 1024
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err(format!("{} 파일이 너무 큽니다.", path.display()));
    }
    serde_json::from_reader(file).map(Some).map_err(|error| {
        format!(
            "{} 읽기 실패. 기존 파일을 보존합니다: {error}",
            path.display()
        )
    })
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("저장 폴더가 없습니다.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.write_all(b"\n")
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

pub fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn valid_id(id: &str) -> bool {
    (1..=30).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}
pub fn valid_interval(value: u64) -> bool {
    (1..=86400).contains(&value)
}
pub fn user_agent(value: &str) -> Result<String> {
    if value.len() > 1024 || !value.bytes().all(|b| (32..=126).contains(&b)) {
        return Err(
            "User-Agent는 개행 없이 영문·숫자·기호로 된 1024자 이하의 문자열이어야 합니다.".into(),
        );
    }
    Ok(value.trim().to_owned())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: String,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub category: Option<String>,
    pub created_at: Option<String>,
    pub views: Option<i64>,
    pub recommendations: Option<i64>,
    pub comment_count: Option<i64>,
    #[serde(default)]
    pub is_notice: bool,
    #[serde(default)]
    pub is_new: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
}

impl Article {
    fn valid(&self) -> bool {
        valid_id(&self.id)
            && self.url == format!("{SOURCE_URL}/{}", self.id)
            && !self.title.trim().is_empty()
    }
    pub fn staff(&self) -> bool {
        self.author
            .as_deref()
            .is_some_and(|s| s.trim().starts_with('*'))
    }
    pub fn numeric_id(&self) -> u128 {
        self.id.parse().unwrap_or(0)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Articles {
    pub schema_version: u8,
    pub channel: String,
    pub source_url: String,
    pub updated_at: Option<String>,
    pub latest_count: usize,
    pub total: usize,
    pub articles: Vec<Article>,
}

impl Default for Articles {
    fn default() -> Self {
        Self {
            schema_version: 1,
            channel: CHANNEL.into(),
            source_url: SOURCE_URL.into(),
            updated_at: None,
            latest_count: 0,
            total: 0,
            articles: vec![],
        }
    }
}

pub fn load_articles(directory: &Path, max: usize) -> Result<Articles> {
    let Some(mut data) = read_json::<Articles>(&directory.join("articles.json"))? else {
        return Ok(Articles::default());
    };
    if data.schema_version != 1
        || data.channel != CHANNEL
        || data.source_url != SOURCE_URL
        || !data
            .updated_at
            .as_ref()
            .is_some_and(|s| DateTime::parse_from_rfc3339(s).is_ok())
        || !data.articles.iter().all(Article::valid)
    {
        return Err("저장된 게시글 JSON 형식이 올바르지 않습니다. 기존 파일을 보존합니다.".into());
    }
    let unique: BTreeMap<_, _> = data
        .articles
        .drain(..)
        .map(|row| (row.id.clone(), row))
        .collect();
    data.articles = unique.into_values().filter(|row| !row.staff()).collect();
    data.articles
        .sort_by_key(|row| std::cmp::Reverse(row.numeric_id()));
    data.articles.truncate(max);
    data.total = data.articles.len();
    Ok(data)
}

pub fn merge_articles(
    data: &Articles,
    rows: Vec<Article>,
    at: String,
    max: usize,
) -> Result<(Articles, Vec<Article>)> {
    if !rows.iter().all(Article::valid) {
        return Err("수집된 게시글 형식이 올바르지 않습니다.".into());
    }
    let previous: BTreeMap<_, _> = data
        .articles
        .iter()
        .map(|a| (a.id.clone(), a.clone()))
        .collect();
    let mut merged = previous.clone();
    let latest: BTreeMap<_, _> = rows.into_iter().map(|a| (a.id.clone(), a)).collect();
    for (id, row) in &latest {
        if row.staff() {
            merged.remove(id);
            continue;
        }
        let mut row = row.clone();
        let old = previous.get(id);
        row.is_new = old.is_some_and(|a| a.is_new);
        row.first_seen_at = old
            .and_then(|a| a.first_seen_at.clone())
            .or_else(|| Some(at.clone()));
        row.last_seen_at = Some(at.clone());
        merged.insert(id.clone(), row);
    }
    let mut articles: Vec<_> = merged.into_values().collect();
    articles.sort_by_key(|a| std::cmp::Reverse(a.numeric_id()));
    articles.truncate(max);
    if articles.iter().any(|a| !previous.contains_key(&a.id)) {
        for a in &mut articles {
            a.is_new = !previous.contains_key(&a.id);
        }
    }
    let committed = articles
        .iter()
        .filter(|a| latest.contains_key(&a.id))
        .cloned()
        .collect();
    Ok((
        Articles {
            updated_at: Some(at),
            latest_count: latest.values().filter(|a| !a.staff()).count(),
            total: articles.len(),
            articles,
            ..Articles::default()
        },
        committed,
    ))
}

#[derive(Default)]
pub struct NewArticles {
    initialized: bool,
    highest: Option<u128>,
}
impl NewArticles {
    pub fn observe(&mut self, rows: &[Article]) -> Vec<Article> {
        let initialized = std::mem::replace(&mut self.initialized, true);
        let mut unique = HashSet::new();
        let mut eligible: Vec<_> = rows
            .iter()
            .filter(|a| a.valid() && !a.staff() && !a.is_notice && unique.insert(a.id.as_str()))
            .collect();
        eligible.sort_by_key(|a| std::cmp::Reverse(a.numeric_id()));
        let prior = self.highest;
        if let Some(top) = eligible.first() {
            self.highest = Some(prior.unwrap_or(0).max(top.numeric_id()));
        }
        if !initialized {
            return vec![];
        }
        eligible
            .into_iter()
            .filter(|a| prior.is_none_or(|n| a.numeric_id() > n))
            .cloned()
            .collect()
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interests {
    pub keywords: Vec<String>,
    pub notify_only_matches: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub sound_enabled: bool,
}
impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            sound_enabled: true,
        }
    }
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn key(value: &str) -> String {
    clean(&value.nfkc().collect::<String>().to_lowercase())
}
impl Interests {
    pub fn normalize(mut self) -> Result<Self> {
        if self.keywords.len() > 100 {
            return Err("관심 품목은 최대 100개까지 등록할 수 있습니다.".into());
        }
        let mut seen = HashSet::new();
        let mut keywords = Vec::new();
        for word in self.keywords {
            if word.chars().any(|c| c.is_control()) {
                return Err("관심 품목에는 제어 문자를 넣을 수 없습니다.".into());
            }
            let word = clean(&word.nfkc().collect::<String>());
            if !(1..=80).contains(&word.encode_utf16().count()) {
                return Err("관심 품목은 1~80자로 입력하세요.".into());
            }
            if seen.insert(key(&word)) {
                keywords.push(word);
            }
        }
        self.keywords = keywords;
        Ok(self)
    }
    pub fn matches(&self, title: &str) -> bool {
        let title = key(title);
        self.keywords.iter().any(|word| title.contains(&key(word)))
    }
}

static COUNT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(-?\d+(?:\.\d+)?)([kKmM만]?)$").unwrap());
fn number(value: Option<String>) -> Option<i64> {
    let value: String = value?
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, ',' | '[' | ']'))
        .collect();
    let matched = COUNT.captures(&value)?;
    let multiplier = match &matched[2] {
        "k" | "K" => 1_000.,
        "m" | "M" => 1_000_000.,
        "만" => 10_000.,
        _ => 1.,
    };
    let n = matched[1].parse::<f64>().ok()? * multiplier;
    (n.fract() == 0. && n.abs() <= 9_007_199_254_740_991.).then_some(n as i64)
}
fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("static CSS selector")
}
fn text(element: ElementRef<'_>) -> Option<String> {
    let value = clean(&element.text().collect::<String>());
    (!value.is_empty()).then_some(value)
}
fn first<'a>(row: ElementRef<'a>, css: &str) -> Option<ElementRef<'a>> {
    row.select(&selector(css)).next()
}
fn id_from(element: ElementRef<'_>) -> Option<String> {
    let url = Url::parse(SOURCE_URL)
        .ok()?
        .join(element.attr("href")?)
        .ok()?;
    let id = url
        .path()
        .strip_prefix("/b/hotdeal/")?
        .trim_end_matches('/');
    (url.origin().ascii_serialization() == "https://arca.live" && valid_id(id))
        .then(|| id.to_owned())
}

pub fn parse_articles(html: &str) -> Result<Vec<Article>> {
    if html.trim().is_empty() || html.len() > MAX_HTML_BYTES {
        return Err("게시글 목록 HTML이 비었거나 1 MiB를 초과합니다.".into());
    }
    let doc = Html::parse_document(html);
    let table = doc
        .select(&selector(".article-list .list-table"))
        .next()
        .ok_or(
        "게시글 목록 영역을 찾지 못했습니다. 보안 확인·로그인 화면 또는 HTML 구조를 확인하세요.",
    )?;
    let mut articles = Vec::new();
    let (mut seen, mut missing) = (HashSet::new(), HashSet::new());
    let mut row_count = 0;
    let ignore = selector(".badges, .badge, .deal-store, .category, .info, .media-icon, .comment-count, .col-comment, .icons, .icon, i, svg, script, style");
    for row in table.select(&selector(".vrow:not(.head, .notice-unfilter)")) {
        row_count += 1;
        let id = if row.value().name() == "a" {
            id_from(row)
        } else {
            row.select(&selector("a.title[href], .col-title a[href]"))
                .find_map(id_from)
        };
        let Some(id) = id else {
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        let is_notice = row
            .value()
            .classes()
            .any(|c| matches!(c, "notice" | "notice-service"));
        let raw = first(row, ".title:not(.hybrid-bottom, .preview-image)")
            .or_else(|| first(row, ".col-title"));
        let title = raw
            .map(|root| {
                let content: String = root
                    .descendants()
                    .filter_map(|node| {
                        let data = node.value().as_text()?;
                        let excluded = node
                            .ancestors()
                            .take_while(|ancestor| ancestor.id() != root.id())
                            .filter_map(ElementRef::wrap)
                            .any(|element| ignore.matches(&element));
                        (!excluded).then_some(data.text.as_ref())
                    })
                    .collect();
                clean(&content)
            })
            .unwrap_or_default();
        if title.is_empty() {
            if !is_notice {
                missing.insert(id);
            }
            continue;
        }
        seen.insert(id.clone());
        missing.remove(&id);
        let column = first(row, ".col-time");
        let created_at = first(row, "time[datetime], .col-time time")
            .and_then(|t| t.attr("datetime"))
            .or_else(|| {
                column.and_then(|t| t.attr("data-original-title").or_else(|| t.attr("title")))
            })
            .map(str::to_owned)
            .or_else(|| column.and_then(text));
        articles.push(Article { url: format!("{SOURCE_URL}/{id}"), id, title,
            category: first(row, ".col-title .badge, .title .badge, .category, .badge").and_then(text),
            author: first(row, ".col-author .user-info, .col-author .member-info, .col-author, .user-info, .member-info").and_then(text),
            created_at, views: number(first(row, ".col-view, .col-views").and_then(text)),
            recommendations: number(first(row, ".col-rate, .col-recommend").and_then(text)),
            comment_count: number(first(row, ".comment-count, .col-comment").and_then(text)),
            is_notice, is_new: false, first_seen_at: None, last_seen_at: None,
        });
    }
    if !missing.is_empty() {
        return Err(format!(
            "일반 게시글 {}개의 제목을 추출하지 못했습니다.",
            missing.len()
        ));
    }
    if row_count > 0 && articles.is_empty() {
        return Err("목록에서 게시글을 추출하지 못했습니다.".into());
    }
    articles.retain(|article| !article.staff());
    Ok(articles)
}
