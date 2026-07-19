// End-to-end tests for the repo-image feature: GET /assets/:sessionId/*
//
// A question repo can ship images and reference them with a repo-relative
// markdown path (![](grafiken/x.png)); QuiQui serves them from the pulled clone
// via /assets/:sessionId/<path>. These tests drive the real server on a throwaway
// port and assert both the happy path and the safety envelope:
//
//   functional:  real image served 200 + content-type; subdir path; svg headers
//   safety:      traversal (.. / encoded / absolute), extension allowlist,
//                .git refused, unknown session, oversized image, symlink refused
//
// The route needs a live session, which only /api/pull creates (by cloning the
// companion repo). We pull it, then compute the clone dir the same way the server
// does (repoDirName) and drop fixture files straight into it — so the asset tests
// don't depend on the repo actually shipping images. If GitHub is unreachable the
// whole suite is skipped (not failed), matching security.test.js.
//
// No test framework — plain Node + a tiny assert helper. Run via `npm test`.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3972;
const BASE = `http://localhost:${PORT}`;
const SLUG = 'testslug';
const REPO = 'https://github.com/th-nuernberg/quiqui-questions'; // session_url: demo
const IMAGE_SIZE_LIMIT_KB = 32; // lowered via env so the oversize test is cheap

const wait = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0, skipped = 0;
function ok(cond, name) { cond ? (passed++, console.log(`  ok   ${name}`)) : (failed++, console.log(`  FAIL ${name}`)); }
function skip(name, why) { skipped++; console.log(`  skip ${name} (${why})`); }

// Mirror server.js repoDirName so the test can find the clone dir on disk.
function repoDirName(repoUrl) {
  return repoUrl
    .replace(/^https?:\/\//, '').replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 64);
}

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Host-Token': SLUG },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function pullDemo() {
  try {
    const { status, json } = await post('/api/pull', { repo: REPO });
    return status === 200 ? json.sessionId : null;
  } catch { return null; }
}

// A minimal valid 1x1 PNG (67 bytes).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const SVG_OK = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');

async function run() {
  const sid = await pullDemo();
  if (!sid) {
    console.log('(image tests need the companion repo — GitHub unreachable, skipping)');
    ['assets 200', 'assets subdir', 'svg headers', 'traversal ..', 'encoded traversal',
     'absolute path', 'extension allowlist', '.git refused', 'unknown session',
     'oversized', 'symlink refused'].forEach(n => skip(n, 'GitHub unreachable'));
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    return failed === 0;
  }

  const cloneDir = path.join(__dirname, '..', 'tmp', 'sessions', repoDirName(REPO));

  // ── Fixtures: drop images straight into the clone dir ──────────────────────
  fs.mkdirSync(path.join(cloneDir, 'grafiken'), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'pic.png'), PNG_1x1);
  fs.writeFileSync(path.join(cloneDir, 'grafiken', 'sub.png'), PNG_1x1);
  fs.writeFileSync(path.join(cloneDir, 'logo.svg'), SVG_OK);
  fs.writeFileSync(path.join(cloneDir, 'big.png'), Buffer.alloc(IMAGE_SIZE_LIMIT_KB * 1024 + 1, 1));
  // A secret file above the clone root, used by the traversal tests.
  const secretRel = '../assets-escape-secret.txt';
  fs.writeFileSync(path.join(cloneDir, secretRel), 'TOP SECRET');

  const A = pathname => fetch(BASE + pathname);

  // ── Functional ─────────────────────────────────────────────────────────────
  console.log('functional');
  {
    const r = await A(`/assets/${sid}/pic.png`);
    ok(r.status === 200 && (r.headers.get('content-type') || '').includes('image/png'),
       'assets 200 — real png served with image/png');

    const sub = await A(`/assets/${sid}/grafiken/sub.png`);
    ok(sub.status === 200, 'assets subdir — grafiken/sub.png served');

    const svg = await A(`/assets/${sid}/logo.svg`);
    ok(svg.status === 200
       && (svg.headers.get('content-type') || '').includes('image/svg+xml')
       && svg.headers.get('x-content-type-options') === 'nosniff'
       && /default-src 'none'/.test(svg.headers.get('content-security-policy') || ''),
       'svg headers — image/svg+xml + nosniff + locked-down CSP');

    // Public: no X-Host-Token header sent by A(), yet it served — confirm that.
    ok((await A(`/assets/${sid}/pic.png`)).status === 200, 'assets public — served with no host token');
  }

  // ── Safety ─────────────────────────────────────────────────────────────────
  console.log('safety');
  {
    // Path traversal: the escape target exists on disk (secretRel), so a 200
    // would be a real leak. Both raw and percent-encoded forms must be refused.
    const raw = await A(`/assets/${sid}/../assets-escape-secret.txt`);
    ok(raw.status === 403 || raw.status === 404, 'traversal .. — escape refused (not 200)');
    ok(raw.status !== 200, 'traversal .. — secret not leaked');

    const enc = await fetch(`${BASE}/assets/${sid}/%2e%2e/assets-escape-secret.txt`);
    ok(enc.status !== 200, 'encoded traversal — %2e%2e escape refused');

    const deep = await fetch(`${BASE}/assets/${sid}/grafiken/%2e%2e/%2e%2e/server.js`);
    ok(deep.status !== 200, 'encoded traversal via subdir — server.js not reachable');

    // Extension allowlist: a real, in-root, non-image file must be refused.
    const cfg = await A(`/assets/${sid}/config.yaml`);
    ok(cfg.status === 403, 'extension allowlist — config.yaml refused (403)');

    const git = await A(`/assets/${sid}/.git/config`);
    ok(git.status === 403 || git.status === 404, '.git refused — .git/config not served');

    const unknown = await A(`/assets/no-such-session/pic.png`);
    ok(unknown.status === 404, 'unknown session — 404');

    const big = await A(`/assets/${sid}/big.png`);
    ok(big.status === 413, `oversized — image over ${IMAGE_SIZE_LIMIT_KB} KB rejected (413)`);
  }

  // ── Symlink refused ──────────────────────────────────────────────────────────
  console.log('symlink');
  {
    // A symlink that points back INSIDE the clone (to a real image) must still be
    // refused: a question repo shouldn't be able to hand us links at all.
    const linkPath = path.join(cloneDir, 'link.png');
    let made = false;
    try { fs.symlinkSync(path.join(cloneDir, 'pic.png'), linkPath); made = true; } catch {}
    if (!made) {
      skip('symlink refused', 'cannot create symlink on this fs');
    } else {
      const r = await A(`/assets/${sid}/link.png`);
      ok(r.status === 404 || r.status === 403, 'symlink refused — even one pointing inside the root');
    }
    // And a symlink ESCAPING the root must never leak its target.
    const escLink = path.join(cloneDir, 'escape.png');
    try {
      fs.symlinkSync(path.join(cloneDir, secretRel), escLink);
      const r = await A(`/assets/${sid}/escape.png`);
      ok(r.status !== 200, 'symlink escape — target outside root not leaked');
    } catch { skip('symlink escape', 'cannot create symlink on this fs'); }

    // Symlinked *directory* escape — the intermediate-component case lstat can't
    // see. `d` links to the clone's parent; d/<secret with an image ext> would
    // resolve inside-root lexically but point outside on disk. realpath must
    // catch it. Plant an image-extension file next to the clone as the target.
    const parentSecret = path.join(cloneDir, '..', 'assets-escape-secret.png');
    fs.writeFileSync(parentSecret, PNG_1x1);
    const dirLink = path.join(cloneDir, 'd');
    try {
      fs.symlinkSync(path.join(cloneDir, '..'), dirLink);
      const r = await A(`/assets/${sid}/d/assets-escape-secret.png`);
      ok(r.status === 403 || r.status === 404, 'symlink directory — intermediate link escape refused (not 200)');
      ok(r.status !== 200, 'symlink directory — out-of-root image not leaked');
    } catch { skip('symlink directory escape', 'cannot create symlink on this fs'); }
    try { fs.unlinkSync(parentSecret); } catch {}
  }

  // Tidy the escape fixture (it lives outside the clone, so expiry won't reap it).
  try { fs.unlinkSync(path.join(cloneDir, secretRel)); } catch {}

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0;
}

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST_SLUG: SLUG, BASE_PATH: '',
      IMAGE_SIZE_LIMIT_KB: String(IMAGE_SIZE_LIMIT_KB),
      LOG_LEVEL: 'ERROR', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_PAGER: 'cat' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let up = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/')).ok) { up = true; break; } } catch {}
    await wait(150);
  }
  if (!up) { console.error('server did not start'); server.kill('SIGKILL'); process.exit(1); }

  let success = false;
  try { success = await run(); }
  catch (err) { console.error('test run threw:', err); }
  finally { server.kill('SIGKILL'); }

  process.exit(success ? 0 : 1);
})();
