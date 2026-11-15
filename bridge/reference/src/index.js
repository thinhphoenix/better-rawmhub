#!/usr/bin/env node
/* CLI entry. Everything is optional: `better-rawmhub-bridge` with no flags is
   what a double-clicked build runs. */
import { DEFAULT_PORT, VERSION, startBridge } from './server.js';

const HELP = `better-rawmhub-bridge ${VERSION}

Gives browsers without WebHID (Firefox, Safari) access to a RAWM device.
Runs a WebSocket server on loopback and relays HID reports to the page.

Usage: better-rawmhub-bridge [options]

  --port=<n>            loopback port (default ${DEFAULT_PORT})
  --idle=<seconds>      exit after this long with no page open (default 600, 0 = never)
  --origin=<url>        extra allowed origin, repeatable (or --origin=* for any)
  --no-pair             skip the pairing code (local development only)
  --no-report-ids       do not prefix writes with the report id (rare interfaces)
  --host=<address>      bind address (default 127.0.0.1 - do not change this)
  -h, --help            this text

The page must be served over https:// or http://localhost. Opening
index.html from disk (file://) sends no usable origin and is refused.
`;

function parse(argv) {
  const options = { origins: [] };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return { help: true };
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    switch (key) {
      case 'port': options.port = Number(value); break;
      case 'idle': options.idle = Number(value); break;
      case 'origin': if (value) options.origins.push(value); break;
      case 'host': options.host = value || '127.0.0.1'; break;
      case 'pair': options.pairing = value !== 'false' && value !== '0'; break;
      case 'no-pair': options.pairing = false; break;
      case 'report-ids': options.reportIds = !(value === 'false' || value === '0'); break;
      case 'no-report-ids': options.reportIds = false; break;
      default: break;
    }
  }
  return { options };
}

const parsed = parse(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const bridge = startBridge(parsed.options);

function bye() {
  process.stdout.write('\n  stopping\n');
  bridge.close();
  process.exit(0);
}

process.on('SIGINT', bye);
process.on('SIGTERM', bye);
