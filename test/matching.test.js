// End-to-end tests for matching / ranking questions.
//
// Drives the real server on a throwaway port. Questions come in through
// /api/upload (no GitHub needed), are read back through /api/questions, and the
// vote flow runs over real socket.io clients.
//
//   validation:  every authoring mistake is rejected with a clear message
//   transform:   blanks parsed, choices shuffled, key never in participant events
//   votes:       one submission per voter, per-item counts, exclusivity enforced
//
// No test framework — plain Node + a tiny assert helper. Run via `npm test`.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3973;
const BASE = `http://localhost:${PORT}`;
const SLUG = 'testslug';
const wait = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, name) { cond ? (passed++, console.log(`  ok   ${name}`)) : (failed++, console.log(`  FAIL ${name}`)); }

async function upload(yamlText, force = true) {
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Host-Token': SLUG },
    body: JSON.stringify({ text: yamlText, filename: 't.yaml', force }),
  });
  return { status: res.status, json: await res.json() };
}

async function questionsOf(upl) {
  const res = await fetch(`${BASE}/api/questions?file=${encodeURIComponent(upl.storedName)}&sessionId=${upl.sessionId}`,
    { headers: { 'X-Host-Token': SLUG } });
  return { status: res.status, json: await res.json() };
}

const file = (sid, body) => `config:\n  session_url: ${sid}\nquestions:\n${body}`;

// One question → upload → { status, error?, q? }
async function load(sid, body) {
  const u = await upload(file(sid, body));
  if (u.status !== 200) return { status: u.status, error: u.json.error };
  const r = await questionsOf(u.json);
  return { status: r.status, q: r.json.questions && r.json.questions[0], all: r.json.questions, sessionId: sid, error: r.json.error };
}

function connect() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}
const once = (s, ev) => new Promise(r => s.once(ev, r));

async function run() {
  // ── Validation ─────────────────────────────────────────────────────────────
  console.log('validation');
  const bad = async (name, body, re) => {
    const r = await load('v-bad', body);
    ok(r.status === 400 && re.test(r.error || ''), `${name} → rejected (${(r.error || '').slice(0, 70)})`);
  };
  await bad('matching: no blank', `
- question: Q
  type: matching
  answers: ["no blank here", "or here"]`, /exactly one \[blank\]/);
  await bad('matching: two blanks in one line', `
- question: Q
  type: matching
  answers: ["[a|b] and [c|d]", "x [e|f]"]`, /exactly one \[blank\]/);
  await bad('matching: mixed single/multi', `
- question: Q
  type: matching
  answers: ["x [A]", "y [B|C]"]`, /mixes single-option/);
  await bad('matching: correct field present', `
- question: Q
  type: matching
  correct: A
  answers: ["x [A|B]", "y [B|A]"]`, /"correct" is not allowed/);
  await bad('matching: blank inside math', `
- question: Q
  type: matching
  answers: ["$x [a|b]$", "y [B|A]"]`, /code span or math/);
  await bad('matching: blank inside code span', `
- question: Q
  type: matching
  answers: ["\`x [a|b]\`", "y [B|A]"]`, /code span or math/);
  await bad('matching: duplicate option', `
- question: Q
  type: matching
  answers: ["x [A|A]", "y [B|A]"]`, /same option twice/);
  await bad('matching: all pool values identical', `
- question: Q
  type: matching
  answers: ["x [A]", "y [A]"]`, /nothing to choose from/);
  await bad('ranking: partial correct', `
- question: Q
  type: ranking
  answers: [a, b, c]
  correct: [A, B]`, /must list all 3 letters/);
  await bad('ranking: duplicate letter', `
- question: Q
  type: ranking
  answers: [a, b, c]
  correct: [A, A, B]`, /twice/);
  await bad('ranking: bare letter', `
- question: Q
  type: ranking
  answers: [a, b, c]
  correct: B`, /must list all 3 letters/);

  // ── Limits: 20 is the maximum, 21 is rejected ──────────────────────────────
  console.log('limits (20 max)');
  {
    const N = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const L = i => String.fromCharCode(65 + i);
    const yamlList = arr => arr.map(a => `    - "${a}"`).join('\n');
    const accepted = async (name, body, check) => {
      const r = await load('v-lim', body);
      ok(r.status === 200 && r.q && (!check || check(r.q)), `${name} → accepted`);
    };
    await accepted('single: 20 answers, correct T', `
- question: Q
  type: single
  correct: T
  answers:
${yamlList(N(20, i => 'opt ' + i))}`, q => q.answers.length === 20);
    await bad('single: 21 answers', `
- question: Q
  type: single
  correct: A
  answers:
${yamlList(N(21, i => 'opt ' + i))}`, /maximum is 20/);
    await bad('single: correct letter beyond T', `
- question: Q
  type: single
  correct: U
  answers:
${yamlList(N(20, i => 'opt ' + i))}`, /invalid letter.*A–T/);
    await accepted('multiple: 20 answers, correct A+T', `
- question: Q
  type: multiple
  correct: [A, T]
  answers:
${yamlList(N(20, i => 'opt ' + i))}`);
    await accepted('matching: 20 lines (variant B)', `
- question: Q
  type: matching
  answers:
${yamlList(N(20, i => `Item ${i} is [v${i}].`))}`, q => q.answers.length === 20 && q.choices[0].length === 20);
    await bad('matching: 21 lines', `
- question: Q
  type: matching
  answers:
${yamlList(N(21, i => `Item ${i} is [v${i}].`))}`, /maximum is 20/);
    await accepted('matching: 20 choices per blank (variant A)', `
- question: Q
  type: matching
  answers:
    - "x [${N(20, i => 'c' + i).join('|')}]"
    - "y [${N(20, i => 'c' + i).join('|')}]"`, q => q.choices[0].length === 20);
    await bad('matching: 21 choices per blank', `
- question: Q
  type: matching
  answers:
    - "x [${N(21, i => 'c' + i).join('|')}]"
    - "y [c0|c1]"`, /maximum is 20/);
    await accepted('ranking: 20 items with full key', `
- question: Q
  type: ranking
  correct: [${N(20, i => L(19 - i)).join(', ')}]
  answers:
${yamlList(N(20, i => 'item ' + i))}`, q => q.answers.length === 20 && q.choices[0].length === 20);
    await bad('ranking: 21 items', `
- question: Q
  type: ranking
  answers:
${yamlList(N(21, i => 'item ' + i))}`, /maximum is 20/);

    // Live vote on a 20-answer single question: the last option (index 19) counts.
    const r = await load('v-lim-vote', `
- question: Q
  type: single
  correct: T
  shuffle: false
  answers:
${yamlList(N(20, i => 'opt ' + i))}`);
    const host = await connect(), p = await connect();
    [host, p].forEach(s => s.emit('join-session', { sessionId: 'v-lim-vote' }));
    await wait(100);
    host.emit('activate-question', { question: r.q, sessionId: 'v-lim-vote', token: SLUG });
    await once(p, 'question-activated');
    const vu = once(host, 'vote-update');
    p.emit('submit-answer', { sessionId: 'v-lim-vote', selected: [19], voterId: 'lim' });
    const u = await vu;
    ok(u.total === 1 && u.votes[19] === 1, 'vote for option 20 (T) is counted');
    const rv = once(p, 'answer-revealed');
    host.emit('show-answer', { sessionId: 'v-lim-vote', token: SLUG });
    const rev = await rv;
    ok(rev.correctIndices.join() === '19', 'reveal highlights option T (index 19)');
    [host, p].forEach(s => s.close());
  }

  // ── Transform ──────────────────────────────────────────────────────────────
  console.log('transform');
  {
    // Markdown link and escaped bracket are not blanks.
    const r = await load('v-pool', `
- question: Capitals
  type: matching
  answers:
    - "Germany is [Berlin]."
    - "France is [Paris]."
    - "Poland is [Warsaw]."
    - "See [the docs](https://example.org) — \\\\[not a blank\\\\] — Spain is [Madrid]."`);
    ok(r.status === 200 && r.q.type === 'matching', 'derived-pool question loads');
    ok(r.q.answers.every(a => a.includes('QUIQUIBLANK') && !/\[(Berlin|Paris|Warsaw|Madrid)\]/.test(a)),
       'blank replaced by token in every item');
    ok(r.q.answers[3].includes('[the docs](https://example.org)'), 'markdown link left intact');
    ok(r.q.capacity && r.q.capacity.every(n => n === 1) && r.q.choices[0].length === 4, 'pool of 4 values, capacity 1 each');
    const pool = r.q.choices[0];
    ok(r.q.correct.map((c, i) => pool[c]).join() === 'Berlin,Paris,Warsaw,Madrid', 'correct index per item points at its own value');
    ok(r.q.scored === true, 'scored = true');
  }
  {
    const r = await load('v-list', `
- question: Match
  type: matching
  answers:
    - "A: [one|two|three]"
    - "B: [two|three|one]"`);
    ok(r.status === 200 && r.q.capacity === null, 'explicit lists: no exclusive pool');
    ok(r.q.choices.every(c => c.length === 3) && r.q.choices[0][r.q.correct[0]] === 'one' && r.q.choices[1][r.q.correct[1]] === 'two',
       'correct index follows the first authored option');
    // "first = correct" must not be recoverable from the order: over many loads
    // the correct option must not always sit at index 0.
    const positions = new Set();
    for (let i = 0; i < 25; i++) {
      const x = await load('v-list', `
- question: Match
  type: matching
  answers:
    - "A: [one|two|three]"
    - "B: [two|three|one]"`);
      positions.add(x.q.correct[0]);
    }
    ok(positions.size > 1, `choice order is shuffled (correct landed on index ${[...positions].sort().join(',')})`);
  }
  {
    const r = await load('v-dup', `
- question: Continents
  type: matching
  answers:
    - "France [Europe]"
    - "Spain [Europe]"
    - "Peru [America]"`);
    const c = r.q.choices[0];
    ok(c.length === 2 && r.q.capacity[c.indexOf('Europe')] === 2 && r.q.capacity[c.indexOf('America')] === 1,
       'duplicate pool values stay usable as often as they occur');
  }
  {
    const r = await load('v-rank', `
- question: Order
  type: ranking
  answers: [Embed, Generate, Chunk, Retrieve]
  correct: [C, A, D, B]`);
    ok(r.status === 200 && r.q.scored === true, 'ranking loads and is scored');
    ok(r.q.answers.join() === 'Embed,Generate,Chunk,Retrieve', 'ranking items keep authored order without shuffle');
    // C is rank 1, A rank 2, D rank 3, B rank 4  → per item (A,B,C,D): 1,3,0,2
    ok(r.q.correct.join() === '1,3,0,2', 'ranking key converted to rank index per item');
    ok(r.q.choices[0].join() === '1,2,3,4' && r.q.capacity.join() === '1,1,1,1', 'ranking pool is 1..n, exclusive');
  }
  {
    const r = await load('v-rank-un', `
- question: Preference
  type: ranking
  answers: [x, y, z]`);
    ok(r.status === 200 && r.q.scored === false && r.q.correct === undefined, 'unscored ranking has no key');
  }
  {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const r = await load('v-rank-sh', `
- question: Order
  type: ranking
  shuffle: true
  answers: [a, b, c, d]
  correct: [A, B, C, D]`);
      // key must stay attached to the item whatever the display order is
      const ok2 = r.q.answers.every((it, idx) => r.q.correct[idx] === 'abcd'.indexOf(it));
      if (!ok2) { seen.add('BROKEN'); break; }
      seen.add(r.q.answers.join(''));
    }
    ok(!seen.has('BROKEN') && seen.size > 1, 'per-question shuffle: true opts in; key follows the shuffled items');
  }

  // ── Votes over sockets ───────────────────────────────────────────────────────
  console.log('votes');
  {
    const r = await load('v-vote', `
- question: Capitals
  type: matching
  answers:
    - "Germany is [Berlin]."
    - "France is [Paris]."
    - "Poland is [Warsaw]."
  explanation: secret`);
    const q = r.q;
    const pool = q.choices[0];
    const idx = v => pool.indexOf(v);
    const sid = r.sessionId;

    const host = await connect();
    const p1 = await connect();
    const p2 = await connect();
    const p3 = await connect();
    [host, p1, p2, p3].forEach(s => s.emit('join-session', { sessionId: sid }));
    await wait(100);

    const activated = once(p1, 'question-activated');
    host.emit('activate-question', { question: q, sessionId: sid, token: SLUG, title: 'T' });
    const act = await activated;
    ok(act.question.correct === undefined && act.question.explanation === undefined,
       'question-activated carries no correct / explanation');
    ok(JSON.stringify(act.question).includes('Berlin') && !/"correct"/.test(JSON.stringify(act.question)),
       'participants get choices but no key');
    ok(act.votes[0].length === 3 && act.votes[0].every(n => n === 0), 'votes start as per-item zero arrays');

    const vote = (s, picks) => s.emit('submit-answer', { sessionId: sid, selected: picks, voterId: Math.random().toString(16) });

    // p1 answers everything correctly
    vote(p1, [idx('Berlin'), idx('Paris'), idx('Warsaw')]);
    await once(host, 'vote-update');
    // p2 swaps two
    vote(p2, [idx('Paris'), idx('Berlin'), idx('Warsaw')]);
    await once(host, 'vote-update');
    // p3 sends a duplicate of an exclusive value → must be ignored
    let extra = false;
    host.once('vote-update', () => { extra = true; });
    vote(p3, [idx('Berlin'), idx('Berlin'), idx('Warsaw')]);
    // wrong length and out-of-range also ignored
    vote(p3, [0, 1]);
    vote(p3, [0, 1, 99]);
    await wait(200);
    ok(!extra, 'duplicate use of an exclusive value / bad length / out-of-range rejected');

    // reveal
    const revealed = once(p1, 'answer-revealed');
    host.emit('show-answer', { sessionId: sid, token: SLUG });
    const rev = await revealed;
    ok(rev.total === 2, 'two valid submissions counted');
    ok(rev.correctIndices.join() === [idx('Berlin'), idx('Paris'), idx('Warsaw')].join(), 'answer-revealed carries per-item correct choice');
    ok(rev.votes[0][idx('Berlin')] === 1 && rev.votes[0][idx('Paris')] === 1 && rev.votes[2][idx('Warsaw')] === 2,
       'per-item vote counts');

    // a late joiner after reveal gets the key too, but never before
    const late = await connect();
    const st = once(late, 'session-state');
    late.emit('join-session', { sessionId: sid });
    const state = await st;
    ok(state.answersRevealed && state.correctIndices.length === 3 && state.question.correct === undefined,
       'session-state after reveal: key present as correctIndices, not inside question');
    [host, p1, p2, p3, late].forEach(s => s.close());
  }
  {
    // double submit by the same voter
    const r = await load('v-vote2', `
- question: Order
  type: ranking
  answers: [a, b, c]`);
    const sid = r.sessionId;
    const host = await connect();
    const p = await connect();
    [host, p].forEach(s => s.emit('join-session', { sessionId: sid }));
    await wait(100);
    host.emit('activate-question', { question: r.q, sessionId: sid, token: SLUG });
    await once(p, 'question-activated');
    p.emit('submit-answer', { sessionId: sid, selected: [0, 1, 2], voterId: 'same' });
    const u1 = await once(host, 'vote-update');
    p.emit('submit-answer', { sessionId: sid, selected: [2, 1, 0], voterId: 'same' });
    await wait(150);
    const st = once(p, 'question-deactivated');
    host.emit('deactivate-question', { sessionId: sid, token: SLUG });
    const d = await st;
    ok(u1.total === 1 && d.total === 1 && d.votes[0][0] === 1 && d.votes[0][2] === 0, 'second submission by the same voter ignored');
    // unscored: reveal carries no indices
    const rv = once(p, 'answer-revealed');
    host.emit('show-answer', { sessionId: sid, token: SLUG });
    ok((await rv).correctIndices.length === 0, 'unscored ranking reveals no correct indices');
    [host, p].forEach(s => s.close());
  }
}

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST_SLUG: SLUG, BASE_PATH: '', LOG_LEVEL: 'ERROR' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/')).ok) { up = true; break; } } catch {}
    await wait(150);
  }
  if (!up) { console.error('server did not start'); server.kill('SIGKILL'); process.exit(1); }
  try { await run(); } catch (e) { failed++; console.error(e); }
  server.kill('SIGKILL');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
