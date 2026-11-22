#!/usr/bin/env node
// Builds the .lunaaddon to attach to a GitHub release (or to share by a Dropbox, Google Drive or
// iCloud Drive link), from the last commit, never from loose files in this folder: working notes
// (NEXT.md, ignored by git) and anything not committed stay out. Development files (tests, tools,
// package.json) are left out too. Output: dist/Swipe-Comping-<version>.lunaaddon.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });

const DEV_ONLY = [/^tools\//, /^tests\//, /^package(-lock)?\.json$/, /^vitest\.config\./, /^\./, /^README\.md$/, /^icon\.svg$/, /^DEVELOPING\.md$/];

const dirty = git('status', '--porcelain').toString().trim();
if (dirty) console.warn('Note: there are uncommitted changes; the package is built from the last commit, without them.\n');

const manifest = JSON.parse(git('show', 'HEAD:manifest.json').toString());
const stage = join(root, 'dist', 'stage', 'swipe-comping');
rmSync(join(root, 'dist', 'stage'), { recursive: true, force: true });

const files = git('ls-tree', '-r', '--name-only', '-z', 'HEAD').toString().split('\0').filter(Boolean);
for (const f of files) {
  if (DEV_ONLY.some((re) => re.test(f))) continue;
  const to = join(stage, ...f.split('/'));
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, git('show', `HEAD:${f}`));
}

const out = join(root, 'dist', `Swipe-Comping-${manifest.version}.lunaaddon`);
execFileSync(process.execPath, [join(root, 'tools', 'ua-builder.mjs'), 'pack', stage, '--out', out], { stdio: 'inherit' });
rmSync(join(root, 'dist', 'stage'), { recursive: true, force: true });
console.log(`\nBuilt from commit ${git('rev-parse', '--short', 'HEAD').toString().trim()}: ${out}`);
