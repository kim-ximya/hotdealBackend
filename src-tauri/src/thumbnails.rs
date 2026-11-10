use crate::model::{valid_id, Article, SOURCE_URL};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;

const MAX_BYTES: usize = 128 * 1024;

pub(crate) struct Thumbnail {
    pub media_type: &'static str,
    pub bytes: Vec<u8>,
}

pub(crate) fn source_url(raw: &str) -> Option<Url> {
    if raw.trim().is_empty() || raw.len() > 2048 {
        return None;
    }
    let mut url = Url::parse(SOURCE_URL).ok()?.join(raw).ok()?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("arca.live" | "ac.arca.live"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

fn filename(id: &str, url: &Url) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    // The CDN rotates query signatures. The same list image keeps its path.
    let identity = format!("{}{}", url.host_str()?, url.path());
    Some(format!("{id}-{:x}.img", Sha256::digest(identity)))
}

fn cache(directory: &Path) -> PathBuf {
    directory.join("thumbnails")
}

fn image(bytes: Vec<u8>) -> Option<Thumbnail> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let media_type = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis")) {
        "image/avif"
    } else {
        return None;
    };
    Some(Thumbnail { media_type, bytes })
}

pub(crate) fn read(directory: &Path, id: &str, source: &str) -> Option<Thumbnail> {
    let url = source_url(source)?;
    let file = fs::File::open(cache(directory).join(filename(id, &url)?)).ok()?;
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    image(bytes)
}

pub(crate) async fn read_response(mut response: reqwest::Response) -> Option<Thumbnail> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > MAX_BYTES - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    image(bytes)
}

pub(crate) async fn collect(
    directory: &Path,
    client: &reqwest::Client,
    agent: &str,
    rows: &[Article],
) {
    let cache = cache(directory);
    let jobs = rows
        .iter()
        .filter_map(|row| {
            let source = source_url(row.thumbnail_url.as_deref()?)?;
            let file = cache.join(filename(&row.id, &source)?);
            (!file.is_file()).then_some((source, file))
        })
        .collect::<Vec<_>>();
    if jobs.is_empty() || fs::create_dir_all(&cache).is_err() {
        return;
    }
    let batch = async {
        let mut tasks = tokio::task::JoinSet::new();
        for (source, file) in jobs {
            if tasks.len() >= 6 {
                let _ = tasks.join_next().await;
            }
            let mut request = client
                .get(source)
                .header(reqwest::header::REFERER, SOURCE_URL);
            if !agent.is_empty() {
                request = request.header(reqwest::header::USER_AGENT, agent);
            }
            let cache = cache.clone();
            tasks.spawn(async move {
                if let Ok(response) = request.send().await {
                    if let Some(thumbnail) = read_response(response).await {
                        if let Ok(mut temporary) = tempfile::NamedTempFile::new_in(cache) {
                            if temporary.write_all(&thumbnail.bytes).is_ok() {
                                let _ = temporary.persist(file);
                            }
                        }
                    }
                }
            });
        }
        while tasks.join_next().await.is_some() {}
    };
    let _ = tokio::time::timeout(Duration::from_secs(8), batch).await;
}

pub(crate) fn prune(directory: &Path, rows: &[Article]) {
    let Ok(entries) = fs::read_dir(cache(directory)) else {
        return;
    };
    let retained: HashSet<_> = rows
        .iter()
        .filter_map(|row| filename(&row.id, &source_url(row.thumbnail_url.as_deref()?)?))
        .collect();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let managed = name
            .strip_suffix(".img")
            .and_then(|stem| stem.split_once('-'))
            .is_some_and(|(id, hash)| {
                valid_id(id) && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
            });
        if managed && !retained.contains(name) && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_arca_thumbnails_and_reuses_cache_when_the_signature_rotates() {
        let first = source_url("//ac.arca.live/a.jpg?expires=1&key=old&type=list").unwrap();
        let second = source_url("https://ac.arca.live/a.jpg?expires=2&key=new&type=list").unwrap();
        assert_ne!(first, second);
        assert_eq!(filename("123", &first), filename("123", &second));
        assert_ne!(filename("123", &first), filename("124", &second));
        assert!(filename("../123", &first).is_none());
        for raw in [
            "https://ac.arca.live.evil.example/a",
            "http://ac.arca.live/a",
            "https://arca.live:444/a",
            "data:image/svg+xml,<svg/>",
            "https://arca.live@other.example/a",
            "https://user@arca.live/a",
        ] {
            assert!(source_url(raw).is_none(), "{raw}");
        }
    }

    #[test]
    fn serves_only_bounded_raster_images() {
        assert_eq!(
            image(b"\xff\xd8\xff\xd9".to_vec()).unwrap().media_type,
            "image/jpeg"
        );
        assert!(image(b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()).is_none());
        let mut oversized = b"\xff\xd8\xff".to_vec();
        oversized.resize(MAX_BYTES + 1, 0);
        assert!(image(oversized).is_none());
    }
}
