//! better-rawmhub-bridge — gives browsers without WebHID (Firefox, Safari)
//! access to a RAWM mouse or keyboard through a loopback WebSocket.
//!
//! Release builds on Windows use the GUI subsystem: no console window, because
//! the daemon normally starts from the page (betterrawm://start), from the
//! Start menu, or at login. Logs go to bridge.log next to config.json.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod config;
mod hid;
mod logfile;
mod security;
mod server;

use server::Options;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const HELP: &str = "\
better-rawmhub-bridge - HID bridge for browsers without WebHID

Usage: better-rawmhub-bridge [options]

  --port=<n>            loopback port (default 47311)
  --idle=<seconds>      exit after this long with no page open (default 600, 0 = never)
  --origin=<url>        extra allowed origin, repeatable (or --origin=* for any)
  --pair                require the six-digit code for non-hosted origins (off by default)
  --no-report-ids       do not prefix writes with the report id (rare interfaces)
  --host=<address>      bind address (default 127.0.0.1 - do not change this)
  --stop                stop a bridge that is already running, then exit
  -h, --help            this text

No code is needed by default. The daemon binds loopback, rejects any Host that
is not a loopback name, and only accepts these origins:

  https://better-rawmhub.chila.io.vn, https://better-rawmhub.pages.dev,
  plus any http(s) origin on localhost / 127.0.0.1.

Add --origin=<url> for anything else (that origin then needs a code with
--pair). A file:// page sends no usable origin and is refused.
";

fn main() {
    logfile::init();

    let mut options = Options::default();
    let mut stop = false;

    for arg in std::env::args().skip(1) {
        if arg == "-h" || arg == "--help" {
            logfile::line(HELP);
            return;
        }
        if arg == "--stop" {
            stop = true;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--port=") {
            if let Ok(port) = value.trim().parse::<u16>() {
                options.port = port;
            } else {
                logfile::line("--port needs a number");
                std::process::exit(2);
            }
        } else if let Some(value) = arg.strip_prefix("--idle=") {
            options.idle_seconds = value.trim().parse().unwrap_or(600);
        } else if let Some(value) = arg.strip_prefix("--origin=") {
            if !value.is_empty() {
                options.origins.push(value.trim().to_string());
            }
        } else if let Some(value) = arg.strip_prefix("--host=") {
            if !value.trim().is_empty() {
                options.host = value.trim().to_string();
            }
        } else if arg == "--no-pair" {
            options.pairing = false;
        } else if arg == "--no-report-ids" {
            options.report_ids = false;
        } else if arg == "--pair" {
            options.pairing = true;
        } else if arg == "--report-ids" {
            options.report_ids = true;
        } else if arg.starts_with("--") {
            logfile::line(&format!("unknown option {arg} (try --help)"));
            std::process::exit(2);
        }
        // Anything else is the URL the protocol handler passed in
        // (betterrawm://start); the daemon does not need it.
    }

    if stop {
        match request_stop(options.port) {
            Ok(status) => logfile::line(&format!("  stop request: {status}")),
            Err(err) => {
                logfile::line(&format!("  no bridge is listening on 127.0.0.1:{} ({err})", options.port));
                std::process::exit(1);
            }
        }
        return;
    }

    match server::start(options.clone()) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            // Started at login, then again from the page or the Start menu: one
            // copy is enough, and nothing is wrong.
            logfile::line(&format!(
                "  bridge already running on port {} - nothing to do",
                options.port
            ));
        }
        Err(err) => {
            logfile::line(&format!("  could not start the bridge: {err}"));
            std::process::exit(1);
        }
    }
}

fn request_stop(port: u16) -> std::io::Result<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let request = format!(
        "POST /v1/quit HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-bridge-local: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    Ok(reply.lines().next().unwrap_or("").to_string())
}
