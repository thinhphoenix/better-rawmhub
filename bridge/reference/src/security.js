/* Loopback-only helpers: who may talk to the bridge, and how a token is
   stored. Kept free of Node HID and WebSocket imports so it can be unit
   tested from the repository root. */
import { createHash } from 'node:crypto';

/* The hosted pages. Add your own with --origin=https://… when testing. */
export const DEFAULT_ORIGINS = [
  'https://better-rawmhub.chila.io.vn',
  'https://better-rawmhub.pages.dev',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function loopbackOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname);
}

/* `null` is what a file:// page and a sandboxed frame send. Both are refused:
   the bridge is only reachable from a real http(s) origin. */
export function originAllowed(origin, extra = []) {
  if (!origin || origin === 'null') return false;
  if (DEFAULT_ORIGINS.includes(origin)) return true;
  if (loopbackOrigin(origin)) return true;
  return extra.includes('*') || extra.includes(origin);
}

/* Blocks DNS rebinding: a hostile hostname that resolves to 127.0.0.1 still
   carries its own name in the Host header. */
export function hostAllowed(host) {
  const value = String(host || '').toLowerCase().trim();
  if (!value) return false;
  const name = value.replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(name);
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
