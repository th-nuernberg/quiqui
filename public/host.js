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
  // Repo-relative image paths (![](grafiken/x.png)) are rewritten to this
  // session's /assets route so the host preview shows the same images the room
  // sees. currentSessionId is set after a pull; before that (no session yet)
  // the rewrite is a no-op. Absolute and data: srcs pass through untouched.
  if (node.tagName === 'IMG') rewriteImgSrc(node, currentSessionId);
});

// Point a relative <img src> at this session's /assets route. No-op for absolute
// or data: URLs, or when we don't have a sessionId yet.
function rewriteImgSrc(node, sessionId) {
  const src = node.getAttribute('src') || '';
  if (!sessionId || !src || /^(https?:|data:|\/\/)/i.test(src)) return;
  const clean = src.replace(/^\.?\//, '').replace(/^\/+/, '');
  node.setAttribute('src', `${BASE_PATH}/assets/${encodeURIComponent(sessionId)}/${clean}`);
}

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
// Indices opened for voting at least once this session — greyed out in the list
// (see renderQuestionList) so a long deck stays easy to orient in. Marked in
// setState() the moment a question goes 'active', not merely on preview/select,
// so browsing the list without opening anything doesn't grey it out. Reset on
// every fresh pull/file load alongside the rest of the per-load state.
let visitedIndices = new Set();
let runStart = 0;        // Date.now() when the current active spell began
let runTimer = null;     // setInterval handle for the live stopwatch
let livePollTimer = null; // setInterval handle for the active-poll liveness backstop
let runAccumulated = 0;  // ms of open time from prior active spells (before pauses),
                         // so re-opening a paused question resumes the elapsed count
                         // rather than restarting; reset to 0 when a new question is selected
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
  // crypto.randomUUID() only exists in a secure context (https:// or
  // localhost) — on a plain http://<lan-ip-or-hostname> page (e.g. a host
  // testing from a phone over LAN) `crypto.randomUUID` is undefined and
  // throws, killing the rest of this script before any button listener is
  // attached. This value is just a per-browser identity, not a security
  // credential, so a non-cryptographic fallback is fine.
  OWNER_TOKEN = Date.now().toString(36) + Math.random().toString(36).slice(2);
  localStorage.setItem(OWNER_TOKEN_KEY, OWNER_TOKEN);
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const repoInput        = document.getElementById('repo-url');
const btnPull          = document.getElementById('btn-pull');
const fileSelect       = document.getElementById('file-select');
const fileRow          = document.getElementById('file-row');
const fileDropdown     = document.getElementById('file-dropdown');
const fileSelectBtn    = document.getElementById('file-select-btn');
const fileSelectLabel  = document.getElementById('file-select-label');
const fileSelectMenu   = document.getElementById('file-select-menu');
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
const localSourceRow  = document.getElementById('local-source-row');
const btnChooseFile   = document.getElementById('btn-choose-file');
const localFileInput  = document.getElementById('local-file-input');
const localLoadedRow  = document.getElementById('local-loaded-row');
const localFileName   = document.getElementById('local-file-name');
const btnReplaceFile  = document.getElementById('btn-replace-file');
const switchToFile    = document.getElementById('switch-to-file');
const switchToRepo    = document.getElementById('switch-to-repo');
const repoRow         = document.getElementById('repo-row');

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  const params = new URLSearchParams(window.location.search);
  const repo = params.get('repo');
  if (repo) repoInput.value = repo;

  btnPull.addEventListener('click', () => pullRepo());
  repoInput.addEventListener('keydown', e => { if (e.key === 'Enter') pullRepo(); });
  fileSelect.addEventListener('change', loadFile);
  initFileDropdown();

  btnChooseFile.addEventListener('click', () => localFileInput.click());
  btnReplaceFile.addEventListener('click', () => localFileInput.click());
  localFileInput.addEventListener('change', onLocalFileChosen);
  switchToFile.addEventListener('click', showFileSource);   // reveal the Choose-file option
  switchToRepo.addEventListener('click', showRepoSource);   // reveal the repo row again

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

// ─── Custom file dropdown ──────────────────────────────────────────────────
// Replaces the native <select> UI (see the comment on #file-select in
// host.html). The hidden #file-select stays the single source of truth for
// the current value: choosing an item here just sets fileSelect.value and
// dispatches 'change', so loadFile() — and everything else — is unchanged.
function initFileDropdown() {
  fileSelectBtn.addEventListener('click', () => {
    if (fileSelectMenu.hidden) openFileDropdown(); else closeFileDropdown();
  });
  fileSelectBtn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openFileDropdown();
      fileSelectMenu.querySelector('[aria-selected="true"], .dropdown-item')?.focus();
    }
  });
  document.addEventListener('click', e => {
    if (!fileDropdown.contains(e.target)) closeFileDropdown();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !fileSelectMenu.hidden) { closeFileDropdown(); fileSelectBtn.focus(); }
  });
}

function openFileDropdown() {
  if (!fileSelectMenu.children.length) return; // nothing to pick yet
  fileSelectMenu.hidden = false;
  fileSelectBtn.setAttribute('aria-expanded', 'true');
}

function closeFileDropdown() {
  fileSelectMenu.hidden = true;
  fileSelectBtn.setAttribute('aria-expanded', 'false');
}

// Rebuild the dropdown's rows from the same filenames used to populate the
// hidden <select> (see pullRepo). Called once per pull, right after that.
function renderFileDropdown() {
  fileSelectMenu.innerHTML = '';
  [...fileSelect.options].forEach(opt => {
    if (!opt.value) return; // skip the placeholder option
    const li = document.createElement('li');
    li.className = 'dropdown-item';
    li.textContent = opt.value;
    li.title = opt.value; // full name on hover/long-press since the row itself truncates
    li.setAttribute('role', 'option');
    li.tabIndex = -1;
    li.setAttribute('aria-selected', opt.value === fileSelect.value ? 'true' : 'false');
    li.addEventListener('click', () => selectFile(opt.value));
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFile(opt.value); }
      if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling?.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); (li.previousElementSibling || fileSelectBtn).focus(); }
      if (e.key === 'Escape')    { closeFileDropdown(); fileSelectBtn.focus(); }
    });
    fileSelectMenu.appendChild(li);
  });
}

function selectFile(value) {
  fileSelect.value = value;
  fileSelectLabel.textContent = value;
  fileSelectLabel.title = value;
  fileSelectMenu.querySelectorAll('.dropdown-item').forEach(li => {
    li.setAttribute('aria-selected', li.textContent === value ? 'true' : 'false');
  });
  closeFileDropdown();
  fileSelectBtn.focus();
  fileSelect.dispatchEvent(new Event('change'));
}

// ─── Shared post-load setup (repo pull and local upload both land here) ───────
// Everything that doesn't depend on where the session came from: join info,
// QR, title, and resetting question-list/selection state for the fresh load.
// File-list display (dropdown vs. single filename) and the status message are
// source-specific and stay in pullRepo()/uploadFile().
function applyLoadedSession(data) {
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

  sectionQuestions.style.display = 'none';
  parkActiveCard();
  questionList.innerHTML = '';
  selectedQuestion = null;
  selectedIndex = -1;
  revealedCorrectIndices = [];
}

// ─── Source view-state helpers ─────────────────────────────────────────────────
// Repo loaded: show multi-file dropdown, offer switch-to-file link.
function showRepoLoadedView() {
  repoRow.style.display = '';   // ensure visible even if a prior file-source switch hid it
  fileRow.style.display = '';
  localLoadedRow.style.display = 'none';
  localSourceRow.style.display = 'none';   // hide the blank-state Choose-file option
  switchToFile.style.display = '';
  switchToRepo.style.display = 'none';
}

// Local file loaded: show filename + Replace, collapse repo row to a link.
function showLocalLoaded(name) {
  fileRow.style.display = 'none';
  localLoadedRow.style.display = '';
  localFileName.value = name;   // #local-file-name is a read-only <input> (framed box)
  localFileName.title = name;
  repoRow.style.display = 'none';
  localSourceRow.style.display = 'none';
  switchToFile.style.display = 'none';
  switchToRepo.style.display = '';
}

// Muted-link handlers — switch the visible source back to the other kind. The
// user is choosing a different source, so the current source's loaded display is
// collapsed and the other source's input revealed; the opposite muted link is
// restored so neither source is ever stranded. The underlying session/questions
// stay loaded until the new source is actually loaded.
function showFileSource() {   // from a repo-loaded state, user wants a local file
  fileRow.style.display = 'none';         // hide the multi-file dropdown
  repoRow.style.display = 'none';         // hide the repo URL input + From GitHub button
  localSourceRow.style.display = '';      // reveal the Choose-file option
  switchToFile.style.display = 'none';
  switchToRepo.style.display = '';        // offer the way back to the repo view
}
function showRepoSource() {    // from a local-loaded state, user wants a repo
  localLoadedRow.style.display = 'none';  // hide the loaded-file name + Replace
  repoRow.style.display = '';             // reveal the repo URL input
  switchToRepo.style.display = 'none';
  switchToFile.style.display = '';        // offer the way back to the file view
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

    // Populate file dropdown — hidden until a repo is pulled for the first time.
    // fileSelect is the real (visually hidden) value/change source of truth;
    // renderFileDropdown() below builds the visible custom UI from these options.
    fileSelect.innerHTML = '<option value="">— select a question file —</option>';
    data.files.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      fileSelect.appendChild(opt);
    });
    fileSelectLabel.textContent = '— select a question file —';
    fileSelectLabel.title = '';
    renderFileDropdown();

    applyLoadedSession(data);
    showRepoLoadedView();

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
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    btnPull.disabled = false;
  }
}

// ─── Local file upload ──────────────────────────────────────────────────────────
async function uploadFile(file, force = false) {
  const text = await file.text();
  setStatus('Loading file…');
  try {
    const res = await fetch(`${BASE_PATH}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': HOST_TOKEN },
      body: JSON.stringify({ text, filename: file.name, ownerToken: OWNER_TOKEN, force }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.code === 'SESSION_LIKELY_TAKEN') {
        setStatus('Session may be in use elsewhere.', true);
        if (confirm(`${data.error}\n\nEnter anyway? (Only do this if you're sure the other session isn't a colleague's live poll.)`)) {
          return uploadFile(file, true);
        }
        return;
      }
      if (data.code === 'EXAMPLE_SESSION_URL') {
        setStatus('This file still uses the demo session_url.', true);
        if (confirm(`${data.error}`)) {
          return uploadFile(file, true);
        }
        return;
      }
      throw new Error(data.error);
    }

    applyLoadedSession(data);              // shared join-info / session setup
    showLocalLoaded(data.uploadedName || file.name);   // filename display + collapse repo row

    // No status line needed — the filename is shown in its own field (see
    // #local-loaded-row). Just clear any prior error/loading text.
    pullStatus.classList.remove('meta-line--error');
    pullStatus.textContent = '';

    // A local upload has exactly one file, already stored — select it now to
    // load the questions immediately (same as choosing it from the dropdown).
    fileSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = data.storedName;
    opt.textContent = data.storedName;
    fileSelect.appendChild(opt);
    fileSelect.value = data.storedName;
    renderFileDropdown();   // keep the (hidden) custom dropdown in sync in case the host later switches to a repo
    fileSelect.dispatchEvent(new Event('change'));   // → loadFile()
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    localFileInput.value = '';   // allow re-choosing the same file
  }
}

function onLocalFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (file) uploadFile(file);
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
    visitedIndices = new Set(); // fresh file/reload — nothing opened yet
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
    item.className = 'q-item' + (visitedIndices.has(i) ? ' visited' : '');
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
  // away tears it down server-side and sends those participants to the waiting screen.
  // Confirm first for active/deactivated — voting could still be in progress there, or
  // the host hasn't shown correct answers yet, so switching away is easy to do by
  // accident. revealed means the host has already finished with this question (answers
  // shown, nothing left to lose), so advancing — e.g. via Next question — proceeds
  // straight through with no prompt.
  const pollIsLive = ['active', 'deactivated', 'revealed'].includes(currentState);
  const needsConfirm = ['active', 'deactivated'].includes(currentState);
  if (needsConfirm && !confirm('Close the current poll and switch to this question?')) return;
  if (pollIsLive && currentSessionId) {
    selfInitiatedClose = true; // the echo is just confirming this teardown; the new card is rendered below
    socket.emit('close-question', { sessionId: currentSessionId, token: HOST_TOKEN });
  }
  selectedIndex = index;
  selectedQuestion = questions[index];
  revealedCorrectIndices = [];
  runAccumulated = 0;  // fresh question — the resumable timer starts from zero
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

  const correct = selectedQuestion.correct;
  const letters = correct != null
    ? (Array.isArray(correct) ? correct : [correct]).map(l => String(l).trim()[0].toUpperCase()).join(', ')
    : null;

  if (letters != null && selectedQuestion.explanation) {
    explanationEl.innerHTML = `${letters}: ${mdInline(selectedQuestion.explanation)}`;
    explanationEl.style.display = '';
  } else if (selectedQuestion.explanation) {
    explanationEl.innerHTML = mdInline(selectedQuestion.explanation);
    explanationEl.style.display = '';
  } else if (letters != null) {
    explanationEl.innerHTML = `Correct: ${letters}`;
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
    item.focus({ preventScroll: true });
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
    deactivated: '◼ Paused',
    revealed:    '◼ Revealed',
    closed:      '◼ Closed',
  };
  statusBadge.style.display = state ? '' : 'none';
  if (state === 'active') {
    // Opened for voting — mark it visited so the list greys it out from now on
    // (see renderQuestionList / .q-item.visited in style.css).
    if (selectedIndex >= 0) {
      visitedIndices.add(selectedIndex);
      questionList.querySelector(`.q-item[data-index="${selectedIndex}"]`)?.classList.add('visited');
    }
    // While active, the badge becomes a live red stopwatch counting up.
    startStopwatch();
  } else {
    stopStopwatch();
    const badgeMod = state === 'inactive' ? ' badge-inactive' : ' badge-closed';
    statusBadge.textContent = labels[state] || '';
    statusBadge.className = 'badge-live' + badgeMod;
  }

  // Activate button toggles label and tooltip based on state
  btnActivate.textContent = state === 'active' ? '⏸ Pause' : '▶ Open';
  btnActivate.title = state === 'active'
    ? 'Pause voting, but do not reveal correct answer(s), re-opening possible.'
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
  runStart = Date.now();         // begin a new active spell; runAccumulated holds prior ones
  renderStopwatch();
  runTimer = setInterval(renderStopwatch, 1000);
  startLivenessPoll();
}

function stopStopwatch() {
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
    // Fold the spell just ended into the accumulator so a later re-open resumes
    // from here. Paused time (between now and the next start) is not counted.
    runAccumulated += Date.now() - runStart;
  }
  stopLivenessPoll();
}

// Active-poll liveness backstop. A live poll bumps lastActivity server-side only
// on host clicks and votes; a question left open with no votes goes idle and is
// expired after SESSION_TIMEOUT_MINUTES (default 90). The expiry is announced by
// a single room-scoped session-expired emit — if that one delivery is missed
// (e.g. no reconnect happens to re-sync state), the host would tick a stopwatch
// forever against a dead session with unresponsive buttons. This poll asks the
// server whether the session still exists while a poll is live; a null session
// means it's gone. ~30s cadence is far below the 90-min timeout, so at most one
// stale tick slips through. Scoped to the stopwatch lifetime, so it's torn down
// on every path that leaves the active panel (pause, reveal, close, pull, expiry).
function startLivenessPoll() {
  if (livePollTimer) return;
  livePollTimer = setInterval(checkSessionAlive, 30000);
}

function stopLivenessPoll() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

async function checkSessionAlive() {
  if (!currentSessionId || sessionExpired) return;
  try {
    const res = await fetch(`${BASE_PATH}/api/session?sessionId=${encodeURIComponent(currentSessionId)}`, {
      headers: { 'X-Host-Token': HOST_TOKEN },
    });
    if (!res.ok) return;                       // transient error — try again next tick
    const data = await res.json();
    if (data.session === null) handleSessionGone();
  } catch {
    // Network blip — leave the session alone and retry on the next tick.
  }
}

function renderStopwatch() {
  const secs = Math.floor((runAccumulated + (Date.now() - runStart)) / 1000);
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

// Tear the host UI down to the "session gone" state. Shared by the room-scoped
// session-expired emit, the reconnect-time session-state({exists:false}) reply,
// and the active-poll backstop poll below — any one of them can be the first (or
// only) signal that the server has expired the session, so all three funnel here.
// Idempotent: guarded by sessionExpired so a second trigger is a no-op.
function handleSessionGone() {
  if (sessionExpired) return;
  sessionExpired = true;
  currentSessionId = null;
  stopStopwatch();
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
}

socket.on('session-expired', ({ sessionId } = {}) => {
  // Ignore expiries belonging to other concurrent sessions — this event is
  // room-scoped, but guard on sessionId in case a stray/global emit arrives.
  if (sessionId && sessionId !== currentSessionId) return;
  handleSessionGone();
});

// Reconnect-after-expiry catch. If the host socket was briefly disconnected
// (laptop sleep, Wi-Fi blip) exactly when the session expired, the room-scoped
// session-expired emit never reached it. On reconnect the host re-joins its room
// (see the 'connect' handler) and the server replies with session-state; when
// that says the session no longer exists, we learn about the expiry here instead.
socket.on('session-state', ({ exists } = {}) => {
  // Only act on a reply for our own current session. exists:false means the
  // server has no such session — it was expired while we were away. An idle host
  // (currentSessionId null, or already torn down) has nothing to react to;
  // handleSessionGone is itself idempotent via the sessionExpired guard.
  if (exists === false && currentSessionId) handleSessionGone();
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
