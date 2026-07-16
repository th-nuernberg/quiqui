marked.use(markedKatex({ throwOnError: false }));

// Question/answer links open in a new tab — clicking one during a live poll
// shouldn't navigate away from the voting page. DOMPurify strips `target`
// by default (reverse-tabnabbing protection), so it's re-added here alongside
// rel="noopener noreferrer" to keep that protection intact.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// BASE_PATH is the reverse-proxy subpath the app is served under ("" at root,
// "/quiqui" behind a non-stripping proxy). The server injects the authoritative
// value as window.__BASE_PATH__; socket.io and every API fetch must target it.
const BASE_PATH = window.__BASE_PATH__ || '';
const socket = io({ path: `${BASE_PATH}/socket.io` });

// ─── State ────────────────────────────────────────────────────────────────────
let questions = [];
let selectedQuestion = null;
let selectedIndex = -1;
let currentSessionId = null;
let currentTitle = null;
let sessionExpired = false;
let revealedCorrectIndices = [];
let currentVotes = {};
let currentTotal = 0;
let currentState = 'inactive';
let runStart = 0;        // Date.now() when the question went active
let runTimer = null;     // setInterval handle for the live stopwatch
// The UI for a close is driven synchronously by the host action that caused
// it (closeQuestion collapses the card, selectQuestion swaps to the new card).
// The server's question-closed echo is then just confirmation. This flag marks
// such a self-initiated close so its echo is a no-op; an echo arriving without
// it is an unsolicited (server-side) close, which falls back to setState('closed').
let selfInitiatedClose = false;

// Slug is the last path segment this page was loaded from — used as the host
// token. Using the last (not first) segment keeps this correct if the app is
// served behind a reverse-proxy path prefix (e.g. /quiqui/host-xk92p).
const pathSegments = window.location.pathname.split('/').filter(Boolean);
const HOST_TOKEN = pathSegments[pathSegments.length - 1] || '';

// Random per-browser identity, persisted in localStorage (not a cookie — never
// sent automatically, only attached to /api/pull). Lets the server tell "you
// reloading your own tab" apart from "someone else pulling the same repo" so it
// can warn before one lecturer's live poll silently clobbers another's, e.g. two
// people both trying the generic question repo on a shared hosted instance.
const OWNER_TOKEN_KEY = 'quiqui-owner-token';
let OWNER_TOKEN = localStorage.getItem(OWNER_TOKEN_KEY);
if (!OWNER_TOKEN) {
  OWNER_TOKEN = crypto.randomUUID();
  localStorage.setItem(OWNER_TOKEN_KEY, OWNER_TOKEN);
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const repoInput        = document.getElementById('repo-url');
const btnPull          = document.getElementById('btn-pull');
const fileSelect       = document.getElementById('file-select');
const fileRow          = document.getElementById('file-row');
const pullStatus       = document.getElementById('pull-status');
const sectionQuestions = document.getElementById('section-questions');
const questionList     = document.getElementById('question-list');
const sectionActive    = document.getElementById('section-active');
const activeQText      = document.getElementById('active-q-text');
const joinInfo         = document.getElementById('join-info');
const qrImg            = document.getElementById('qr-img');
const joinUrlEl        = document.getElementById('join-url');
const statAnsweredBadge = document.getElementById('stat-answered-badge');
const barChart         = document.getElementById('bar-chart');
const btnActivate      = document.getElementById('btn-activate');
const btnShowAnswer    = document.getElementById('btn-show-answer');
const btnClose         = document.getElementById('btn-close');
const btnNext          = document.getElementById('btn-next');
const explanationEl    = document.getElementById('explanation');
const statusBadge      = document.getElementById('status-badge');
const connectionIndicator = document.getElementById('connection-indicator');

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  const params = new URLSearchParams(window.location.search);
  const repo = params.get('repo');
  if (repo) repoInput.value = repo;

  btnPull.addEventListener('click', () => pullRepo());
  repoInput.addEventListener('keydown', e => { if (e.key === 'Enter') pullRepo(); });
  fileSelect.addEventListener('change', loadFile);

  if (repo) {
    pullRepo();
  } else {
    repoInput.select();
  }
})();

function setStatus(msg, isError = false) {
  pullStatus.textContent = msg;
  pullStatus.classList.toggle('meta-line--error', isError);
}

// ─── Repo pull ────────────────────────────────────────────────────────────────
async function pullRepo(force = false) {
  const repo = repoInput.value.trim();
  if (!repo) { setStatus('Enter a repo URL first.', true); return; }

  btnPull.disabled = true;
  setStatus('Cloning…');

  try {
    const res = await fetch(`${BASE_PATH}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': HOST_TOKEN },
      body: JSON.stringify({ repo, ownerToken: OWNER_TOKEN, force }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.code === 'SESSION_LIKELY_TAKEN') {
        setStatus('Session may be in use elsewhere.', true);
        if (confirm(`${data.error}\n\nEnter anyway? (Only do this if you're sure the other session isn't a colleague's live poll.)`)) {
          return pullRepo(true);
        }
        return;
      }
      throw new Error(data.error);
    }

    // Populate file dropdown — hidden until a repo is pulled for the first time
    fileSelect.innerHTML = '<option value="">— select a question file —</option>';
    data.files.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      fileSelect.appendChild(opt);
    });
    fileRow.style.display = '';

    // sessionId is always returned by the server (from config.session_url or random fallback)
    currentSessionId = data.sessionId;
    sessionExpired = false;
    // Join the session room now — before any question is activated — so
    // room-scoped server events (e.g. session-expired) reach this host even
    // on a freshly-pulled session. Without this the host only joins on
    // activate/reconnect and would miss an expiry of a not-yet-activated session.
    socket.emit('join-session', { sessionId: currentSessionId });
    const joinUrl = `${location.origin}${BASE_PATH}/join/${currentSessionId}`;
    joinUrlEl.textContent = joinUrl;
    joinUrlEl.href = joinUrl;
    const projectorUrl = `${location.origin}${BASE_PATH}/view/${currentSessionId}`;
    const projectorUrlEl = document.getElementById('projector-url');
    projectorUrlEl.textContent = projectorUrl;
    projectorUrlEl.href = projectorUrl;

    // Optional lecturer-provided shortlink from config.yaml — display only,
    // QuiQui does not resolve or validate where it points. The server normalises
    // it (trim + scheme prefix) so the value here is ready to use.
    setShortlink(data.shortlink);

    joinInfo.style.display = '';
    fetchQR(joinUrl);

    if (data.config && data.config.title) {
      currentTitle = data.config.title;
      document.title = `QuiQui: ${currentTitle}`;
    }

    const url = new URL(window.location);
    url.searchParams.set('repo', repo);
    history.replaceState(null, '', url);

    // Repo URL is validated server-side as a public GitHub https:// URL, but
    // still escape it before injecting into the link to avoid any HTML/attr breakout.
    const repoHref = escapeHtml(repo);
    pullStatus.classList.remove('meta-line--error');
    pullStatus.innerHTML = `Pulled ${data.files.length} file(s) from `
      + `<a href="${repoHref}" target="_blank" rel="noopener">${repoHref}</a>.`;
    btnPull.className = 'btn-light';
    sectionQuestions.style.display = 'none';
    parkActiveCard();
    questionList.innerHTML = '';
    selectedQuestion = null;
    selectedIndex = -1;
    revealedCorrectIndices = [];
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    btnPull.disabled = false;
  }
}

// ─── Load questions from selected file ────────────────────────────────────────
async function loadFile() {
  const file = fileSelect.value;
  if (!file) { sectionQuestions.style.display = 'none'; return; }

  try {
    const res = await fetch(`${BASE_PATH}/api/questions?file=${encodeURIComponent(file)}&sessionId=${encodeURIComponent(currentSessionId)}`, {
      headers: { 'X-Host-Token': HOST_TOKEN },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    questions = data.questions || [];
    selectedQuestion = null;
    selectedIndex = -1;
    renderQuestionList();
    sectionQuestions.style.display = '';
    sectionActive.style.display = 'none';
    stopStopwatch();
    questionList.firstElementChild?.focus();
  } catch (err) {
    setStatus('Error loading file: ' + err.message, true);
  }
}

// ─── Question list ────────────────────────────────────────────────────────────
// Park the active card back at its home position (after #section-questions) and
// hide it. Used before rebuilding the list, which would otherwise delete the
// card when it is parked inline among the .q-item children.
function parkActiveCard() {
  stopStopwatch();
  sectionActive.style.display = 'none';
  if (sectionActive.parentElement === questionList) {
    sectionQuestions.after(sectionActive);
  }
}

function renderQuestionList() {
  parkActiveCard();
  questionList.innerHTML = '';
  questions.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'q-item';
    item.dataset.index = i;
    item.tabIndex = 0;
    item.innerHTML = `
      <span class="q-text">${mdInline(previewQuestion(q.question))}</span>
      <span class="q-badge">${q.type === 'multiple' ? 'multi' : 'single'}</span>
    `;
    item.addEventListener('click', () => selectQuestion(i));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectQuestion(i); }
      if (e.key === 'ArrowDown') { e.preventDefault(); item.nextElementSibling?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); item.previousElementSibling?.focus(); }
    });
    questionList.appendChild(item);
  });
}

function selectQuestion(index) {
  // Buttons are disabled once the session expires, but the question list itself
  // stays clickable — without this, clicking around silently does nothing and the
  // easy-to-miss status line is the only clue why.
  if (sessionExpired) { alert('Session has expired. Pull the repo again to start a new session.'); return; }

  // A live poll (active/deactivated/revealed) has participants watching it. Switching
  // away tears it down server-side and sends those participants to the waiting screen,
  // so confirm before doing it. inactive/closed have nothing live to disturb.
  const pollIsLive = ['active', 'deactivated', 'revealed'].includes(currentState);
  if (pollIsLive && !confirm('Close the current poll and switch to this question?')) return;
  if (pollIsLive && currentSessionId) {
    selfInitiatedClose = true; // the echo is just confirming this teardown; the new card is rendered below
    socket.emit('close-question', { sessionId: currentSessionId, token: HOST_TOKEN });
  }
  selectedIndex = index;
  selectedQuestion = questions[index];
  revealedCorrectIndices = [];
  currentVotes = {};
  currentTotal = 0;
  currentState = 'inactive';

  // Inline the active card in place of the selected snippet: hide that snippet
  // and move the (single) #section-active card to sit right after it in the list.
  const items = questionList.querySelectorAll('.q-item');
  items.forEach((el, i) => {
    el.classList.remove('active-q');
    el.style.display = i === index ? 'none' : '';
  });
  const target = items[index];
  if (target) target.after(sectionActive);

  activeQText.innerHTML = mdHtml(selectedQuestion.question);
  sectionActive.style.display = '';

  statAnsweredBadge.textContent = '0 answered';
  statAnsweredBadge.style.display = '';
  setState('inactive');

  if (selectedQuestion.explanation) {
    const correct = selectedQuestion.correct;
    if (correct != null) {
      const letters = (Array.isArray(correct) ? correct : [correct])
        .map(l => String(l).trim()[0].toUpperCase())
        .join(', ');
      explanationEl.innerHTML = `${letters}: ${mdInline(selectedQuestion.explanation)}`;
    } else {
      explanationEl.innerHTML = mdInline(selectedQuestion.explanation);
    }
    explanationEl.style.display = '';
  } else {
    explanationEl.style.display = 'none';
  }

  renderBarChart(selectedQuestion.answers, {}, 0);
  sectionActive.scrollIntoView({ behavior: 'smooth', block: 'center' });
  btnActivate.focus();
}

// Collapse the inline active card back to a snippet: hide the card and re-show
// the snippet it replaced, restoring it to the focused list position.
function collapseActive() {
  stopStopwatch();
  sectionActive.style.display = 'none';
  const item = questionList.querySelector(`.q-item[data-index="${selectedIndex}"]`);
  if (item) {
    item.style.display = '';
    item.classList.remove('active-q');
    item.focus();
  }
  selectedQuestion = null;
  selectedIndex = -1;
  currentState = 'closed'; // no card shown, no live poll — so a later select sees nothing to confirm
}

// ─── State machine ────────────────────────────────────────────────────────────
// States: 'inactive' | 'active' | 'deactivated' | 'revealed' | 'closed'
// 'inactive'    — host preview, participants on waiting screen
// 'active'      — voting open
// 'deactivated' — voting closed, participants see bars (no highlights)
// 'revealed'    — voting closed, participants see bars + highlights
// 'closed'      — participants on waiting screen, activeQuestion cleared

function setState(state) {
  currentState = state;
  const labels = {
    inactive:    '◌ Inactive',
    active:      '● Active',
    deactivated: '◼ Deactivated',
    revealed:    '◼ Revealed',
    closed:      '◼ Closed',
  };
  statusBadge.style.display = state ? '' : 'none';
  if (state === 'active') {
    // While active, the badge becomes a live red stopwatch counting up.
    startStopwatch();
  } else {
    stopStopwatch();
    const badgeMod = state === 'inactive' ? ' badge-inactive' : ' badge-closed';
    statusBadge.textContent = labels[state] || '';
    statusBadge.className = 'badge-live' + badgeMod;
  }

  // Activate button toggles label and tooltip based on state
  btnActivate.textContent = state === 'active' ? '⏹ Deactivate' : '▶ Activate';
  btnActivate.title = state === 'active'
    ? 'Stop voting, but do not reveal correct answer(s), re-activation possible.'
    : 'Open question for voting.';

  // Button styles and disabled state per state:
  // strong blue = btn-primary, light blue = btn-light, white = btn-secondary (disabled)
  //               Activate       Reveal         Close
  // inactive      strong         white(off)     light
  // active        light          strong         light
  // deactivated   light          strong         light
  // revealed      light          white(off)     strong
  // closed        strong         white(off)     light
  // Close is enabled in every card-visible state. In inactive/closed there is no
  // live poll, so it just collapses the inline card back to a snippet; in the
  // live states it also tears the poll down server-side (see closeQuestion).
  const cfg = {
    inactive:    { activate: ['btn-primary', false], reveal: ['btn-secondary', true],  close: ['btn-light',     false], next: false },
    active:      { activate: ['btn-light',   false], reveal: ['btn-primary',   false], close: ['btn-light',     false], next: false },
    deactivated: { activate: ['btn-light',   false], reveal: ['btn-primary',   false], close: ['btn-light',     false], next: false },
    revealed:    { activate: ['btn-light',   false], reveal: ['btn-secondary', true],  close: ['btn-primary',   false], next: false },
    closed:      { activate: [currentTotal > 0 ? 'btn-light' : 'btn-primary', false], reveal: ['btn-secondary', true], close: ['btn-light',     false], next: currentTotal > 0 },
  }[state];
  const hasCorrect = selectedQuestion && selectedQuestion.correct != null;
  btnShowAnswer.style.display = hasCorrect ? '' : 'none';
  [btnActivate, btnShowAnswer, btnClose].forEach((btn, i) => {
    const key = ['activate', 'reveal', 'close'][i];
    btn.className = cfg[key][0];
    btn.disabled  = cfg[key][1];
  });
  updateNextBtn(cfg.next);
  const primary = cfg.next ? btnNext : [btnActivate, btnShowAnswer, btnClose].find((btn, i) => cfg[['activate','reveal','close'][i]][0] === 'btn-primary' && btn.style.display !== 'none');
  if (primary) primary.focus();
}

// ─── Stopwatch ────────────────────────────────────────────────────────────────
// While a question is active, the status badge shows elapsed run time (m:ss),
// updated once per second. Reverts to a normal badge in every other state.
function startStopwatch() {
  if (runTimer) return;          // already running — keep the existing start time
  runStart = Date.now();
  renderStopwatch();
  runTimer = setInterval(renderStopwatch, 1000);
}

function stopStopwatch() {
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
}

function renderStopwatch() {
  const secs = Math.floor((Date.now() - runStart) / 1000);
  const mins = Math.floor(secs / 60);
  statusBadge.textContent = `● ${mins}:${String(secs % 60).padStart(2, '0')}`;
  statusBadge.className = 'badge-live badge-running';
}

function updateNextBtn(strong = false) {
  const visible = selectedIndex < questions.length - 1;
  btnNext.style.display = visible ? '' : 'none';
  if (visible) btnNext.className = strong ? 'btn-primary' : 'btn-light';
}

// ─── Activate / Deactivate toggle ─────────────────────────────────────────────
function activateQuestion() {
  if (!selectedQuestion || sessionExpired) return;
  if (currentState === 'active') {
    socket.emit('deactivate-question', { sessionId: currentSessionId, token: HOST_TOKEN });
  } else {
    socket.emit('activate-question', {
      question: selectedQuestion,
      sessionId: currentSessionId,
      token: HOST_TOKEN,
      title: currentTitle,
    });
    revealedCorrectIndices = [];
    renderBarChart(selectedQuestion.answers, currentVotes, currentTotal, []);
    setState('active');
  }
}
window.activateQuestion = activateQuestion;

// ─── Reveal answer ────────────────────────────────────────────────────────────
function revealAnswer() {
  if (!currentSessionId || !selectedQuestion) return;
  socket.emit('show-answer', { sessionId: currentSessionId, token: HOST_TOKEN });
}
window.revealAnswer = revealAnswer;

// ─── Close question ───────────────────────────────────────────────────────────
function closeQuestion() {
  // Close always dismisses the inline card back to a snippet. If a poll is live
  // (active/deactivated/revealed) it also tears it down server-side, sending
  // participants to the waiting screen. inactive/closed have no live poll to clear.
  const pollIsLive = ['active', 'deactivated', 'revealed'].includes(currentState);
  if (pollIsLive && currentSessionId) {
    selfInitiatedClose = true; // the echo is just confirming this teardown; the card is collapsed below
    socket.emit('close-question', { sessionId: currentSessionId, token: HOST_TOKEN });
  }
  collapseActive();
}
window.closeQuestion = closeQuestion;

function nextQuestion() {
  if (selectedIndex < questions.length - 1) selectQuestion(selectedIndex + 1);
}
window.nextQuestion = nextQuestion;

// ─── Optional shortlink ───────────────────────────────────────────────────────
// Lecturer-provided link from config.yaml (host_shortlink). Display only:
// QuiQui shows it but never resolves or checks where it points. The server has
// already normalised it (trim + scheme prefix), so it is null or ready to use.
function setShortlink(shortlink) {
  const label = document.getElementById('shortlink-label');
  const link = document.getElementById('shortlink-url');
  if (!shortlink) {
    label.style.display = 'none';
    link.style.display = 'none';
    return;
  }
  link.textContent = shortlink;
  link.href = shortlink;
  label.style.display = '';
  link.style.display = '';
}

// ─── QR code ──────────────────────────────────────────────────────────────────
async function fetchQR(url) {
  try {
    const res = await fetch(`${BASE_PATH}/api/qr?url=${encodeURIComponent(url)}`, {
      headers: { 'X-Host-Token': HOST_TOKEN },
    });
    const data = await res.json();
    qrImg.src = data.dataUrl;
    qrImg.style.display = '';
  } catch (_) {}
}

// ─── Connection indicator ─────────────────────────────────────────────────────
socket.on('connect', () => {
  connectionIndicator.classList.remove('connection-indicator--off');
  connectionIndicator.title = 'Connected';
  // Re-join the session room after a (re)connect — the new socket id is not in
  // the room, so without this vote-update and button-echo broadcasts would stop
  // reaching us, leaving frozen bars and seemingly dead buttons.
  if (currentSessionId && !sessionExpired) {
    socket.emit('join-session', { sessionId: currentSessionId });
  }
});

socket.on('disconnect', () => {
  connectionIndicator.classList.add('connection-indicator--off');
  connectionIndicator.title = 'Disconnected — reconnecting…';
});

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('vote-update', ({ votes, total }) => {
  if (!selectedQuestion) return;
  currentVotes = votes;
  currentTotal = total;
  statAnsweredBadge.textContent = `${total} answered`;
  renderBarChart(selectedQuestion.answers, votes, total, revealedCorrectIndices);
});

socket.on('question-deactivated', ({ votes, total }) => {
  if (!selectedQuestion) return;
  currentVotes = votes;
  currentTotal = total;
  statAnsweredBadge.textContent = `${total} answered`;
  renderBarChart(selectedQuestion.answers, votes, total, []);
  setState('deactivated');
});

socket.on('answer-revealed', ({ correctIndices, votes, total }) => {
  if (!selectedQuestion) return;
  currentVotes = votes;
  currentTotal = total;
  revealedCorrectIndices = correctIndices;
  statAnsweredBadge.textContent = `${total} answered`;
  renderBarChart(selectedQuestion.answers, votes, total, correctIndices);
  setState('revealed');
});

socket.on('question-closed', () => {
  // Closes initiated by the host (✕ Close, or switching questions) already
  // updated the UI synchronously — this echo just confirms the server teardown,
  // so it is a no-op. An echo arriving unsolicited is a server-side close; fall
  // back to the closed state so the card reflects that the poll is gone.
  if (selfInitiatedClose) {
    selfInitiatedClose = false;
    return;
  }
  setState('closed');
});

socket.on('session-expired', ({ sessionId } = {}) => {
  // Ignore expiries belonging to other concurrent sessions — this event is
  // room-scoped, but guard on sessionId in case a stray/global emit arrives.
  if (sessionId && sessionId !== currentSessionId) return;
  sessionExpired = true;
  currentSessionId = null;
  btnActivate.disabled = true;
  btnShowAnswer.disabled = true;
  btnClose.disabled = true;
  btnNext.style.display = 'none';
  parkActiveCard();
  questionList.querySelectorAll('.q-item').forEach(el => { el.style.display = ''; el.classList.remove('active-q'); });
  selectedQuestion = null;
  selectedIndex = -1;
  statusBadge.style.display = 'none';
  setStatus('Session has expired. Pull the repo again to start a new session.', true);
});

// ─── Bar chart ────────────────────────────────────────────────────────────────
function renderBarChart(answers, votes, total, correctIndices = []) {
  barChart.innerHTML = '';
  const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
  answers.forEach((ans, i) => {
    const count = (votes && votes[i]) || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const isCorrect = correctIndices.includes(i);
    const block = document.createElement('div');
    block.className = 'answer-opt'
      + (isCorrect ? ' answer-correct' : '')
      + (selectedQuestion?.type === 'multiple' ? ' opt-multi' : '');
    block.style.cursor = 'default';
    block.innerHTML = `
      <div class="opt-key">${keys[i] || i + 1}</div>
      <div style="flex:1">
        <div>${mdInline(ans)}</div>
        <div class="opt-bar-wrap visible">
          <div class="opt-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="opt-bar-pct visible">${pct}% (${count})</div>
      </div>
    `;
    barChart.appendChild(block);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Inline preview for the question list — collapses multiline, converts $$...$$ to $...$
function previewQuestion(s) {
  return s
    .replace(/```[\s\S]*?```/gs, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => `[image: ${alt}]`)
    .replace(/\$\$([\s\S]*?)\$\$/gs, (_, m) => `$${m.replace(/\s+/g, ' ').trim()}$`)
    .replace(/\s+/g, ' ')
    .trim();
}

// Question/answer content comes from a public GitHub repo, so it is untrusted.
// Sanitise the rendered Markdown/LaTeX to strip embedded HTML/JS (XSS).
// DOMPurify's default profile permits HTML + SVG + MathML, preserving KaTeX output.
function mdHtml(s) { return DOMPurify.sanitize(marked.parse(s)); }
function mdInline(s) { return DOMPurify.sanitize(marked.parseInline(s)); }

// Escape a plain string for safe insertion into HTML text/attribute contexts.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
