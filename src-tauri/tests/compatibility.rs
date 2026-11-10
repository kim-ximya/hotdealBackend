use hotdeal_collector::{
    core::{Core, Event},
    model::{self, Article, Articles, Config, Interests, NewArticles},
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const LIST: &str = include_str!("../../test/fixtures/hotdeal-list.html");
const HYBRID: &str = include_str!("../../test/fixtures/hotdeal-hybrid.html");
const AT: &str = "2026-10-12T08:24:14.000Z";

fn config(path: &Path) -> Config {
    Config {
        directory: path.join("collector"),
        user_data: path.to_path_buf(),
        manager: path.join("deliberately-missing.exe"),
        chrome_binary: None,
        port: 0,
        max_articles: 10_000,
        wait_seconds: 1,
        origins: vec!["http://localhost:5173".into()],
        interval_override: None,
        ua_override: None,
    }
}

fn with_id(row: &Article, id: &str) -> Article {
    let mut row = row.clone();
    row.id = id.into();
    row.url = format!("{}/{id}", model::SOURCE_URL);
    row
}

fn seed(config: &Config, rows: Vec<Article>) -> Articles {
    let (data, _) =
        model::merge_articles(&Articles::default(), rows, AT.into(), config.max_articles).unwrap();
    model::write_json(&config.directory.join("articles.json"), &data).unwrap();
    data
}

#[test]
fn desktop_and_hybrid_html_match_the_electron_fixtures() {
    let rows = model::parse_articles(LIST).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["100", "300", "299", "298"]
    );
    assert!(rows[0].is_notice);
    assert_eq!(
        serde_json::to_value(&rows[1]).unwrap(),
        json!({
            "id":"300","url":"https://arca.live/b/hotdeal/300","title":"[쇼핑몰] SSD & USB 특가",
            "category":"전자제품","author":"판매정보","createdAt":"2026-10-12T08:10:00Z",
            "views":1234,"recommendations":5,"commentCount":12,"isNotice":false,"isNew":false
        })
    );
    assert_eq!(rows[2].title, "커피 <한정>");
    assert_eq!(rows[2].views, Some(1200));
    assert_eq!(rows[2].comment_count, Some(3));
    assert_eq!(rows[3].author, None);
    let rows = model::parse_articles(HYBRID).unwrap();
    assert_eq!(rows.len(), 3);
    let deals: Vec<_> = rows.iter().filter(|a| !a.is_notice).collect();
    assert_eq!(deals.len(), 1);
    assert_eq!(deals[0].id, "185704738");
    assert_eq!(deals[0].title, "하우스 플리퍼 2");
    assert_eq!(deals[0].author.as_deref(), Some("세리키누스_몬텔라"));
    assert_eq!(deals[0].views, Some(23));
}

#[test]
fn challenge_or_broken_html_cannot_replace_saved_articles() {
    let broken = HYBRID
        .replacen("title hybrid-title", "changed-title", 1)
        .replacen("vcol col-title", "changed-column", 1);
    for html in [
        "",
        "<h1>Just a moment...</h1>",
        "<form>로그인</form>",
        &broken,
    ] {
        assert!(model::parse_articles(html).is_err());
    }
    assert!(model::parse_articles(&"한".repeat(350_000)).is_err());
    assert!(model::parse_articles(
        r#"<div class="article-list"><div class="list-table"></div></div>"#
    )
    .unwrap()
    .is_empty());
    let rows = model::parse_articles(r#"<div class="article-list"><div class="list-table">
        <a class="vrow notice" href="/b/hotdeal/1"><span class="title">공지</span><span class="col-author"> *운영자</span></a>
        <a class="vrow" href="/b/hotdeal/2"><span class="title">일반 글</span><span class="col-author">일반*작성자</span></a>
        </div></div>"#).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "2");
}

#[test]
fn v1_snapshot_loads_and_new_tags_rotate_only_for_retained_articles() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    let initial = model::parse_articles(LIST).unwrap();
    let baseline = seed(&cfg, initial.clone());
    let mut old = serde_json::to_value(&baseline).unwrap();
    for row in old["articles"].as_array_mut().unwrap() {
        row.as_object_mut().unwrap().remove("isNew");
    }
    model::write_json(&cfg.directory.join("articles.json"), &old).unwrap();
    let loaded = model::load_articles(&cfg.directory, 3).unwrap();
    assert!(loaded.articles.iter().all(|a| !a.is_new));
    let (same, _) =
        model::merge_articles(&baseline, initial.clone(), "2026-10-12T08:25:00Z".into(), 4)
            .unwrap();
    assert!(same.articles.iter().all(|a| a.is_new));
    let new = with_id(&initial[1], "900719925474099300001");
    let (updated, committed) = model::merge_articles(
        &same,
        vec![new.clone(), initial[1].clone()],
        "2026-10-12T08:26:00Z".into(),
        4,
    )
    .unwrap();
    assert_eq!(updated.articles[0].id, new.id);
    assert!(updated.articles[0].is_new);
    assert!(updated.articles[1..].iter().all(|a| !a.is_new));
    assert_eq!(updated.articles[1].first_seen_at.as_deref(), Some(AT));
    assert_eq!(committed.len(), 2);
    model::write_json(&cfg.directory.join("articles.json"), &updated).unwrap();
    assert!(model::load_articles(&cfg.directory, 4).unwrap().articles[0].is_new);
    let (unchanged, _) =
        model::merge_articles(&updated, vec![with_id(&new, "1")], AT.into(), 4).unwrap();
    assert!(unchanged.articles[0].is_new);
}

#[test]
fn notification_baseline_and_interest_matching_are_independent_of_new_tags() {
    let rows = model::parse_articles(LIST).unwrap();
    let mut tracker = NewArticles::default();
    assert!(tracker.observe(&rows).is_empty());
    let notice = with_id(&rows[0], "9999");
    let next = with_id(&rows[1], "301");
    assert_eq!(
        tracker.observe(&[notice, next.clone(), next.clone()])[0].id,
        "301"
    );
    assert!(tracker.observe(&[next, rows[1].clone()]).is_empty());
    let interests = Interests {
        keywords: vec![" ＳＳＤ ".into(), "ssd".into(), "한정   쿠폰".into()],
        notify_only_matches: true,
    }
    .normalize()
    .unwrap();
    assert_eq!(interests.keywords, ["SSD", "한정 쿠폰"]);
    assert!(interests.matches("신규 ssd 2TB"));
    assert!(interests.matches("한정  쿠폰"));
    assert!(!interests.matches("쿠폰 한정"));
    assert!(model::user_agent("invalid\r\nheader").is_err());
}

#[tokio::test]
async fn settings_and_interest_pagination_survive_restart_without_a_crawl() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(LIST).unwrap());
    let core = Core::new(cfg.clone());
    core.set_interval(42).await.unwrap();
    core.set_user_agent(" Chrome test ").await.unwrap();
    core.set_interests(Interests {
        keywords: vec!["커피".into()],
        notify_only_matches: true,
    })
    .unwrap();
    let restored = Core::new(cfg);
    assert_eq!(restored.snapshot()["intervalSeconds"], 42);
    assert_eq!(restored.snapshot()["userAgent"], "Chrome test");
    let page = restored.list(1, 0, true).await.unwrap();
    assert_eq!(page["articles"][0]["id"], "299");
    assert_eq!(page["allTotal"], 4);
    assert_eq!(page["total"], 1);
    assert_eq!(page["source"], "file");
    assert_eq!(restored.status().attempts, 0);
    for i in 0..510 {
        restored.log("browser", i.to_string());
    }
    assert_eq!(restored.logs()["logs"].as_array().unwrap().len(), 500);
    assert!(restored.clear_logs()["logs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn corrupt_state_is_not_overwritten_by_startup() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    std::fs::create_dir(&cfg.directory).unwrap();
    let path = cfg.directory.join("articles.json");
    std::fs::write(&path, "broken").unwrap();
    let core = Core::new(cfg);
    assert_eq!(core.snapshot()["phase"], "error");
    assert!(core.start(false).await.is_err());
    assert!(core.list(1, 0, false).await.is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
}

#[tokio::test]
async fn api_preserves_pagination_mutations_validation_and_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(LIST).unwrap());
    let core = Core::new(cfg.clone());
    let mut events = core.subscribe();
    let snapshot = core.start(false).await.unwrap();
    let base = snapshot["baseUrl"].as_str().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let req = |path: &str| format!("{base}{path}");
    let page: Value = client
        .get(req("/api/articles?limit=2&offset=1"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page["returnedCount"], 2);
    assert_eq!(page["articles"][0]["id"], "299");
    assert_eq!(page["total"], 4);
    assert_eq!(
        client
            .get(req("/api/articles?limit=0"))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .get(req("/api/status"))
            .header("Host", "invalid.local")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(req("/api/status"))
            .header("Origin", "http://invalid.local")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let cors = client
        .get(req("/api/status"))
        .header("Origin", "http://localhost:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(
        cors.headers()["access-control-allow-origin"],
        "http://localhost:5173"
    );
    assert_eq!(
        client
            .put(req("/api/settings"))
            .json(&json!({"intervalSeconds":61}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(core.status().interval_seconds, 61);
    assert_eq!(
        client
            .post(req("/api/collect"))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    assert_eq!(
        client
            .post(req("/api/collect"))
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        415
    );
    assert_eq!(
        client
            .post(req("/api/collect"))
            .header("Content-Type", "application/json")
            .body(" ".repeat(4097))
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while core.status().last_error.is_none() {
        tokio::time::timeout_at(deadline, events.recv())
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(core.status().article_count, 4);
    assert_eq!(core.status().last_success_at.as_deref(), Some(AT));
    assert!(matches!(
        events.try_recv(),
        Ok(Event::Changed | Event::Logs) | Err(_)
    ));
    assert_eq!(core.stop().await.unwrap()["phase"], "stopped");
    assert!(client.get(req("/api/status")).send().await.is_err());
    assert_eq!(Core::new(cfg).status().interval_seconds, 61);
}

#[tokio::test]
async fn attaching_to_a_compatible_external_api_does_not_stop_it_or_change_its_ua() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(LIST).unwrap());
    let server = Core::new(cfg.clone());
    let owned = server.start(false).await.unwrap();
    let mut other = cfg;
    other.port = url::Url::parse(owned["baseUrl"].as_str().unwrap())
        .unwrap()
        .port()
        .unwrap();
    other.directory = temp.path().join("separate");
    let client = Core::new(other);
    let external = client.start(true).await.unwrap();
    assert_eq!(external["owned"], false);
    assert!(client.set_user_agent("new value").await.is_err());
    assert_eq!(client.list(1, 0, false).await.unwrap()["total"], 4);
    client.set_interval(67).await.unwrap();
    assert_eq!(server.status().interval_seconds, 67);
    client.stop().await.unwrap();
    assert!(server.status().running);
    assert_eq!(server.list(1, 0, false).await.unwrap()["total"], 4);
    server.stop().await.unwrap();
}

#[tokio::test]
async fn independent_local_collectors_cannot_write_the_same_directory() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    let first = Core::new(cfg.clone());
    first.start(false).await.unwrap();
    let second = Core::new(cfg);
    assert!(second
        .start(false)
        .await
        .unwrap_err()
        .contains("같은 저장 폴더"));
    first.stop().await.unwrap();
    second.start(false).await.unwrap();
    second.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires installed Chrome and access to the hotdeal channel"]
async fn live_collection_writes_json_and_stops_its_browser() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(temp.path());
    cfg.manager = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/selenium-manager.exe");
    cfg.wait_seconds = 20;
    cfg.ua_override = std::env::var("HOTDEAL_SMOKE_USER_AGENT")
        .ok()
        .map(|value| model::user_agent(&value).unwrap());
    let data = cfg.directory.clone();
    let core = Core::new(cfg);
    let mut events = core.subscribe();
    let start = core.start(false).await.unwrap();
    let base = start["baseUrl"].as_str().unwrap().to_owned();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(100);
    let terminal = loop {
        let status = core.status();
        if status.successes > 0 || status.last_error.is_some() {
            break Some(status);
        }
        if tokio::time::timeout_at(deadline, events.recv())
            .await
            .is_err()
        {
            break None;
        }
    };
    core.stop().await.unwrap();
    assert!(!core.status().running);
    assert_eq!(core.status().browser["stage"], "closed");
    assert!(reqwest::get(format!("{base}/api/status")).await.is_err());
    let terminal = terminal.expect("live collection timed out");
    assert!(
        terminal.successes > 0,
        "live collection failed: {:?}",
        terminal.last_error
    );
    let articles = model::load_articles(&data, 10000).unwrap();
    assert!(articles.total > 0);
    println!(
        "stored {} posts; browser and local API stopped",
        articles.total
    );
}
