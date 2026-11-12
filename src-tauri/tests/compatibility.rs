use hotdeal_collector::{
    core::{Core, Event},
    model::{self, Article, Articles, Config, Interests, NewArticles, NotificationSettings},
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
    assert_eq!(deals[0].price.as_deref(), Some("21,000원"));
    assert_eq!(deals[0].store.as_deref(), Some("스팀"));
    assert_eq!(deals[0].shipping.as_deref(), Some("무료"));
    assert_eq!(
        deals[0].thumbnail_url.as_deref(),
        Some("https://arca.live/example-preview.png")
    );
    assert!(rows[0].price.is_none());
    assert!(rows[0].thumbnail_url.is_none());
}

#[tokio::test]
async fn deal_metadata_survives_storage_and_is_exposed_by_the_api() {
    use sha2::{Digest, Sha256};
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(HYBRID).unwrap());
    let cache = cfg.directory.join("thumbnails");
    std::fs::create_dir(&cache).unwrap();
    let file = format!(
        "185704738-{:x}.img",
        Sha256::digest("arca.live/example-preview.png")
    );
    let bytes = [0xff, 0xd8, 0xff, 0xd9];
    std::fs::write(cache.join(file), bytes).unwrap();

    let core = Core::new(cfg);
    let saved = core.list(10, 0, false, None).await.unwrap();
    assert_eq!(saved["articles"][0]["store"], "스팀");
    let snapshot = core.start(false).await.unwrap();
    let base = snapshot["baseUrl"].as_str().unwrap();
    let data: Value = reqwest::get(format!("{base}/api/articles?limit=1"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(data["articles"][0]["price"], "21,000원");
    assert_eq!(data["articles"][0]["shipping"], "무료");
    assert_eq!(
        data["articles"][0]["thumbnailUrl"],
        "https://arca.live/example-preview.png"
    );
    let thumbnail = reqwest::get(format!("{base}/api/articles/185704738/thumbnail"))
        .await
        .unwrap();
    assert_eq!(thumbnail.status(), 200);
    assert_eq!(thumbnail.headers()["content-type"], "image/jpeg");
    assert_eq!(&thumbnail.bytes().await.unwrap()[..], &bytes);
    assert_eq!(
        reqwest::get(format!("{base}/api/articles/100/thumbnail"))
            .await
            .unwrap()
            .status(),
        404
    );
    core.stop().await.unwrap();
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
    let page = restored.list(1, 0, true, None).await.unwrap();
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
async fn desktop_category_and_interest_filters_run_before_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    let fixture = model::parse_articles(LIST).unwrap();
    let mut rows = Vec::new();
    for (id, category, title) in [
        ("500", Some(" 바이럴 "), "SSD 광고"),
        ("499", Some("전자제품"), "SSD 케이스"),
        ("498", Some("PC/하드웨어"), "SSD 2TB"),
        ("497", Some("PC/하드웨어"), "메모리"),
        ("496", None, "기존 게시글"),
    ] {
        let mut row = with_id(&fixture[1], id);
        row.category = category.map(str::to_owned);
        row.title = title.into();
        rows.push(row);
    }
    seed(&cfg, rows);
    let core = Core::new(cfg.clone());
    core.set_interests(Interests {
        keywords: vec!["SSD".into()],
        notify_only_matches: false,
    })
    .unwrap();

    for source in ["file", "api"] {
        if source == "api" {
            core.start(false).await.unwrap();
        }
        let all = core.list(10, 0, false, None).await.unwrap();
        assert_eq!(all["source"], source);
        assert_eq!(all["total"], 4);
        assert_eq!(all["articles"][0]["id"], "499");
        assert_eq!(all["articles"][3]["id"], "496");

        let category = core.list(1, 1, false, Some("PC/하드웨어")).await.unwrap();
        assert_eq!(category["total"], 2);
        assert_eq!(category["allTotal"], 4);
        assert_eq!(category["articles"][0]["id"], "497");

        let both = core.list(10, 0, true, Some("PC/하드웨어")).await.unwrap();
        assert_eq!(both["total"], 1);
        assert_eq!(both["articles"][0]["id"], "498");
        assert_eq!(
            core.list(10, 0, false, Some("바이럴")).await.unwrap()["total"],
            0
        );
    }
    core.stop().await.unwrap();
    assert_eq!(
        model::load_articles(&cfg.directory, cfg.max_articles)
            .unwrap()
            .total,
        5
    );
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
    assert!(core.list(1, 0, false, None).await.is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
    assert_eq!(core.reset_articles().await.unwrap()["phase"], "stopped");
    assert!(!path.exists());
    assert_eq!(core.list(1, 0, false, None).await.unwrap()["total"], 0);
}

#[tokio::test]
async fn article_reset_requires_exclusive_access_and_clears_only_collected_data() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(HYBRID).unwrap());
    let core = Core::new(cfg.clone());
    core.set_interval(75).await.unwrap();
    core.set_user_agent("Chrome test").await.unwrap();
    let cache = cfg.directory.join("thumbnails");
    std::fs::create_dir(&cache).unwrap();
    let thumbnail = cache.join(format!("185704738-{}.img", "a".repeat(64)));
    let other_file = cache.join("notes.txt");
    std::fs::write(&thumbnail, b"cached thumbnail").unwrap();
    std::fs::write(&other_file, b"keep").unwrap();
    let articles = cfg.directory.join("articles.json");

    core.start(false).await.unwrap();
    assert!(core
        .reset_articles()
        .await
        .unwrap_err()
        .contains("수집 서버를 중지"));
    let other = Core::new(cfg.clone());
    assert!(other
        .reset_articles()
        .await
        .unwrap_err()
        .contains("같은 저장 폴더"));
    assert!(articles.is_file());
    assert!(thumbnail.is_file());
    core.stop().await.unwrap();

    let snapshot = core.reset_articles().await.unwrap();
    assert_eq!(snapshot["articleResetRevision"], 1);
    assert_eq!(snapshot["localArticleCount"], 0);
    assert_eq!(snapshot["status"]["articleCount"], 0);
    assert!(snapshot["status"]["lastSuccessAt"].is_null());
    assert!(!articles.exists());
    assert!(!thumbnail.exists());
    assert_eq!(std::fs::read(&other_file).unwrap(), b"keep");
    let restored = Core::new(cfg);
    assert_eq!(restored.snapshot()["intervalSeconds"], 75);
    assert_eq!(restored.snapshot()["userAgent"], "Chrome test");
    assert_eq!(restored.list(10, 0, false, None).await.unwrap()["total"], 0);
    assert_eq!(
        restored.reset_articles().await.unwrap()["localArticleCount"],
        0
    );
}

#[tokio::test]
async fn notification_volume_loads_old_settings_and_rejects_invalid_values() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    let path = cfg.user_data.join("notification-settings.json");
    std::fs::write(&path, r#"{"enabled":false,"soundEnabled":true}"#).unwrap();
    let core = Core::new(cfg.clone());
    assert_eq!(
        core.notifications().volume,
        NotificationSettings::default().volume
    );
    let mut settings = core.set_notification_volume(28).unwrap();
    assert!(!settings.enabled && settings.sound_enabled);
    assert_eq!(Core::new(cfg.clone()).notifications().volume, 28);
    assert_eq!(
        core.settings_backup().await.unwrap()["notifications"]["volume"],
        28
    );
    settings.volume = 101;
    assert!(core.set_notifications(settings).is_err());
    assert!(core.set_notification_volume(101).is_err());
    assert_eq!(core.notifications().volume, 28);
    assert_eq!(Core::new(cfg).notifications().volume, 28);
}

#[tokio::test]
async fn settings_backup_captures_saved_values_without_mutating_them() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(HYBRID).unwrap());
    let core = Core::new(cfg.clone());
    core.set_interval(75).await.unwrap();
    core.set_user_agent("Custom Chrome").await.unwrap();
    core.set_interests(Interests {
        keywords: vec!["SSD".into()],
        notify_only_matches: true,
    })
    .unwrap();
    core.set_notifications(NotificationSettings {
        enabled: true,
        sound_enabled: false,
        volume: 43,
    })
    .unwrap();
    let before = core.snapshot();
    let articles = std::fs::read(cfg.directory.join("articles.json")).unwrap();
    let settings = core.settings_backup().await.unwrap();
    assert_eq!(
        settings,
        json!({
            "collection": {"intervalSeconds":75,"userAgent":"Custom Chrome"},
            "interests": {"keywords":["SSD"],"notifyOnlyMatches":true},
            "notifications": {"enabled":true,"soundEnabled":false,"volume":43},
            "backup": {"directory":null},
        })
    );
    assert_eq!(core.snapshot(), before);
    assert_eq!(
        std::fs::read(cfg.directory.join("articles.json")).unwrap(),
        articles
    );
    std::fs::write(cfg.directory.join("settings.json"), "broken").unwrap();
    assert!(core.settings_backup().await.is_err());
}

#[tokio::test]
async fn choosing_a_backup_directory_only_saves_the_location_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    let default = temp.path().join("install");
    let selected = temp.path().join("selected");
    std::fs::create_dir(&selected).unwrap();
    let core = Core::new(cfg.clone());
    assert_eq!(core.backup_directory(&default).unwrap(), default);
    core.set_backup_directory(&selected).unwrap();
    assert_eq!(core.backup_directory(&default).unwrap(), selected);
    assert_eq!(std::fs::read_dir(&selected).unwrap().count(), 0);
    let restored = Core::new(cfg);
    assert_eq!(restored.backup_directory(&default).unwrap(), selected);
    assert_eq!(
        restored.settings_backup().await.unwrap()["backup"]["directory"],
        json!(selected)
    );
    assert!(restored
        .set_backup_directory(&temp.path().join("missing"))
        .is_err());
    assert_eq!(restored.backup_directory(&default).unwrap(), selected);
    assert!(restored.reset_settings().await.unwrap().is_empty());
    assert_eq!(restored.backup_directory(&default).unwrap(), default);
}

#[tokio::test]
async fn settings_reset_reuses_first_run_defaults_and_preserves_collected_data() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    seed(&cfg, model::parse_articles(HYBRID).unwrap());
    let article_path = cfg.directory.join("articles.json");
    let article_bytes = std::fs::read(&article_path).unwrap();
    let cache = cfg.directory.join("thumbnails");
    std::fs::create_dir(&cache).unwrap();
    let thumbnail = cache.join(format!("185704738-{}.img", "a".repeat(64)));
    std::fs::write(&thumbnail, b"thumbnail").unwrap();

    let core = Core::new(cfg.clone());
    core.set_interval(75).await.unwrap();
    core.set_user_agent("Custom Chrome").await.unwrap();
    core.set_interests(Interests {
        keywords: vec!["SSD".into()],
        notify_only_matches: true,
    })
    .unwrap();
    core.set_notifications(NotificationSettings {
        enabled: false,
        sound_enabled: false,
        volume: 17,
    })
    .unwrap();

    core.start(false).await.unwrap();
    assert!(core
        .reset_settings()
        .await
        .unwrap_err()
        .contains("수집 서버를 중지"));
    let other = Core::new(cfg.clone());
    assert!(other
        .reset_settings()
        .await
        .unwrap_err()
        .contains("같은 저장 폴더"));
    assert_eq!(core.snapshot()["intervalSeconds"], 75);
    assert_eq!(core.interests()["keywords"], json!(["SSD"]));
    core.stop().await.unwrap();

    assert!(core.reset_settings().await.unwrap().is_empty());
    for instance in [core, Core::new(cfg)] {
        assert_eq!(
            instance.snapshot()["intervalSeconds"],
            model::DEFAULT_INTERVAL_SECONDS
        );
        assert_eq!(instance.snapshot()["userAgent"], "");
        assert_eq!(
            instance.interests(),
            json!({"keywords": [], "notifyOnlyMatches": false, "error": null})
        );
        let notifications = instance.notifications();
        assert!(notifications.enabled && notifications.sound_enabled);
        assert_eq!(notifications.volume, NotificationSettings::default().volume);
    }
    assert_eq!(std::fs::read(&article_path).unwrap(), article_bytes);
    assert_eq!(std::fs::read(&thumbnail).unwrap(), b"thumbnail");
}

#[tokio::test]
async fn settings_reset_reports_file_errors_and_can_be_retried() {
    let temp = tempfile::tempdir().unwrap();
    let cfg = config(temp.path());
    std::fs::create_dir(&cfg.directory).unwrap();
    std::fs::write(cfg.directory.join("settings.json"), "broken").unwrap();
    std::fs::write(cfg.user_data.join("interest-settings.json"), "broken").unwrap();
    let blocked = cfg.user_data.join("notification-settings.json");
    std::fs::create_dir(&blocked).unwrap();
    let core = Core::new(cfg);
    assert_eq!(core.snapshot()["phase"], "error");

    let errors = core.reset_settings().await.unwrap();
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("알림 초기화 실패"));
    assert!(blocked.is_dir());
    assert_eq!(core.snapshot()["phase"], "stopped");
    assert!(core.interests()["error"].is_null());
    assert!(!core.notifications().enabled);

    std::fs::remove_dir(blocked).unwrap();
    assert!(core.reset_settings().await.unwrap().is_empty());
    assert!(core.notifications().enabled);
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
    let mut rows = model::parse_articles(LIST).unwrap();
    let mut viral = with_id(&rows[1], "400");
    viral.category = Some("바이럴".into());
    rows.push(viral);
    seed(&cfg, rows);
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
    assert_eq!(client.list(1, 0, false, None).await.unwrap()["total"], 4);
    let category = client.list(1, 0, false, Some("식품")).await.unwrap();
    assert_eq!(category["articles"][0]["id"], "299");
    client.set_interval(67).await.unwrap();
    assert_eq!(server.status().interval_seconds, 67);
    assert_eq!(
        client.settings_backup().await.unwrap()["collection"]["intervalSeconds"],
        model::DEFAULT_INTERVAL_SECONDS
    );
    client.stop().await.unwrap();
    assert!(server.status().running);
    assert_eq!(server.list(1, 0, false, None).await.unwrap()["total"], 4);
    assert_eq!(server.api_articles(1, 0)["total"], 5);
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
    let fields = articles
        .articles
        .iter()
        .filter(|row| row.price.is_some() && row.store.is_some() && row.shipping.is_some())
        .count();
    let cached = std::fs::read_dir(data.join("thumbnails"))
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    println!("deal fields: {fields}; cached thumbnails: {cached}");
    assert!(fields > 0 && cached > 0);
    println!(
        "stored {} posts; browser and local API stopped",
        articles.total
    );
}
