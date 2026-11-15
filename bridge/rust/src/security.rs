//! Origin / host / token checks. Kept free of HID and WebSocket code so the
//! rules can be read in one place.

use sha2::{Digest, Sha256};

/// Hosted pages allowed out of the box. Extra origins come from --origin.
pub const DEFAULT_ORIGINS: [&str; 2] = [
    "https://better-rawmhub.chila.io.vn",
    "https://better-rawmhub.pages.dev",
];

const LOOPBACK_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "[::1]", "::1"];

pub fn loopback_origin(origin: &str) -> bool {
    let rest = match origin.split_once("://") {
        Some((scheme, rest)) => {
            if scheme != "http" && scheme != "https" {
                return false;
            }
            rest
        }
        None => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    // Keep the brackets of an IPv6 literal, drop the port from everything else.
    let name = if host.starts_with('[') {
        host.split(']').next().map(|v| format!("{v}]")).unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or("").to_string()
    };
    LOOPBACK_HOSTS.contains(&name.as_str())
}

/// `null` is what a file:// page and a sandboxed frame send. Both are refused.
pub fn origin_allowed(origin: &str, extra: &[String]) -> bool {
    if origin.is_empty() || origin == "null" {
        return false;
    }
    if DEFAULT_ORIGINS.contains(&origin) {
        return true;
    }
    if loopback_origin(origin) {
        return true;
    }
    extra.iter().any(|allowed| allowed == "*" || allowed == origin)
}

/// Blocks DNS rebinding: a hostile name that resolves to 127.0.0.1 still
/// carries its own name in the Host header.
pub fn host_allowed(host: &str) -> bool {
    let value = host.trim().to_ascii_lowercase();
    if value.is_empty() {
        return false;
    }
    let name = if value.starts_with('[') {
        value.split(']').next().map(|v| format!("{v}]")).unwrap_or_default()
    } else {
        value.split(':').next().unwrap_or("").to_string()
    };
    LOOPBACK_HOSTS.contains(&name.as_str())
}

pub fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    to_hex(&hasher.finalize())
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn eq_hex(a: &str, b: &str) -> bool {
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert!(host_allowed("127.0.0.1:47311"));
        assert!(host_allowed("localhost:1"));
        assert!(host_allowed("[::1]:47311"));
        assert!(!host_allowed("evil.example:47311"));
        assert!(!host_allowed(""));
    }

    #[test]
    fn origins() {
        let extra: Vec<String> = Vec::new();
        assert!(origin_allowed("https://better-rawmhub.chila.io.vn", &extra));
        assert!(origin_allowed("http://localhost:8080", &extra));
        assert!(origin_allowed("http://127.0.0.1:5500", &extra));
        assert!(!origin_allowed("null", &extra));
        assert!(!origin_allowed("https://evil.example", &extra));
        assert!(!origin_allowed("file://", &extra));
        assert!(!origin_allowed("blob:https://better-rawmhub.chila.io.vn/x", &extra));
    }

    #[test]
    fn tokens() {
        let hash = sha256_hex("abc");
        assert_eq!(hash.len(), 64);
        assert!(eq_hex(&hash, &sha256_hex("abc")));
        assert!(!eq_hex(&hash, &sha256_hex("abd")));
    }
}
