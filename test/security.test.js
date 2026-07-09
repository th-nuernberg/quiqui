// End-to-end security regression tests for QuiQui.
//
// Runs the real server on a throwaway port and drives it exactly as a browser
// (HTTP + socket.io) would, asserting the behaviour of the five hardening fixes:
//
//   #1  vote dedupe + single-choice enforcement (server-side, UI-bypass safe)
//   #2  session-expired is room-scoped, not global (concurrent sessions safe)
//   #3  voter-count cap bounds a scripted flood
//   #4  /api/qr-public only mints QR codes for join URLs on this host
//   #5  session_url from config.yaml is validated
//
// No test framework — plain Node with a tiny assert helper, matching the
// project's no-build ethos. Run with `npm test`.
//
// One test (#2 expiry) needs a session to time out, so the server is started
// with SESSION_TIMEOUT_MINUTES lowered via env. Tests that need a live session pull
// the public companion repo; if GitHub is unreachable those are skipped (not
// failed) so the suite still runs offline.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3971;
const BASE = `http://localhost:${PORT}`;
const SLUG = 'testslug';
const REPO = 'https://github.com/th-nuernberg/quiqui-questions'; // session_url: demo
const SESSION_TIMEOUT_MS = 3000;

const wait = ms => new Promise(r => setTimeout(r, ms));
const sock = () => io(BASE, { transports: ['websocket'], forceNew: true });
const connected = s => new Promise(r => s.on('connect', r));

let passed = 0, failed = 0, skipped = 0;
function ok(cond, name) { cond ? (passed++, console.log(`  ok   ${name}`)) : (failed++, console.log(`  FAIL ${name}`)); }
function skip(name, why) { skipped++; console.log(`  skip ${name} (${why})`); }

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': SLUG },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// Pull the companion repo to get a live session. Returns sessionId, or null if
// GitHub is unreachable (so callers can skip rather than fail offline).
async function pullDemo() {
  try {
    const { status, json } = await post('/api/pull', { repo: REPO });
    return status === 200 ? json.sessionId : null;
  } catch { return null; }
}

async function activate(sessionId, question) {
  const t = sock(); await connected(t);
  t.emit('join-session', { sessionId });
  t.emit('activate-question', { question, sessionId, token: SLUG, title: 't' });
  await wait(200);
  return t;
}

// Collect the next vote-update seen by a listener joined to the room.
function voteWatcher(sessionId) {
  const l = sock();
  const state = { last: null, sock: l };
  connected(l).then(() => { l.emit('join-session', { sessionId }); l.on('vote-update', d => state.last = d); });
  return state;
}

async function run() {
  // ── #4: qr-public host restriction (no live session needed) ──────────────
  console.log('#4 qr-public host restriction');
  {
    const ext = await fetch(`${BASE}/api/qr-public?url=${encodeURIComponent('https://evil.example/join/x')}`);
    ok(ext.status === 403, 'external host rejected (403)');
    const good = await fetch(`${BASE}/api/qr-public?url=${encodeURIComponent(`${BASE}/join/demo`)}`);
    const gj = await good.json();
    ok(good.status === 200 && typeof gj.dataUrl === 'string', 'same-host join URL accepted (200 + dataUrl)');
    const badPath = await fetch(`${BASE}/api/qr-public?url=${encodeURIComponent(`${BASE}/testslug`)}`);
    ok(badPath.status === 403, 'same host, non-join path rejected (403)');
    const garbage = await fetch(`${BASE}/api/qr-public?url=${encodeURIComponent('not a url')}`);
    ok(garbage.status === 400, 'unparseable url rejected (400)');
  }

  // ── #5: session_url validation (regex is the contract qr-public enforces) ─
  console.log('#5 session_url validation');
  {
    const re = /^[A-Za-z0-9_-]{1,64}$/;
    ok(re.test('demo') && re.test('ki-zentrum-demo') && re.test('thn_db_alb'), 'valid slugs accepted');
    ok(!re.test('my quiz') && !re.test('a/b') && !re.test('quiz.1') && !re.test('') && !re.test('a'.repeat(65)),
       'spaces / slashes / dots / empty / overlong rejected');
    const sid = await pullDemo();
    sid ? ok(sid === 'demo', 'valid config.yaml session_url pulls to sessionId "demo"')
        : skip('valid session_url pull', 'GitHub unreachable');
  }

  const demo = await pullDemo();
  if (!demo) {
    console.log('\n(remaining socket tests need the companion repo — GitHub unreachable, skipping)');
    ['#1 single-choice', '#1 dedupe', '#3 flood counts distinct voters'].forEach(n => skip(n, 'GitHub unreachable'));
  } else {
    // ── #1: dedupe + single-choice enforcement ──────────────────────────────
    console.log('#1 vote dedupe + single-choice enforcement');
    {
      const single = { question: 'S', type: 'single', answers: ['a', 'b', 'c', 'd'], correct: 'A' };
      const t = await activate(demo, single);
      const w = voteWatcher(demo); await wait(150);

      let s = sock(); await connected(s);
      s.emit('submit-answer', { sessionId: demo, selected: [2], voterId: 'ok1' }); await wait(200);
      ok(w.last && w.last.votes[2] === 1 && w.last.total === 1, 'legit single vote counts once');
      s.close();

      s = sock(); await connected(s);
      s.emit('submit-answer', { sessionId: demo, selected: [0, 1, 2], voterId: 'atk1' }); await wait(200);
      ok(w.last && w.last.total === 1 && w.last.votes[0] === 0 && w.last.votes[1] === 0,
         'multi-select on single-choice rejected (no new votes)');
      s.close();

      s = sock(); await connected(s);
      s.emit('submit-answer', { sessionId: demo, selected: [3, 3, 3, 3], voterId: 'atk2' }); await wait(200);
      ok(w.last && w.last.votes[3] === 1 && w.last.total === 2,
         'duplicate indices collapse to a single vote (no bar stacking)');
      s.close(); t.close(); w.sock.close();
    }

    // ── #3: voter-count cap keeps counting distinct voters (below cap) ───────
    console.log('#3 voter flood accounting');
    {
      const q = { question: 'F', type: 'single', answers: ['a', 'b'], correct: 'A' };
      const t = await activate(demo, q);
      const w = voteWatcher(demo); await wait(150);
      const f = sock(); await connected(f);
      for (let i = 0; i < 40; i++) f.emit('submit-answer', { sessionId: demo, selected: [0], voterId: 'flood-' + i });
      await wait(500);
      ok(w.last && w.last.total === 40, '40 distinct voters each counted once (below 10000 cap)');
      f.emit('submit-answer', { sessionId: demo, selected: [1], voterId: 'flood-0' }); await wait(200);
      ok(w.last && w.last.total === 40, 're-vote by an existing voterId is ignored');
      f.close(); t.close(); w.sock.close();
    }
  }

  // ── #2: session-expired is room-scoped ──────────────────────────────────────
  console.log('#2 session-expired is room-scoped, teacher notified before activation');
  {
    const A = await pullDemo();                                   // session "demo"
    // A second, independent session via a config-less repo → random hex id.
    let B = null;
    try { const r = await post('/api/pull', { repo: 'https://github.com/octocat/Hello-World' }); B = r.status === 200 ? r.json.sessionId : null; } catch {}
    if (!A || !B) {
      skip('room-scoped expiry', 'GitHub unreachable');
    } else {
      const aEvents = [], bEvents = [];
      const la = sock(); await connected(la); la.on('session-expired', p => aEvents.push(p)); la.emit('join-session', { sessionId: A });
      const lb = sock(); await connected(lb); lb.on('session-expired', p => bEvents.push(p)); lb.emit('join-session', { sessionId: B });
      // Keep B alive past A's timeout with periodic activity.
      const tb = sock(); await connected(tb);
      const keep = setInterval(() => tb.emit('activate-question', { question: { question: 'k', type: 'single', answers: ['a', 'b'], correct: 'A' }, sessionId: B, token: SLUG, title: 'B' }), 800);
      await wait(SESSION_TIMEOUT_MS + 3500);
      clearInterval(keep);
      ok(aEvents.length >= 1 && aEvents.every(p => p && p.sessionId === A),
         'teacher A (never activated) gets expiry tagged with its own sessionId');
      ok(bEvents.length === 0, 'concurrent session B receives no expiry');
      const sess = await (await fetch(`${BASE}/api/session?sessionId=${B}`, { headers: { 'X-Teacher-Token': SLUG } })).json();
      ok(sess.session !== null, 'concurrent session B is still alive on the server');
      la.close(); lb.close(); tb.close();
    }
  }

  // ── #6: owner-token warns before a same-repo pull clobbers a live session ──
  console.log('#6 owner-token collision warning');
  {
    const q = { question: 'O', type: 'single', answers: ['a', 'b'], correct: 'A' };
    const sid = await pullDemo(); // no ownerToken → session has ownerToken: null
    if (!sid) {
      skip('owner-token collision warning', 'GitHub unreachable');
    } else {
      // Re-pull with an owner token — first pull had none, so this is accepted
      // and becomes the recorded owner (existing.ownerToken is falsy, so the
      // mismatch check doesn't fire yet).
      const first = await post('/api/pull', { repo: REPO, ownerToken: 'owner-A' });
      ok(first.status === 200, 'first pull with an owner token is accepted (no prior owner recorded)');

      const t = await activate(sid, q); // makes the session "live" (activeQuestion set)

      const blocked = await post('/api/pull', { repo: REPO, ownerToken: 'owner-B' });
      ok(blocked.status === 409 && blocked.json.code === 'SESSION_LIKELY_TAKEN',
         'same repo, live session, different ownerToken → 409 SESSION_LIKELY_TAKEN');

      const sameOwner = await post('/api/pull', { repo: REPO, ownerToken: 'owner-A' });
      ok(sameOwner.status === 200, 'same ownerToken as recorded owner → refreshes silently');

      const forced = await post('/api/pull', { repo: REPO, ownerToken: 'owner-B', force: true });
      ok(forced.status === 200, 'force: true bypasses the warning and takes over');

      const nowOwnerB = await post('/api/pull', { repo: REPO, ownerToken: 'owner-A' });
      ok(nowOwnerB.status === 409 && nowOwnerB.json.code === 'SESSION_LIKELY_TAKEN',
         'after a forced takeover, the previous owner is now the one warned');

      t.close();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0;
}

// ── Harness: boot the server, wait for it, run, tear down ────────────────────
(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    // BASE_PATH pinned empty so this suite always exercises the root deployment,
    // even if a developer's .env sets a proxy prefix (dotenv won't override it).
    env: { ...process.env, PORT: String(PORT), TEACHER_SLUG: SLUG, BASE_PATH: '', SESSION_TIMEOUT_MINUTES: String(SESSION_TIMEOUT_MS / 60000), LOG_LEVEL: 'ERROR', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_PAGER: 'cat' },
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
