// End-to-end tests for the reverse-proxy subpath support (BASE_PATH).
//
// Verifies the contract QuiQui must honour when a proxy forwards a subpath
// WITHOUT stripping it (e.g. kiz1 nginx forwards /quiqui/... unchanged):
//
//   • every route answers under the prefix (/quiqui/...) and 404s at the root
//   • served HTML carries <base href="/quiqui/"> and window.__BASE_PATH__
//   • static assets and the templated teacher page resolve under the prefix
//   • socket.io lives at /quiqui/socket.io and a join round-trips
//   • /api/qr-public accepts a prefixed /quiqui/join/... URL (host + path check)
//
// Same no-framework style as security.test.js. Run via `npm test` (which runs
// both files) or directly with `node test/basepath.test.js`.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3972;
const BASE = `http://localhost:${PORT}`;
const SLUG = 'testslug';
const PREFIX = '/quiqui';

const wait = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, name) { cond ? (passed++, console.log(`  ok   ${name}`)) : (failed++, console.log(`  FAIL ${name}`)); }

async function run() {
  // ── routes answer under the prefix, 404 at the root ───────────────────────
  console.log('BASE_PATH routing');
  {
    const rootIndex = await fetch(`${BASE}/`);
    ok(rootIndex.status === 404, 'root "/" 404s (prefix not stripped by the app)');

    const rootTeacher = await fetch(`${BASE}/${SLUG}`);
    ok(rootTeacher.status === 404, 'teacher page at root (no prefix) 404s');

    const index = await fetch(`${BASE}${PREFIX}/`);
    ok(index.status === 200, 'index served at /quiqui/');

    const bare = await fetch(`${BASE}${PREFIX}`);
    ok(bare.status === 200, 'bare prefix /quiqui (no trailing slash) serves index');

    const teacher = await fetch(`${BASE}${PREFIX}/${SLUG}`);
    const teacherBody = await teacher.text();
    ok(teacher.status === 200, 'teacher page served at /quiqui/<slug>');
    ok(teacherBody.includes('<base href="/quiqui/"'), 'teacher HTML has <base href="/quiqui/">');
    ok(teacherBody.includes('window.__BASE_PATH__ = "/quiqui"'), 'teacher HTML sets window.__BASE_PATH__');

    const css = await fetch(`${BASE}${PREFIX}/style.css`);
    ok(css.status === 200, 'static asset served at /quiqui/style.css');
    const cssRoot = await fetch(`${BASE}/style.css`);
    ok(cssRoot.status === 404, 'static asset at root /style.css 404s');

    const impressum = await fetch(`${BASE}${PREFIX}/impressum`);
    const impressumBody = await impressum.text();
    ok(impressum.status === 200 && impressumBody.includes('<base href="/quiqui/"'),
       'dynamic /impressum served with <base> under the prefix');
  }

  // ── /api/qr-public accepts a prefixed join URL ────────────────────────────
  console.log('BASE_PATH qr-public');
  {
    const url = `${BASE}${PREFIX}/join/demo`;
    const good = await fetch(`${BASE}${PREFIX}/api/qr-public?url=${encodeURIComponent(url)}`);
    const gj = await good.json();
    ok(good.status === 200 && typeof gj.dataUrl === 'string', 'prefixed /quiqui/join/... URL accepted');

    const ext = await fetch(`${BASE}${PREFIX}/api/qr-public?url=${encodeURIComponent('https://evil.example/quiqui/join/x')}`);
    ok(ext.status === 403, 'foreign host still rejected even with a valid prefixed path');
  }

  // ── socket.io lives under the prefix and a join round-trips ───────────────
  console.log('BASE_PATH socket.io');
  {
    const rootSock = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 1500 });
    const rootConnected = await new Promise(r => { rootSock.on('connect', () => r(true)); rootSock.on('connect_error', () => r(false)); });
    ok(rootConnected === false, 'socket.io at default /socket.io path does NOT connect');
    rootSock.close();

    const s = io(BASE, { path: `${PREFIX}/socket.io`, transports: ['websocket'], forceNew: true, reconnection: false });
    const connected = await new Promise(r => { s.on('connect', () => r(true)); s.on('connect_error', () => r(false)); });
    ok(connected === true, 'socket.io connects at /quiqui/socket.io');
    if (connected) {
      const state = await new Promise(r => { s.on('session-state', r); s.emit('join-session', { sessionId: 'nope' }); setTimeout(() => r(null), 1000); });
      ok(state !== null && state.exists === false, 'join-session round-trips (session-state for unknown id)');
    } else {
      ok(false, 'join-session round-trips (skipped — no connection)');
    }
    s.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

// ── Harness: boot the server under /quiqui, wait for it, run, tear down ───────
(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TEACHER_SLUG: SLUG, BASE_PATH: PREFIX, LOG_LEVEL: 'ERROR', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_PAGER: 'cat' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let up = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}${PREFIX}/`)).ok) { up = true; break; } } catch {}
    await wait(150);
  }
  if (!up) { console.error('server did not start'); server.kill('SIGKILL'); process.exit(1); }

  let success = false;
  try { success = await run(); }
  catch (err) { console.error('test run threw:', err); }
  finally { server.kill('SIGKILL'); }

  process.exit(success ? 0 : 1);
})();
