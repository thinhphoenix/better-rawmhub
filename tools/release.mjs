/* Bump the patch version, rebuild, deploy to Cloudflare Pages and commit. */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bumpOnly = process.argv.includes('--bump-only');
const noDeploy = process.argv.includes('--no-deploy');
const pkgPath = resolve(root, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const version = `${major}.${minor}.${patch + 1}`;
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = resolve(root, 'package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

console.log(`version → ${version}`);
if (bumpOnly) process.exit(0);

const run = (cmd) => execSync(cmd, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});

run('npm run build');
if (!noDeploy) run('npx wrangler pages deploy public --project-name better-rawmhub --branch main');
run('git add -A');
run(`git commit -m "Release v${version}"`);
run('git push');
console.log(`Released v${version}${noDeploy ? ' (Cloudflare will deploy)' : ''}`);
