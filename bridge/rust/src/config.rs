//! JSON config in the user's app-data folder. Only SHA-256 hashes of pairing
//! tokens are stored; the token itself stays in the page's localStorage.
//! Same file and shape as the Node reference daemon, so switching between the
//! two keeps the pairing.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
}

fn default_version() -> u32 {
    1
}

pub fn config_dir() -> PathBuf {
    if let Ok(home) = std::env::var("RAWMHUB_BRIDGE_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let os = std::env::consts::OS;
    if os == "windows" {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("AppData").join("Local"));
        return base.join("BetterRawmHubBridge");
    }
    if os == "macos" {
        return home_dir()
            .join("Library")
            .join("Application Support")
            .join("BetterRawmHubBridge");
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".config"));
    base.join("better-rawmhub-bridge")
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load_config() -> Config {
    match fs::read(config_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Config { version: 1, tokens: BTreeMap::new() },
    }
}

pub fn save_config(config: &Config) {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(config) {
        let _ = fs::write(dir.join("config.json"), format!("{text}\n"));
    }
}
