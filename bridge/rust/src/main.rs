//! better-rawmhub-bridge — gives browsers without WebHID (Firefox, Safari)
//! access to a RAWM mouse or keyboard through a loopback WebSocket.
//!
//! Run it with no arguments; the page then finds it on 127.0.0.1:47311.

mod config;
mod hid;
mod security;
mod server;

use server::Options;

const HELP: &str = "\
better-rawmhub-bridge — HID bridge for browsers without WebHID

Usage: better-rawmhub-bridge [options]

  --port=<n>            loopback port (default 47311)
  --idle=<seconds>      exit after this long with no page open (default 600, 0 = never)
  --origin=<url>        extra allowed origin, repeatable (or --origin=* for any)
  --no-pair             skip the pairing code (local development only)
  --no-report-ids       do not prefix writes with the report id (rare interfaces)
  --host=<address>      bind address (default 127.0.0.1 — do not change this)
  -h, --help            this text

The page must be served over https:// or http://localhost. A file:// page
sends no usable origin and is refused.
";

fn main() {
    let mut options = Options::default();

    for arg in std::env::args().skip(1) {
        if arg == "-h" || arg == "--help" {
            print!("{HELP}");
            return;
        }
        if let Some(value) = arg.strip_prefix("--port=") {
            if let Ok(port) = value.trim().parse::<u16>() {
                options.port = port;
            } else {
                eprintln!("--port needs a number");
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
        } else if arg.starts_with('-') {
            eprintln!("unknown option {arg} (try --help)");
            std::process::exit(2);
        }
    }

    if let Err(err) = server::start(options.clone()) {
        if err.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!("port {} is already in use — is another bridge running?", options.port);
            eprintln!("try: better-rawmhub-bridge --port={}", options.port.saturating_add(1));
            eprintln!("(and start the page with the same port, or stop the other instance)");
        } else {
            eprintln!("could not start the bridge: {err}");
        }
        std::process::exit(1);
    }
}
