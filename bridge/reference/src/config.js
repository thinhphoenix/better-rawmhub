/* Small JSON config next to the user's app data. Only token hashes are
   stored; the token itself never leaves the page after pairing. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir() {
  if (process.env.RAWMHUB_BRIDGE_HOME) return process.env.RAWMHUB_BRIDGE_HOME;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'BetterRawmHubBridge');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BetterRawmHubBridge');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'better-rawmhub-bridge');
}

export function configPath() {
  return join(configDir(), 'config.json');
}

export function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    return {
      version: 1,
      tokens: raw && typeof raw.tokens === 'object' && raw.tokens ? raw.tokens : {},
    };
  } catch {
    return { version: 1, tokens: {} };
  }
}

export function saveConfig(config) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch {
    /* read-only profile: pairing just stops persisting */
  }
}
