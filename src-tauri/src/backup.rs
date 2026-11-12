use crate::{model, Result};
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArticleListPreferences {
    pub columns: Vec<String>,
    pub category: String,
    pub interest_only: bool,
}

impl ArticleListPreferences {
    pub fn validate(&self) -> Result<()> {
        if self.columns.is_empty()
            || self.columns.len() > 64
            || self.columns.iter().any(|name| {
                name.is_empty() || name.len() > 128 || name.chars().any(char::is_control)
            })
            || self.category.len() > 256
            || self.category.chars().any(char::is_control)
        {
            return Err("목록 표시 설정이 올바르지 않습니다.".into());
        }
        Ok(())
    }
}

pub(crate) fn write(directory: &Path, version: &str, settings: Value) -> Result<PathBuf> {
    let document = json!({
        "schemaVersion": 1,
        "appVersion": version,
        "createdAt": model::timestamp(),
        "settings": settings,
    });
    let filename = format!(
        "hotdeal-settings-{}.json",
        Local::now().format("%Y%m%d-%H%M%S-%9f")
    );
    let destination = directory.join(filename);
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, &document).map_err(|e| e.to_string())?;
    file.write_all(b"\n")
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist_noclobber(&destination)
        .map_err(|e| e.error.to_string())?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backups_are_separate_versioned_files_in_the_selected_directory() {
        let directory = tempfile::tempdir().unwrap();
        let preferences = ArticleListPreferences {
            columns: vec!["title".into(), "price".into()],
            category: "PC/하드웨어".into(),
            interest_only: true,
        };
        preferences.validate().unwrap();
        let settings = json!({
            "collection": {"intervalSeconds":75,"userAgent":"test"},
            "articleList": preferences,
        });
        let first = write(directory.path(), "2.1.0", settings.clone()).unwrap();
        let before = std::fs::read(&first).unwrap();
        let second = write(directory.path(), "2.1.0", settings.clone()).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(directory.path()));
        assert_eq!(second.parent(), Some(directory.path()));
        let saved: Value = serde_json::from_slice(&before).unwrap();
        assert_eq!(saved["schemaVersion"], 1);
        assert_eq!(saved["appVersion"], "2.1.0");
        assert_eq!(saved["settings"], settings);
        assert!(chrono::DateTime::parse_from_rfc3339(saved["createdAt"].as_str().unwrap()).is_ok());
        assert_eq!(std::fs::read(first).unwrap(), before);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }
}
