//! Logging for a background daemon. Windows release builds have no console
//! (`windows_subsystem = "windows"`), so everything goes to bridge.log next to
//! config.json and is also mirrored to stdout when one is attached.

use std::io::Write;
use std::sync::OnceLock;

const MAX_BYTES: u64 = 512 * 1024;

static SINK: OnceLock<std::sync::Mutex<std::fs::File>> = OnceLock::new();

pub fn init() {
    let dir = crate::config::config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("bridge.log");

    if std::fs::metadata(&path).map(|meta| meta.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }

    if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = SINK.set(std::sync::Mutex::new(file));
    }
}

pub fn line(text: &str) {
    if let Some(sink) = SINK.get() {
        if let Ok(mut file) = sink.lock() {
            let _ = writeln!(file, "{text}");
        }
    }
    // A GUI-subsystem binary has no stdout; writing to it must never panic.
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{text}");
    let _ = stdout.flush();
}
