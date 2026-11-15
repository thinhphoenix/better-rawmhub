//! Loopback WebSocket server. One thread accepts connections, one thread per
//! page reads protocol messages, one writer thread per page serialises every
//! outgoing frame, and one thread per open device pumps HID traffic.

use crate::config::{config_path, load_config, save_config, Config};
use crate::hid::{self, Cmd};
use crate::security::{eq_hex, host_allowed, needs_pairing, origin_allowed, sha256_hex, DEFAULT_ORIGINS};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::{Role, WebSocket};
use tungstenite::Message;

pub const API: u32 = 1;
pub const VERSION: &str = "0.2.0";
pub const DEFAULT_PORT: u16 = 47311;

const PAIR_TTL: Duration = Duration::from_secs(600);
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct Options {
    pub port: u16,
    pub host: String,
    pub idle_seconds: u64,
    pub origins: Vec<String>,
    pub pairing: bool,
    pub report_ids: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            host: "127.0.0.1".to_string(),
            idle_seconds: 600,
            origins: Vec::new(),
            // No codes by default: the origin allowlist plus the loopback-only
            // bind are the gate. `--pair` adds the code back for everything
            // except the hosted pages.
            pairing: false,
            report_ids: true,
        }
    }
}

struct OpenDevice {
    path: String,
    session: u64,
    tx: Sender<Cmd>,
}

struct State {
    options: Options,
    config: Mutex<Config>,
    pending: Mutex<HashMap<String, (String, Instant)>>,
    open: Mutex<HashMap<u16, OpenDevice>>,
    next_handle: AtomicU16,
    session_seq: AtomicU64,
    sessions: AtomicUsize,
    last_activity: Mutex<Instant>,
}

impl State {
    fn log(&self, line: &str) {
        crate::logfile::line(&format!("  {line}"));
    }

    fn touch(&self) {
        if let Ok(mut last) = self.last_activity.lock() {
            *last = Instant::now();
        }
    }

    fn open_count(&self) -> usize {
        self.open.lock().map(|open| open.len()).unwrap_or(0)
    }
}

struct SessionCtx {
    id: u64,
    origin: String,
    authorised: bool,
    handles: Vec<u16>,
}

pub fn start(options: Options) -> std::io::Result<()> {
    let listener = TcpListener::bind((options.host.as_str(), options.port))?;
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(options.port);

    let say = crate::logfile::line;
    say("");
    say(&format!("  better-rawmhub-bridge {VERSION}"));
    say(&format!("  ws://{}:{port}/v1/ws", options.host));
    say(&format!(
        "  origins: {}{}",
        DEFAULT_ORIGINS.join(", "),
        if options.origins.is_empty() { String::new() } else { format!(" + {}", options.origins.join(", ")) }
    ));
    say("  origins on localhost are allowed too - devices: vendor 0x1915 only");
    say(&format!(
        "  pairing: {} - idle exit: {}",
        if options.pairing {
            "on (hosted pages still free)"
        } else {
            "off - origin allowlist only"
        },
        if options.idle_seconds == 0 {
            "never".to_string()
        } else {
            format!("{}s after the last page closes", options.idle_seconds)
        }
    ));
    say(&format!("  config: {}", config_path().display()));
    say("  stop it from the Start-menu shortcut, or run with --stop");
    say("");

    let state = Arc::new(State {
        options: options.clone(),
        config: Mutex::new(load_config()),
        pending: Mutex::new(HashMap::new()),
        open: Mutex::new(HashMap::new()),
        next_handle: AtomicU16::new(1),
        session_seq: AtomicU64::new(1),
        sessions: AtomicUsize::new(0),
        last_activity: Mutex::new(Instant::now()),
    });

    if options.idle_seconds > 0 {
        let idle_state = state.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(15));
                if idle_state.sessions.load(Ordering::Relaxed) > 0 || idle_state.open_count() > 0 {
                    continue;
                }
                let quiet_for = idle_state
                    .last_activity
                    .lock()
                    .map(|last| last.elapsed())
                    .unwrap_or_default();
                if quiet_for >= Duration::from_secs(idle_state.options.idle_seconds) {
                    crate::logfile::line(&format!(
                        "  idle for {}s - exiting (start it again from the page, or run with --idle=0)",
                        idle_state.options.idle_seconds
                    ));
                    std::process::exit(0);
                }
            }
        });
    }

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = state.clone();
                thread::spawn(move || {
                    let _ = serve(stream, state);
                });
            }
            Err(err) => {
                crate::logfile::line(&format!("  accept failed: {err}"));
            }
        }
    }
    Ok(())
}

/* ── handshake ─────────────────────────────────────────────────────────── */

fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1];
    while bytes.len() < 16 * 1024 {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        bytes.push(chunk[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn refuse(stream: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    let body = format!("{code} {reason}\n");
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.flush();
    Ok(())
}

fn serve(mut stream: TcpStream, state: Arc<State>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_nodelay(true).ok();
    let head = match read_head(&mut stream) {
        Ok(head) => head,
        Err(_) => return Ok(()),
    };
    stream.set_read_timeout(None)?;

    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let path_ok = path == "/v1/ws" || path.starts_with("/v1/ws?");
    let host = headers.get("host").cloned().unwrap_or_default();
    let origin = headers.get("origin").cloned().unwrap_or_default();
    let key = headers.get("sec-websocket-key").cloned().unwrap_or_default();

    // Local shutdown, used by the Start-menu shortcut and `--stop`. The custom
    // header keeps pages out: a browser only sends custom headers after a
    // preflight, and this server never answers one.
    if path.starts_with("/v1/quit") {
        let allowed = headers.get("x-bridge-local").map(|value| value == "1").unwrap_or(false);
        if !allowed {
            return refuse(&mut stream, 403, "Forbidden");
        }
        let body = "stopping\n";
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.flush();
        state.log("stop requested");
        thread::spawn(|| {
            thread::sleep(Duration::from_millis(120));
            std::process::exit(0);
        });
        return Ok(());
    }

    if !path_ok {
        return refuse(&mut stream, 404, "Not Found");
    }
    if !host_allowed(&host) {
        return refuse(&mut stream, 403, "Forbidden");
    }
    if !origin_allowed(&origin, &state.options.origins) {
        state.log(&format!(
            "refused {} - not in the allowlist",
            if origin.is_empty() { "(no origin)" } else { &origin }
        ));
        return refuse(&mut stream, 403, "Forbidden");
    }
    if key.is_empty() {
        return refuse(&mut stream, 400, "Bad Request");
    }

    let accept = derive_accept_key(key.as_bytes());
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;

    /* The header was read byte by byte, so both halves start with an empty
       buffer and can own their own WebSocket. */
    let writer_stream = stream.try_clone()?;
    let (out_tx, out_rx) = channel::<Message>();
    let writer = thread::spawn(move || {
        let mut ws = WebSocket::from_raw_socket(writer_stream, Role::Server, None);
        while let Ok(message) = out_rx.recv() {
            let closing = matches!(message, Message::Close(_));
            if ws.send(message).is_err() {
                break;
            }
            if closing {
                break;
            }
        }
        let _ = ws.close(None);
        let _ = ws.flush();
    });

    let id = state.session_seq.fetch_add(1, Ordering::Relaxed);
    state.sessions.fetch_add(1, Ordering::Relaxed);
    state.touch();
    state.log(&format!("page connected - {origin}"));

    let mut ctx = SessionCtx { id, origin: origin.clone(), authorised: false, handles: Vec::new() };
    let mut ws = WebSocket::from_raw_socket(stream, Role::Server, None);
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => handle_text(&state, &mut ctx, text.as_str(), &out_tx),
            Ok(Message::Ping(payload)) => {
                let _ = out_tx.send(Message::Pong(payload));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }

    cleanup(&state, &ctx);
    state.sessions.fetch_sub(1, Ordering::Relaxed);
    state.touch();
    let _ = out_tx.send(Message::Close(None));
    let _ = writer.join();
    state.log(&format!("page closed - {origin}"));
    Ok(())
}

/* ── protocol ──────────────────────────────────────────────────────────── */

fn send_json(out: &Sender<Message>, value: Value) {
    let _ = out.send(Message::Text(value.to_string().into()));
}

fn fail(out: &Sender<Message>, seq: &Option<Value>, code: &str, message: &str) {
    let mut value = json!({ "t": "error", "code": code, "message": message });
    if let Some(seq) = seq {
        value["seq"] = seq.clone();
    }
    send_json(out, value);
}

fn token_ok(state: &State, origin: &str, token: Option<&str>) -> bool {
    if !state.options.pairing {
        return true;
    }
    if !needs_pairing(origin) {
        return true;
    }
    let config = match state.config.lock() {
        Ok(config) => config,
        Err(_) => return false,
    };
    match (config.tokens.get(origin), token) {
        (Some(stored), Some(given)) if !given.is_empty() => eq_hex(stored, &sha256_hex(given)),
        _ => false,
    }
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; len];
    if getrandom::fill(&mut buffer).is_err() {
        // Extremely unlikely; fall back to a time-seeded value rather than panic.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (index, byte) in buffer.iter_mut().enumerate() {
            *byte = ((seed >> (index % 16 * 8)) & 0xff) as u8 ^ (index as u8);
        }
    }
    buffer
}

fn issue_code(state: &State, origin: &str) -> String {
    let mut pending = match state.pending.lock() {
        Ok(pending) => pending,
        Err(_) => return String::new(),
    };
    if let Some((code, expires)) = pending.get(origin) {
        if *expires > Instant::now() {
            return code.clone();
        }
    }
    let bytes = random_bytes(4);
    let number = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let code = format!("{:06}", 100_000 + number % 900_000);
    pending.insert(origin.to_string(), (code.clone(), Instant::now() + PAIR_TTL));
    state.log(&format!("pairing code for {origin}:  {code}"));
    state.log("type it into the page once - this origin is remembered");
    code
}

fn approve(state: &State, origin: &str) -> String {
    let token = crate::security::to_hex(&random_bytes(24));
    if let Ok(mut config) = state.config.lock() {
        config.version = 1;
        config.tokens.insert(origin.to_string(), sha256_hex(&token));
        save_config(&config);
    }
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(origin);
    }
    token
}

fn handle_text(state: &Arc<State>, ctx: &mut SessionCtx, raw: &str, out: &Sender<Message>) {
    let message: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return,
    };
    let kind = message.get("t").and_then(Value::as_str).unwrap_or("");
    let seq = message.get("seq").cloned();

    match kind {
        "hello" => {
            let token = message.get("token").and_then(Value::as_str);
            ctx.authorised = token_ok(state, &ctx.origin, token);
            send_json(
                out,
                json!({
                    "t": "welcome",
                    "api": API,
                    "version": VERSION,
                    "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                    "paired": ctx.authorised,
                    "pairing": state.options.pairing,
                }),
            );
            if !ctx.authorised && state.options.pairing {
                issue_code(state, &ctx.origin);
            }
        }

        "pair" => {
            if !state.options.pairing {
                ctx.authorised = true;
                send_json(out, json!({ "t": "paired", "token": "open" }));
                return;
            }
            let code = message.get("code").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let expected = state
                .pending
                .lock()
                .ok()
                .and_then(|pending| pending.get(&ctx.origin).cloned());
            match expected {
                Some((wanted, expires)) if expires > Instant::now() && code == wanted => {
                    let token = approve(state, &ctx.origin);
                    ctx.authorised = true;
                    state.log(&format!("paired {}", ctx.origin));
                    send_json(out, json!({ "t": "paired", "token": token }));
                }
                _ => fail(out, &seq, "bad-code", "That pairing code is wrong or expired"),
            }
        }

        "list" => {
            if !ctx.authorised {
                fail(out, &seq, "pair-required", "Pair this page with the bridge first");
                return;
            }
            let devices: Vec<Value> = hid::list_devices()
                .into_iter()
                .map(|device| {
                    json!({
                        "id": device.id,
                        "path": device.id,
                        "vendorId": device.vendor_id,
                        "productId": device.product_id,
                        "productName": device.product_name,
                        "serialNumber": device.serial_number,
                        "usagePage": device.usage_page,
                        "usage": device.usage,
                        "interface": device.interface,
                    })
                })
                .collect();
            send_json(out, json!({ "t": "devices", "devices": devices }));
            state.touch();
        }

        "open" => {
            if !ctx.authorised {
                fail(out, &seq, "pair-required", "Pair this page with the bridge first");
                return;
            }
            let device_id = message.get("deviceId").and_then(Value::as_str).unwrap_or("");
            let info = match hid::list_devices().into_iter().find(|device| device.id == device_id) {
                Some(info) => info,
                None => {
                    fail(out, &seq, "not-found", "That device is not plugged in any more");
                    return;
                }
            };
            let busy = state
                .open
                .lock()
                .map(|open| open.values().any(|entry| entry.path == device_id))
                .unwrap_or(false);
            if busy {
                fail(out, &seq, "device-busy", "Another tab already has this device open");
                return;
            }

            let handle = state.next_handle.fetch_add(1, Ordering::Relaxed);
            let input_out = out.clone();
            let gone_out = out.clone();
            let gone_state = state.clone();
            let spawned = hid::spawn(
                &info,
                state.options.report_ids,
                move |report: Vec<u8>| {
                    let mut frame = Vec::with_capacity(report.len() + 3);
                    frame.push(1);
                    frame.extend_from_slice(&handle.to_le_bytes());
                    frame.extend_from_slice(&report);
                    let _ = input_out.send(Message::Binary(frame.into()));
                },
                move |reason: Option<String>| {
                    if let Ok(mut open) = gone_state.open.lock() {
                        open.remove(&handle);
                    }
                    let reason = reason.unwrap_or_else(|| "device removed".to_string());
                    send_json(&gone_out, json!({ "t": "gone", "handle": handle, "reason": reason }));
                },
            );

            let tx = match spawned {
                Ok(tx) => tx,
                Err(err) => {
                    fail(out, &seq, "open-failed", &err);
                    return;
                }
            };
            if let Ok(mut open) = state.open.lock() {
                open.insert(handle, OpenDevice { path: device_id.to_string(), session: ctx.id, tx });
            }
            ctx.handles.push(handle);
            state.touch();
            state.log(&format!("opened {} for {}", info.product_name, ctx.origin));
            send_json(
                out,
                json!({
                    "t": "opened",
                    "seq": seq,
                    "handle": handle,
                    "productName": info.product_name,
                    "usagePage": info.usage_page,
                }),
            );
        }

        "send" => {
            let handle = message.get("handle").and_then(Value::as_u64).unwrap_or(0) as u16;
            let entry = state
                .open
                .lock()
                .ok()
                .and_then(|open| open.get(&handle).map(|entry| (entry.session, entry.tx.clone())));
            let (session, tx) = match entry {
                Some(entry) if entry.0 == ctx.id => entry,
                _ => {
                    fail(out, &seq, "no-handle", "That device is not open");
                    return;
                }
            };
            let _ = session;
            let report_id = message.get("rid").and_then(Value::as_u64).unwrap_or(0) as u8;
            let data = message
                .get("data")
                .and_then(Value::as_str)
                .and_then(|text| B64.decode(text).ok())
                .unwrap_or_default();
            let (reply_tx, reply_rx) = channel();
            if tx.send(Cmd::Write { report_id, data, reply: reply_tx }).is_err() {
                fail(out, &seq, "no-handle", "The device thread stopped");
                return;
            }
            match reply_rx.recv_timeout(REPLY_TIMEOUT) {
                Ok(Ok(())) => send_json(out, json!({ "t": "sent", "seq": seq })),
                Ok(Err(err)) => fail(out, &seq, "write-failed", &err),
                Err(_) => fail(out, &seq, "timeout", "The device did not answer the write"),
            }
            state.touch();
        }

        "feature" => {
            let handle = message.get("handle").and_then(Value::as_u64).unwrap_or(0) as u16;
            let entry = state
                .open
                .lock()
                .ok()
                .and_then(|open| open.get(&handle).map(|entry| (entry.session, entry.tx.clone())));
            let (session, tx) = match entry {
                Some(entry) if entry.0 == ctx.id => entry,
                _ => {
                    fail(out, &seq, "no-handle", "That device is not open");
                    return;
                }
            };
            let _ = session;
            let report_id = message.get("rid").and_then(Value::as_u64).unwrap_or(0) as u8;
            let dir = message.get("dir").and_then(Value::as_str).unwrap_or("read");
            let (reply_tx, reply_rx) = channel();
            let sent = if dir == "read" {
                tx.send(Cmd::FeatureRead { report_id, reply: reply_tx })
            } else {
                let data = message
                    .get("data")
                    .and_then(Value::as_str)
                    .and_then(|text| B64.decode(text).ok())
                    .unwrap_or_default();
                tx.send(Cmd::FeatureWrite { report_id, data, reply: reply_tx })
            };
            if sent.is_err() {
                fail(out, &seq, "no-handle", "The device thread stopped");
                return;
            }
            match reply_rx.recv_timeout(REPLY_TIMEOUT) {
                Ok(Ok(Some(bytes))) => send_json(
                    out,
                    json!({ "t": "feature-data", "seq": seq, "data": B64.encode(bytes) }),
                ),
                Ok(Ok(None)) => send_json(out, json!({ "t": "feature-data", "seq": seq, "data": "" })),
                Ok(Err(err)) => fail(out, &seq, "feature-failed", &err),
                Err(_) => fail(out, &seq, "timeout", "The device did not answer the feature request"),
            }
            state.touch();
        }

        "close" => {
            let handle = message.get("handle").and_then(Value::as_u64).unwrap_or(0) as u16;
            let entry = state.open.lock().ok().and_then(|mut open| {
                match open.get(&handle) {
                    Some(entry) if entry.session == ctx.id => open.remove(&handle),
                    _ => None,
                }
            });
            if let Some(entry) = entry {
                let (reply_tx, _reply_rx) = channel();
                let _ = entry.tx.send(Cmd::Shutdown { reply: reply_tx });
                ctx.handles.retain(|value| *value != handle);
                send_json(out, json!({ "t": "closed", "handle": handle }));
            }
        }

        "ping" => send_json(out, json!({ "t": "pong" })),

        _ => {}
    }
}

fn cleanup(state: &Arc<State>, ctx: &SessionCtx) {
    for handle in &ctx.handles {
        let entry = state.open.lock().ok().and_then(|mut open| open.remove(handle));
        if let Some(entry) = entry {
            let (reply_tx, _reply_rx) = channel();
            let _ = entry.tx.send(Cmd::Shutdown { reply: reply_tx });
        }
    }
}

