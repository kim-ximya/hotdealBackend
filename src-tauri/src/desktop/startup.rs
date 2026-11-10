use crate::Result;
use serde_json::{json, Value};

pub const ARG: &str = "hotdeal-windows-startup";
#[cfg(windows)]
const NAME: &str = "핫딜 수집 관리자";
#[cfg(windows)]
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

#[cfg(windows)]
fn command() -> Result<String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(format!("\"{}\" {ARG}", executable.display()))
}

#[cfg(windows)]
pub fn read() -> Result<Value> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let own = command()?;
    let registered = user
        .open_subkey(RUN)
        .and_then(|key| key.get_value::<String, _>(NAME))
        .is_ok_and(|value| value.eq_ignore_ascii_case(&own));
    let disabled = registered
        && user
            .open_subkey(APPROVED)
            .and_then(|key| key.get_raw_value(NAME))
            .ok()
            .and_then(|value| value.bytes.first().copied())
            .is_some_and(|flag| matches!(flag, 3 | 7));
    Ok(
        json!({"supported":true,"registered":registered,"enabled":registered && !disabled,"disabledByWindows":disabled}),
    )
}

#[cfg(windows)]
pub fn set(enabled: bool) -> Result<Value> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let own = command()?;
    let (run, _) = user.create_subkey(RUN).map_err(|e| e.to_string())?;
    let previous = run.get_value::<String, _>(NAME).ok();
    if enabled {
        // Use the same display name so the old executable cannot be launched alongside this one.
        run.set_value(NAME, &own).map_err(|e| e.to_string())?;
        if let Ok((approved, _)) = user.create_subkey(APPROVED) {
            if let Err(error) = approved.delete_value(NAME) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error.to_string());
                }
            }
        }
    } else if previous
        .as_ref()
        .is_some_and(|value| value.eq_ignore_ascii_case(&own))
    {
        run.delete_value(NAME).map_err(|e| e.to_string())?;
    }
    let state = read()?;
    if state["enabled"] != enabled {
        return Err("Windows 자동 실행 상태를 바꾸지 못했습니다.".into());
    }
    Ok(state)
}

#[cfg(not(windows))]
pub fn read() -> Result<Value> {
    Ok(json!({"supported":false,"registered":false,"enabled":false,"disabledByWindows":false}))
}
#[cfg(not(windows))]
pub fn set(_: bool) -> Result<Value> {
    Err("Windows에서만 자동 실행을 설정할 수 있습니다.".into())
}
