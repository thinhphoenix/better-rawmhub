/* Local static server + Chrome launcher for `npm start`. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const noOpen = process.argv.includes('--no-open');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

function chromePath() {
  const candidates = process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => p && existsSync(p));
}

function openBrowser(url) {
  if (noOpen) {
    console.log(`Open ${url} in Chrome.`);
    return;
  }
  const chrome = chromePath();
  if (chrome) {
    spawn(chrome, ['--new-window', url], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Chrome → ${url}`);
    return;
  }
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Browser → ${url}`);
}

let port = Number(process.env.PORT) || 8080;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT) {
    port = 0;
    server.listen(0, '127.0.0.1', ready);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});

function ready() {
  const url = `http://localhost:${server.address().port}/`;
  console.log(`RAWM HUB running at ${url}`);
  console.log('Ctrl+C to stop.');
  openBrowser(url);
}

server.listen(port, '127.0.0.1', ready);
