#!/usr/bin/env node
// Runs UA's `ua-builder` command (serve, install, pack, doctor) from wherever UA's LUNA Builder
// SDK is on this computer, so package.json names no path on any one machine. It looks, in order:
//   1. LUNA_BUILDER_SDK, a folder holding UA's SDK (the one with sdk/cli.js in it)
//   2. node_modules/@uaudio/luna-builder-sdk, if someone installed it there
//   3. UA's ua-luna-builder Claude Code plugin, newest version
//      (add it in Claude Code: /plugin marketplace add uaudio-labs/luna-builder-sdk)
// The tests do not need any of this: they run on the SDK bundle in vendor/.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliIn = (dir) => [join(dir, 'sdk', 'cli.js'), join(dir, 'dist', 'cli.js')].find(existsSync);

function versionOrder(a, b) {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0), pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function findCli() {
  const tried = [];
  if (process.env.LUNA_BUILDER_SDK) {
    tried.push(process.env.LUNA_BUILDER_SDK);
    const c = cliIn(process.env.LUNA_BUILDER_SDK);
    if (c) return { cli: c, tried };
  }
  const local = join(root, 'node_modules', '@uaudio', 'luna-builder-sdk');
  tried.push(local);
  if (cliIn(local)) return { cli: cliIn(local), tried };
  const plugin = join(homedir(), '.claude', 'plugins', 'cache', 'luna-builder-sdk', 'ua-luna-builder');
  tried.push(plugin);
  if (existsSync(plugin)) {
    for (const v of readdirSync(plugin).sort(versionOrder).reverse()) {
      const c = cliIn(join(plugin, v));
      if (c) return { cli: c, tried };
    }
  }
  return { cli: undefined, tried };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { cli, tried } = findCli();
  if (!cli) {
    console.error("UA's LUNA Builder SDK was not found. Looked in:\n  " + tried.join('\n  ') +
      "\nGet it by adding UA's plugin in Claude Code (/plugin marketplace add uaudio-labs/luna-builder-sdk," +
      '\nthen install ua-luna-builder), or set LUNA_BUILDER_SDK to a folder holding it.');
    process.exit(1);
  }
  // Run it as a child and pass Ctrl-C and stop signals on, so stopping this stops `serve` too.
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
