// Copy the working build into ../swipe-comp-testing, the "TestingSwipeComp" Add On installed in LUNA
// beside the release (its own manifest, id com.neilsattin.swipe_comp_testing). LUNA will not load an
// Add On's page through file links (it resolves them to a path outside the Add On and refuses), so
// the files are copies: run this after every change (`npm run testing`), then reopen the page in LUNA.
// The page's TEST BUILD tag shows the commit and the time of the copy (testing-stamp.js, made here).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, '..', 'swipe-comp-testing');
if (!existsSync(join(out, 'manifest.json'))) throw new Error(`${out}/manifest.json is missing: that folder holds the testing manifest`);
for (const f of ['index.html', 'main.js', 'logic.js', 'icon.png', 'icon.svg', 'vendor', 'testing-stamp.js']) rmSync(join(out, f), { recursive: true, force: true });
for (const f of ['main.js', 'logic.js', 'icon.png', 'icon.svg']) cpSync(join(repo, f), join(out, f));
cpSync(join(repo, 'vendor'), join(out, 'vendor'), { recursive: true });
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: repo }).toString().trim(); } catch { /* not a git checkout */ }
const dirty = (() => { try { return execSync('git status --porcelain -- main.js logic.js index.html', { cwd: repo }).toString().trim() ? '+changes' : ''; } catch { return ''; } })();
const stamp = `${commit}${dirty} · ${new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
writeFileSync(join(out, 'testing-stamp.js'), `window.TEST_BUILD = ${JSON.stringify(stamp)};\n`);
const html = readFileSync(join(repo, 'index.html'), 'utf8');
if (!html.includes('<script src="main.js"></script>')) throw new Error('index.html no longer loads main.js the expected way');
writeFileSync(join(out, 'index.html'), html.replace('<script src="main.js"></script>', '<script src="testing-stamp.js"></script>\n  <script src="main.js"></script>'));
mkdirSync(out, { recursive: true });
console.log(`TestingSwipeComp updated: ${stamp}`);
