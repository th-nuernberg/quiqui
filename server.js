const fs = require('fs');
const path = require('path');
const envPath = fs.existsSync(path.join(__dirname, '.env')) ? path.join(__dirname, '.env') : '/etc/secrets/.env';
require('dotenv').config({ path: envPath });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto'); // used for random session ID fallback
const yaml = require('js-yaml');
const simpleGit = require('simple-git');
const QRCode = require('qrcode');

// Reverse-proxy path prefix the app is served under, e.g. "/quiqui". Empty means
// the app owns the domain root (the default — Render, local dev). Set this when a
// proxy forwards a subpath *without* stripping it (see README "Running behind a
// reverse-proxy subpath"). Normalised to a single leading slash, no trailing slash.
const BASE_PATH = (() => {
  const raw = (process.env.BASE_PATH || '').trim().replace(/\/+$/, ''); // drop trailing slash(es)
  if (!raw) return '';                                                  // empty → root deployment
  return '/' + raw.replace(/^\/+/, '');                                 // exactly one leading slash
})();

const app = express();
const server = http.createServer(app);
// Heartbeat tolerant of an idle host (no action for a couple of minutes):
// a missed pong within pingInterval + pingTimeout drops the connection, so keep
// the window generous. The real recovery is the host re-joining its room on
// reconnect (see public/host.js) — this just reduces how often that happens.
// The socket.io endpoint lives under BASE_PATH too, so clients behind the proxy
// reach it at `${BASE_PATH}/socket.io` (see the client `io()` calls).
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  path: `${BASE_PATH}/socket.io`,
});

const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const log = {
  info:  (...args) => { if (LOG_LEVEL === 'INFO')  console.log( `[${new Date().toISOString().slice(0, 19)}Z] INFO `, ...args); },
  error: (...args) => {                             console.error(`[${new Date().toISOString().slice(0, 19)}Z] ERROR`, ...args); },
};

const PORT = process.env.PORT || 3000;
const HOST_SLUG = process.env.HOST_SLUG || 'host';
const DEFAULT_REPO_URL = process.env.DEFAULT_REPO_URL || 'https://github.com/th-nuernberg/quiqui-questions';
const SESSIONS_DIR = path.join(__dirname, 'tmp', 'sessions');

// App version (from package.json) shown in the footer of every client view,
// linking to the GitHub releases page. Single source of truth: bumping
// package.json updates the footer everywhere.
const APP_VERSION = require('./package.json').version;
const VERSION_LINK = 'https://github.com/th-nuernberg/quiqui/releases';
const VERSION_HTML =
  `<a href="${VERSION_LINK}" target="_blank" rel="noopener" title="Release notes on GitHub">Version ${APP_VERSION}</a>`;

// 90 minutes after last question activation. Overridable via SESSION_TIMEOUT_MINUTES
// (env, in minutes); the test suite can pass a fractional value to force a fast expiry.
const SESSION_TIMEOUT_MS = (Number(process.env.SESSION_TIMEOUT_MINUTES) || 90) * 60 * 1000;
// Size limits — all overridable via env (in KB). Defaults keep small repos cheap:
//   REPO  — whole repo, checked via GitHub API before clone (GitHub reports KB)
//   FILE  — a single question YAML file, checked on load
//   IMAGE — a single image served from the clone via /assets (see route below)
const REPO_SIZE_LIMIT_KB  = Number(process.env.REPO_SIZE_LIMIT_KB)  || 1024; // 1 MB
const FILE_SIZE_LIMIT_KB  = Number(process.env.FILE_SIZE_LIMIT_KB)  || 100;  // 100 KB per question file
const IMAGE_SIZE_LIMIT_KB = Number(process.env.IMAGE_SIZE_LIMIT_KB) || 512;  // 512 KB per image

// Image extensions the /assets route will serve from a pulled clone. Anything
// else (config.yaml, .git/*, arbitrary files) is refused — /assets is an image
// host for question repos, not a general file server. Kept lowercase; the route
// lowercases the requested extension before checking.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

// ─── In-memory session state ──────────────────────────────────────────────────
// Map of sessionId → session object.
// { sessionId, repoUrl, questionsDir, activeQuestion, title, shuffle, votes, voters, open, lastActivity }
const sessions = new Map();

// Single interval that reaps sessions idle for longer than SESSION_TIMEOUT_MS.
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    if (now - s.lastActivity > SESSION_TIMEOUT_MS) {
      expireSession(sessionId);
    }
  }
}, Math.min(10000, Math.max(1000, SESSION_TIMEOUT_MS / 4))); // 10 s normally; faster when the timeout is shortened for tests

// ─── Static files ─────────────────────────────────────────────────────────────
// Everything is served with `Cache-Control: no-cache` so clients must revalidate
// with the server (via ETag) before reusing a cached copy — the browser still
// stores files and gets fast 304s, but a new deploy or a local edit is picked up
// immediately. This matters because QuiQui has no build step or hashed filenames,
// and because some clients (iOS "Add to Home Screen" web clips) cache very
// aggressively; without this a stale document or a stale style.css/host.js would
// linger after an update.
const noCache = res => res.set('Cache-Control', 'no-cache');

// Under a reverse-proxy subpath the browser must resolve every relative asset
// (style.css, socket.io, logo, …) against BASE_PATH, and client JS needs to know
// the prefix for fetch()/socket paths. A single injected block does both:
//   • <base href="${BASE_PATH}/"> — makes relative URLs resolve under the prefix.
//     Requires the HTML to use *relative* asset paths (style.css, not /style.css).
//   • window.__BASE_PATH__ — read by host.js/participant.js/projector.js.
// At root (BASE_PATH === '') href is "/" and the prefix is "", i.e. a no-op.
const baseTag = `<base href="${BASE_PATH}/" />\n  <script>window.__BASE_PATH__ = ${JSON.stringify(BASE_PATH)};</script>`;
const injectBase = html => html.replace('<head>', `<head>\n  ${baseTag}`);

// Pages that carry the footer version link are read once at startup and have
// their __VERSION__ placeholder substituted, plus the <base> block injected.
// index.html must be served by an explicit route registered *before*
// express.static, otherwise the static middleware would serve the raw
// (un-templated) file at '/'.
const renderHtml = file =>
  injectBase(fs.readFileSync(path.join(__dirname, 'public', file), 'utf8').replace('__VERSION__', VERSION_HTML));
const indexHtml       = renderHtml('index.html');
const participantHtml = renderHtml('participant.html');
const privacyHtml     = renderHtml('privacy.html');
const projectorHtml   = renderHtml('projector.html');
const sendHtml = (res, html) => noCache(res).type('html').send(html);

// Prefix-strip middleware: when the app is served under a proxy subpath that is
// *not* stripped by the proxy (e.g. requests arrive as /quiqui/api/pull), rewrite
// req.url down to the root form (/api/pull) before any route matches. This keeps
// every route definition below written against the root path — the prefix lives
// in exactly this one place. A no-op when BASE_PATH is empty. socket.io is not
// affected: it matches on its configured `path` before Express sees the request.
//
// Anything NOT under the prefix is 404'd rather than falling through to the root
// routes: the app declares it lives at BASE_PATH, so it shouldn't also answer
// off-prefix (e.g. serve /style.css when mounted at /quiqui). Real traffic only
// ever arrives prefixed; this just refuses to double-serve.
if (BASE_PATH) {
  app.use((req, res, next) => {
    if (req.url === BASE_PATH) {
      // Bare prefix with no trailing slash (/quiqui) → treat as the root ('/').
      req.url = '/';
    } else if (req.url.startsWith(BASE_PATH + '/')) {
      req.url = req.url.slice(BASE_PATH.length) || '/';
    } else {
      return res.status(404).type('txt').send('Not found');
    }
    next();
  });
}

app.get('/', (req, res) => sendHtml(res, indexHtml));

// `no-cache` on every static asset — not just HTML. QuiQui has no build step or
// hashed filenames, so a browser that heuristically caches style.css / host.js
// would keep serving a stale copy after a deploy (and during local iteration).
// `no-cache` means "always revalidate": the browser still stores the file but
// re-checks the ETag each load, so an edit is picked up immediately while an
// unchanged file returns a fast 304. Cheap for these small vanilla assets.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => noCache(res),
}));
// Default express.json() body limit is 100kb — the same order of magnitude as
// FILE_SIZE_LIMIT_KB (also 100 KB by default), so a local upload just over the
// limit would be rejected by this raw body-size check before /api/upload's own
// FILE_SIZE_LIMIT_KB guard runs, surfacing Express's generic HTML 413 page
// (with a stack trace) instead of our clean JSON error. Give the parser enough
// headroom over the largest size guard we enforce ourselves (with margin for
// JSON/base64 overhead around the raw text) so our own checks are always the
// ones that fire.
app.use(express.json({ limit: `${Math.max(FILE_SIZE_LIMIT_KB, REPO_SIZE_LIMIT_KB) * 2}kb` }));

// ─── Middleware ───────────────────────────────────────────────────────────────

function requireHost(req, res, next) {
  if (req.headers['x-host-token'] !== HOST_SLUG) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Stable directory name for a repo — sanitised from the URL for easy debugging
// e.g. https://github.com/th-nuernberg/quiqui-questions → github.com-th-nuernberg-quiqui-questions
function repoDirName(repoUrl) {
  return repoUrl
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

const MAX_ANSWERS = 6;
const VALID_TYPES = new Set(['single', 'multiple']);
const VALID_LETTERS = new Set('abcdefghijklmnopqrstuvwxyz'.slice(0, MAX_ANSWERS).split(''));

// Validate a parsed question list from a YAML file. Returns an error string or null.
function validateQuestions(questions, file) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return `${file}: must contain a non-empty list of questions.`;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const label = `${file}, question ${i + 1}`;

    if (!q || typeof q !== 'object') return `${label}: not a valid object.`;
    if (typeof q.question !== 'string' || !q.question.trim())
      return `${label}: "question" must be a non-empty string.`;
    if (!VALID_TYPES.has(q.type))
      return `${label}: "type" must be "single" or "multiple" (got ${JSON.stringify(q.type)}).`;
    if (!Array.isArray(q.answers) || q.answers.length < 2)
      return `${label}: "answers" must be a list of at least 2 options.`;
    if (q.answers.length > MAX_ANSWERS)
      return `${label}: "answers" has ${q.answers.length} options — maximum is ${MAX_ANSWERS}.`;
    if (q.answers.some(a => typeof a !== 'string' || !a.trim()))
      return `${label}: every answer must be a non-empty string.`;

    // Validate correct field (optional — omit for generic/unscored questions)
    const letters = Array.isArray(q.correct) ? q.correct : (q.correct != null ? [q.correct] : []);
    if (letters.length === 0) continue;
    for (const l of letters) {
      const ch = String(l).trim()[0]?.toLowerCase();
      if (!ch || !VALID_LETTERS.has(ch))
        return `${label}: "correct" contains invalid letter ${JSON.stringify(l)} — use A–${String.fromCharCode(64 + MAX_ANSWERS)}.`;
      const idx = ch.charCodeAt(0) - 97;
      if (idx >= q.answers.length)
        return `${label}: "correct" refers to ${String(l).trim()[0].toUpperCase()} but there are only ${q.answers.length} answers.`;
    }
    if (q.type === 'single' && letters.length > 1)
      return `${label}: type is "single" but "correct" lists ${letters.length} answers.`;
  }
  return null;
}

// A questions YAML file comes in two shapes:
//   1. classic — a bare top-level list of question objects
//   2. bundled — a map { config: {...}, questions: [...] }, self-contained and
//      also loadable as a single local upload. Inside a repo the `config:`
//      section is illustrative and ignored (the repo's config.yaml leads); only
//      on the /api/upload path is it honoured.
// Returns { config, questions }. config is {} for the classic shape. Detection
// is unambiguous: an array is classic; a map with a `questions` key is bundled;
// anything else falls through with the raw value so validateQuestions rejects it
// with its normal "must contain a non-empty list of questions" message.
function normalizeQuestionFile(loaded) {
  if (Array.isArray(loaded)) return { config: {}, questions: loaded };
  if (loaded && typeof loaded === 'object' && 'questions' in loaded) {
    const config = (loaded.config && typeof loaded.config === 'object' && !Array.isArray(loaded.config))
      ? loaded.config : {};
    return { config, questions: loaded.questions };
  }
  return { config: {}, questions: loaded };
}

// Normalise the correct field (array or single value) to 0-based answer indices.
// Accepts e.g. ['A','b','C'], 'B', or a bare YAML letter that js-yaml parsed as a string.
function toCorrectIndices(correct) {
  const letters = Array.isArray(correct) ? correct : (correct ? [correct] : []);
  return letters
    .map(l => String(l).trim()[0]?.toLowerCase())  // take only the first character
    .filter(Boolean)
    .map(l => 'abcdefghijklmnopqrstuvwxyz'.indexOf(l))
    .filter(i => i >= 0);
}

// Fisher–Yates shuffle of one question's answers, keeping the correct-answer
// letters pointing at their options. Returns a NEW question object; the input is
// untouched. Answers are permuted and the `correct` field is rewritten to the
// letters of the answers' new positions, so toCorrectIndices() and the reveal
// stay correct with no changes downstream. Questions with fewer than 2 answers
// (shouldn't happen post-validation) are returned unchanged.
function shuffleAnswers(q) {
  const n = q.answers.length;
  if (n < 2) return q;
  // Pair each answer with whether it is a correct one (by original index).
  const correctSet = new Set(toCorrectIndices(q.correct));
  const items = q.answers.map((text, i) => ({ text, correct: correctSet.has(i) }));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const answers = items.map(it => it.text);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const newCorrect = items
    .map((it, i) => (it.correct ? letters[i] : null))
    .filter(Boolean);
  // Match the original shape: single answer stays a bare letter, multiple stays a list.
  const correct = q.type === 'multiple' ? newCorrect : (newCorrect[0] || q.correct);
  return { ...q, answers, correct };
}

function touchSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastActivity = Date.now();
}

// Normalise an optional lecturer-provided shortlink (config.host_shortlink,
// falling back to the older config.student_shortlink key so existing question
// repos in the wild keep working after the field rename).
// Display-only: trimmed, with https:// prefixed if no scheme. Returns null if absent.
function normaliseShortlink(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// Register a brand-new session or refresh an existing one for the same source.
// Shared by /api/pull (repo) and /api/upload (local file). `existing` is
// sessions.get(sessionId) computed by the caller (may be undefined). Emits
// session-created to any waiting participants. Returns { sessionToken, shortlink }.
function registerSession({ sessionId, repoUrl, questionsDir, config, ownerToken, existing }) {
  const sessionToken = crypto.randomBytes(4).toString('hex'); // fresh on every (re)load
  const shortlink = normaliseShortlink(config.host_shortlink ?? config.student_shortlink);
  if (!existing) {
    sessions.set(sessionId, {
      sessionId,
      sessionToken,
      ownerToken: ownerToken || null,
      repoUrl,
      questionsDir,
      activeQuestion: null,
      title: config.title || null,
      shortlink,
      shuffle: config.shuffle === true,
      votes: {},
      voters: new Set(),
      open: false,
      answersRevealed: false,
      lastActivity: Date.now(),
    });
    log.info(`Session '${sessionId}' started`);
    log.info(`  source=${repoUrl}`);
    io.to(`session:${sessionId}`).emit('session-created', { title: config.title || null, sessionToken, shortlink });
  } else {
    log.info(`Session '${sessionId}' refreshed`);
    log.info(`  source=${repoUrl}`);
    existing.sessionToken = sessionToken;
    existing.ownerToken = ownerToken || existing.ownerToken;
    existing.questionsDir = questionsDir;
    existing.title = config.title || null;
    existing.shortlink = shortlink;
    existing.shuffle = config.shuffle === true;
    existing.answersRevealed = false;
    existing.lastActivity = Date.now();
    io.to(`session:${sessionId}`).emit('session-created', { title: config.title || null, sessionToken, shortlink });
  }
  return { sessionToken, shortlink };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve client-side bundles from node_modules
app.get('/marked.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
});
app.get('/katex.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'katex', 'dist', 'katex.min.js'));
});
app.get('/katex.min.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'katex', 'dist', 'katex.min.css'));
});
app.get('/katex-extension.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'marked-katex-extension', 'lib', 'index.umd.js'));
});
app.get('/purify.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'dompurify', 'dist', 'purify.min.js'));
});
// KaTeX fonts (referenced by katex.min.css as ./fonts/...)
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', 'katex', 'dist', 'fonts')));

// Host page — default repo URL injected from DEFAULT_REPO_URL env var
// (host.html lives in the project root, not public/ — see CLAUDE.md)
const hostHtml = injectBase(fs.readFileSync(path.join(__dirname, 'host.html'), 'utf8')
  .replace('__DEFAULT_REPO_URL__', DEFAULT_REPO_URL.replace(/"/g, '&quot;'))
  .replace('__VERSION__', VERSION_HTML));
app.get(`/${HOST_SLUG}`, (req, res) => {
  sendHtml(res, hostHtml);
});

// Participant join page
app.get('/join/:sessionId', (req, res) => {
  sendHtml(res, participantHtml);
});

// Projector view — read-only, shows QR + live results, optimised for beamer
app.get('/view/:sessionId', (req, res) => {
  sendHtml(res, projectorHtml);
});

// Repo images — serve an image referenced by a question with a repo-relative
// markdown path (e.g. ![](grafiken/foo.gif)) from that session's pulled clone.
//
// Public on purpose: participants and the projector render questions and have no
// host token, so images must load without one — exactly like /join and /view.
// The sessionId (session_url) is already the public join secret, so serving
// images under it leaks nothing the join URL doesn't. Only image extensions are
// served, so config.yaml, .git/*, and arbitrary repo files stay unreachable.
//
// The client rewrites relative image srcs to this shape (see mdHtml in the client
// JS); the wildcard captures the sub-path under the repo (may contain slashes).
app.get('/assets/:sessionId/*', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).type('txt').send('Not found');

  // Confirm the requested sub-path stays inside the clone. path.basename isn't
  // enough — images live in subdirs (grafiken/…) — so resolve and prefix-check
  // against the root. req.params[0] is already percent-decoded once by Express,
  // so no extra decodeURIComponent here (a second decode would mangle filenames
  // containing a literal % and re-open encoded-traversal). This lexical check
  // defuses `..` and absolute paths in the sub-path.
  const rel = req.params[0] || '';
  const root = path.resolve(s.questionsDir);
  const full = path.resolve(root, rel);
  const inside = p => p === root || p.startsWith(root + path.sep);
  if (!inside(full)) return res.status(403).type('txt').send('Forbidden');

  const ext = path.extname(full).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return res.status(403).type('txt').send('Forbidden');

  // The lexical check above is purely string maths — it can't see symlinks. A
  // committed symlink *directory* (e.g. `pics -> /`) would let `pics/etc/x.png`
  // resolve inside the root lexically yet point outside on disk. Resolve the
  // real path and re-check containment so a repo can't escape via any link in
  // the chain. realpath also collapses the final symlink; combined with the
  // lstat below (which refuses even an in-root final-component link) a repo
  // hands us no links at all.
  let real, realRoot;
  try { real = fs.realpathSync(full); realRoot = fs.realpathSync(root); }
  catch { return res.status(404).type('txt').send('Not found'); }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return res.status(403).type('txt').send('Forbidden');
  }

  // lstat, not stat: refuse a symlink even if it points back inside the root —
  // a repo shouldn't be able to hand us a link at all. Also gives the size.
  let st;
  try { st = fs.lstatSync(full); } catch { return res.status(404).type('txt').send('Not found'); }
  if (!st.isFile()) return res.status(404).type('txt').send('Not found');
  if (st.size > IMAGE_SIZE_LIMIT_KB * 1024) {
    return res.status(413).type('txt').send(`Image too large (max ${IMAGE_SIZE_LIMIT_KB} KB)`);
  }

  // nosniff + a locked-down CSP so an SVG served here can never execute script,
  // even if a browser were coaxed to treat it as a document. Images only ever
  // load via <img> (from markdown ![]()), where script never runs anyway; this
  // is belt-and-braces for the one format that can carry it.
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('Cache-Control', 'no-cache');
  res.type(IMAGE_MIME[ext] || 'application/octet-stream');
  // Give send() its own independent containment (root + dotfile refusal) as
  // defense in depth — a future regression in the checks above still can't
  // become a read primitive.
  res.sendFile(path.relative(root, full), { root, dotfiles: 'deny' });
});

// Legal pages
app.get('/impressum', (req, res) => {
  const raw = req.query.back || '';
  // Accept same-site paths only — reject protocol-relative ("//evil.com") open redirects
  const back = ((raw.startsWith('/') && !raw.startsWith('//')) || raw.startsWith(`${req.protocol}://${req.hostname}`)) ? raw : null;
  const logoHref = back || (BASE_PATH ? `${BASE_PATH}/` : '/');
  const backLink = back ? back : 'javascript:history.back()';

  function field(envVar, label) {
    const val = process.env[envVar];
    return val
      ? val
      : `<span class="placeholder">${label}</span>`;
  }

  const footerBack = back ? '?back=' + encodeURIComponent(back) : '';
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Impressum — QuiQui</title>
  ${baseTag}
  <link rel="stylesheet" href="style.css" />
  <style>
    .lang-nav { display:flex; gap:1rem; margin-bottom:1.5rem; }
    .lang-nav a { font-size:13px; font-weight:500; color:var(--color-text-muted); text-decoration:none; padding:4px 12px; border:0.5px solid var(--color-border-mid); border-radius:99px; }
    .lang-nav a:hover, .lang-nav a.active { background:var(--color-accent-light); color:var(--color-accent-dark); border-color:var(--color-accent); }
    .legal-content { display:none; }
    .legal-content.active { display:block; }
    .legal-content h1 { font-size:20px; font-weight:600; margin-bottom:1.25rem; }
    .legal-content h2 { font-size:14px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--color-text-muted); margin:1.25rem 0 0.5rem; }
    .legal-content p { font-size:14px; line-height:1.7; margin-bottom:0.75rem; }
    .placeholder { background:var(--color-accent-light); color:var(--color-accent-dark); border-radius:3px; padding:1px 6px; font-style:italic; }
  </style>
</head>
<body>
  <div class="page-wrap">
    <header class="top-bar">
      <a href="${logoHref}"><img src="quiqui-logo.png" alt="QuiQui" class="logo" /></a>
    </header>
    <main>
      <section class="card">
        <nav class="lang-nav">
          <a href="#de" id="btn-de" class="active" onclick="switchLang('de')">Deutsch</a>
          <a href="#en" id="btn-en" onclick="switchLang('en')">English</a>
        </nav>

        <div class="legal-content active" id="lang-de">
          <h1>Impressum</h1>

          <h2>Angaben gemäß § 5 TMG</h2>
          <p>
            ${field('IMPRESSUM_NAME', 'Titel, Vorname, Nachname')}<br />
            ${field('IMPRESSUM_INSTITUTION', 'Institution / Hochschule')}<br />
            ${field('IMPRESSUM_DEPARTMENT', 'Fakultät / Fachbereich')}<br />
            ${field('IMPRESSUM_STREET', 'Straße und Hausnummer')}<br />
            ${field('IMPRESSUM_CITY', 'PLZ Ort')}
          </p>

          <h2>Kontakt</h2>
          <p>E-Mail: ${field('IMPRESSUM_EMAIL', 'vorname.nachname@hochschule.de')}</p>

          <h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
          <p>
            ${field('IMPRESSUM_NAME', 'Titel, Vorname, Nachname')}<br />
            ${field('IMPRESSUM_STREET', 'Straße und Hausnummer')}<br />
            ${field('IMPRESSUM_CITY', 'PLZ Ort')}
          </p>

          <h2>Hinweis</h2>
          <p>
            Diese Website wird im Rahmen von Lehrveranstaltungen an der
            ${field('IMPRESSUM_INSTITUTION', 'Name der Hochschule')} betrieben.
            Sie dient ausschließlich Bildungszwecken.
          </p>
        </div>

        <div class="legal-content" id="lang-en">
          <h1>Legal Notice (Impressum)</h1>

          <h2>Information according to § 5 TMG</h2>
          <p>
            ${field('IMPRESSUM_NAME', 'Title, First name, Last name')}<br />
            ${field('IMPRESSUM_INSTITUTION', 'Institution / University')}<br />
            ${field('IMPRESSUM_DEPARTMENT', 'Faculty / Department')}<br />
            ${field('IMPRESSUM_STREET', 'Street and number')}<br />
            ${field('IMPRESSUM_CITY', 'Postcode City')}
          </p>

          <h2>Contact</h2>
          <p>Email: ${field('IMPRESSUM_EMAIL', 'firstname.lastname@university.de')}</p>

          <h2>Responsible for content according to § 18 para. 2 MStV</h2>
          <p>
            ${field('IMPRESSUM_NAME', 'Title, First name, Last name')}<br />
            ${field('IMPRESSUM_STREET', 'Street and number')}<br />
            ${field('IMPRESSUM_CITY', 'Postcode City')}
          </p>

          <h2>Note</h2>
          <p>
            This website is operated in the context of courses at
            ${field('IMPRESSUM_INSTITUTION', 'University name')} for educational purposes only.
          </p>
        </div>
      </section>

      <p style="font-size:12px;color:#9e9e99;margin-top:1rem">
        <a href="${backLink}" style="color:inherit">← Back</a>
      </p>
    </main>
    <footer class="site-footer">
      <a href="impressum${footerBack}">Impressum</a>
      <a href="privacy${footerBack}">Privacy Policy</a>
      ${VERSION_HTML}
    </footer>
  </div>
  <script>
    function switchLang(lang) {
      document.querySelectorAll('.legal-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.lang-nav a').forEach(el => el.classList.remove('active'));
      document.getElementById('lang-' + lang).classList.add('active');
      document.getElementById('btn-' + lang).classList.add('active');
    }
    if (window.location.hash === '#en') switchLang('en');
  </script>
</body>
</html>`;
  noCache(res).send(html);
});

app.get('/privacy', (req, res) => {
  sendHtml(res, privacyHtml);
});

// Pull/clone repo and return list of yaml files + config
app.post('/api/pull', requireHost, async (req, res) => {
  const { repo, ownerToken, force } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo is required' });

  // Only allow public HTTPS GitHub repos
  if (!/^https:\/\//i.test(repo)) {
    return res.status(400).json({ error: 'Only https:// repository URLs are supported.' });
  }

  // Check repo size via GitHub API before cloning
  const githubMatch = repo.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (githubMatch) {
    try {
      const apiRes = await fetch(`https://api.github.com/repos/${githubMatch[1]}`, {
        headers: { 'User-Agent': 'quiqui', Accept: 'application/vnd.github+json' },
      });
      if (apiRes.status === 404) {
        return res.status(400).json({ error: 'Repository not found. Check the URL and make sure it is public.' });
      }
      if (apiRes.ok) {
        const { size } = await apiRes.json(); // size is in KB
        if (size > REPO_SIZE_LIMIT_KB) {
          return res.status(400).json({ error: `Repository is too large (${size} KB). Maximum allowed size is ${REPO_SIZE_LIMIT_KB} KB.` });
        }
      }
    } catch (_) { /* network error — proceed and let clone fail naturally */ }
  } else {
    return res.status(400).json({ error: 'Only GitHub repositories are supported (https://github.com/owner/repo).' });
  }

  const questionsDir = path.join(SESSIONS_DIR, repoDirName(repo));

  try {
    await fs.promises.rm(questionsDir, { recursive: true, force: true });
    await fs.promises.mkdir(questionsDir, { recursive: true });

    const git = simpleGit();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Clone timed out after 15 seconds')), 15000)
    );
    await Promise.race([git.clone(repo, questionsDir, ['--depth', '1']), timeout]);

    // Read optional config.yaml
    let config = {};
    const configPath = path.join(questionsDir, 'config.yaml');
    try {
      config = yaml.load(await fs.promises.readFile(configPath, 'utf8')) || {};
    } catch (_) { /* config.yaml is optional */ }

    // Derive sessionId — stable slug from config or random fallback
    const sessionId = config.session_url || crypto.randomBytes(3).toString('hex');

    // session_url becomes a URL path segment, a socket room name, and the QR
    // target, so constrain it to the same charset /api/qr-public accepts —
    // otherwise the projector QR silently fails and join links break. Reject
    // early with a clear message rather than building a broken session. (The
    // random-hex fallback above always satisfies this pattern.)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId))) {
      return res.status(400).json({
        error: 'config.yaml "session_url" must be 1–64 characters, letters/digits/hyphen/underscore only (no spaces or slashes).',
      });
    }

    // session_url is the room identity — it doesn't matter whether this pull
    // comes from the same repo as whatever is already there or a completely
    // different one. The only thing that matters is whether a poll is
    // actually live right now: if the existing session is live (open or has
    // an active question) and this pull comes from a browser we don't
    // recognise (ownerToken mismatch), warn instead of silently clobbering
    // it — two lecturers reusing the same session_url (same repo OR
    // different ones) would otherwise stomp on each other's poll without any
    // signal. A host reloading their own tab carries the same ownerToken and
    // passes through. An idle session (or none at all) is always replaced
    // silently, regardless of source. `force: true` lets the host UI confirm
    // the takeover explicitly.
    const existing = sessions.get(sessionId);
    const isLive = existing && (existing.open || existing.activeQuestion);
    if (existing && isLive && existing.ownerToken && ownerToken !== existing.ownerToken && !force) {
      return res.status(409).json({
        error: `A session at "${sessionId}" already looks active, possibly started from another device. Confirm to take it over.`,
        code: 'SESSION_LIKELY_TAKEN',
      });
    }

    // Register or refresh the session entry (no active question yet)
    const { shortlink } = registerSession({ sessionId, repoUrl: repo, questionsDir, config, ownerToken, existing });

    // List .yaml / .yml files (excluding config.yaml). Sorted so the dropdown
    // order is stable and predictable (lecture1, lecture2, …) rather than
    // whatever order fs.readdir happens to return on this platform.
    const all = await fs.promises.readdir(questionsDir);
    const files = all.filter(f =>
      (f.endsWith('.yaml') || f.endsWith('.yml')) && f !== 'config.yaml' && f !== 'config.yml'
    ).sort((a, b) => a.localeCompare(b));

    res.json({ files, config, sessionId, shortlink });
  } catch (err) {
    log.error('Pull failed:', err.message);
    const msg = err.message.includes('timed out') ? err.message
      : err.message.includes('Repository not found') || err.message.includes('not found') ? 'Repository not found. Check the URL and make sure it is public.'
      : err.message.includes('Authentication failed') || err.message.includes('could not read Username') ? 'Repository is private or requires authentication. Only public repositories are supported.'
      : 'Clone failed: ' + err.message;
    res.status(500).json({ error: msg });
  }
});

// Load questions from a self-contained local file uploaded by the host.
// The client reads the file and POSTs its raw YAML text. We validate, split
// config/questions, write it into a synthetic session directory (so every
// downstream reader — /api/questions, /assets, expiry — is unchanged), and
// register the session with a synthetic 'local:<hash>' repo identity so the
// same-source vs different-source conflict logic works exactly as for repos.
app.post('/api/upload', requireHost, async (req, res) => {
  const { text, filename, ownerToken, force } = req.body;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'No file content received.' });
  }

  // Size guard — same limit as a repo question file. Byte length, not char length.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > FILE_SIZE_LIMIT_KB * 1024) {
    return res.status(400).json({ error: `File is too large (${Math.round(bytes / 1024)} KB). Maximum allowed size is ${FILE_SIZE_LIMIT_KB} KB.` });
  }

  // Parse + split. A local file MUST be the bundled shape (map with config +
  // questions); a bare list has no session_url so it can't start a session.
  let loaded;
  try {
    loaded = yaml.load(text);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse YAML: ' + err.message });
  }
  if (Array.isArray(loaded) || !loaded || typeof loaded !== 'object' || !('questions' in loaded)) {
    return res.status(400).json({
      error: 'This is not a self-contained QuiQui file. It must be a YAML map with a "config:" section (including session_url) and a "questions:" list. A bare list of questions can only be loaded from a GitHub repo (which supplies config.yaml).',
    });
  }
  const { config, questions } = normalizeQuestionFile(loaded);

  const label = typeof filename === 'string' && filename.trim() ? path.basename(filename) : 'uploaded file';
  const validationError = validateQuestions(questions, label);
  if (validationError) return res.status(400).json({ error: validationError });

  // Derive sessionId from the file's own config — same rules as config.yaml.
  const sessionId = config.session_url || crypto.randomBytes(3).toString('hex');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId))) {
    return res.status(400).json({
      error: 'config.session_url must be 1–64 characters, letters/digits/hyphen/underscore only (no spaces or slashes).',
    });
  }

  // The example file shipped in the companion questions repo uses this exact
  // session_url. Warn (don't hard-block) so a host who copied it as a
  // starting point notices before running a real session under the demo's
  // room name — but still let them proceed if they really mean to (e.g.
  // testing). Same confirm+force pattern as SESSION_LIKELY_TAKEN below.
  if (sessionId === 'example' && !force) {
    return res.status(409).json({
      error: '"example" is the session_url of the shipped demo file — change it in your file\'s config section before using this for a real session. Confirm to use it anyway.',
      code: 'EXAMPLE_SESSION_URL',
    });
  }

  // Synthetic repo identity — content hash. Only used to detect an identical
  // re-upload (a silent refresh); it is NOT used to gate the conflict check
  // below, because session_url — not source — is the room identity: a
  // different file claiming an in-use session_url is fine as long as no poll
  // is actually live there right now (see registerSession()/isLive below,
  // same rule as /api/pull).
  const repoUrl = 'local:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

  const existing = sessions.get(sessionId);
  const isLive = existing && (existing.open || existing.activeQuestion);
  if (existing && isLive && existing.ownerToken && ownerToken !== existing.ownerToken && !force) {
    return res.status(409).json({
      error: `A session at "${sessionId}" already looks active, possibly started from another device. Confirm to take it over.`,
      code: 'SESSION_LIKELY_TAKEN',
    });
  }

  // Write the questions into a synthetic session directory named after the hash,
  // so /api/questions can read it back exactly like a cloned repo file. We write
  // ONLY the questions list (not the config) — /api/questions ignores config
  // inside a "repo" anyway, and this keeps the on-disk file a plain classic file.
  const dirName = repoDirName(repoUrl);      // 'local:abc…' → 'local-abc…', safe
  const questionsDir = path.join(SESSIONS_DIR, dirName);
  const storedName = 'questions.yaml';
  try {
    await fs.promises.rm(questionsDir, { recursive: true, force: true });
    await fs.promises.mkdir(questionsDir, { recursive: true });
    await fs.promises.writeFile(path.join(questionsDir, storedName), yaml.dump(questions), 'utf8');
  } catch (err) {
    log.error('Upload write failed:', err.message);
    return res.status(500).json({ error: 'Could not store the uploaded file: ' + err.message });
  }

  const { shortlink } = registerSession({ sessionId, repoUrl, questionsDir, config, ownerToken, existing });

  // Same response shape as /api/pull so the host UI reuses the same setup path.
  // Exactly one file, already selected client-side.
  res.json({ files: [storedName], config, sessionId, shortlink, storedName, uploadedName: label });
});

// Load questions from a specific file
app.get('/api/questions', requireHost, async (req, res) => {
  const { file, sessionId } = req.query;
  if (!file) return res.status(400).json({ error: 'file is required' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found.' });

  // Prevent path traversal
  const safe = path.basename(file);
  const filePath = path.join(s.questionsDir, safe);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const { size } = await fs.promises.stat(filePath);
    if (size > FILE_SIZE_LIMIT_KB * 1024) {
      return res.status(400).json({ error: `File is too large (${Math.round(size / 1024)} KB). Maximum allowed size is ${FILE_SIZE_LIMIT_KB} KB.` });
    }
    const loaded = yaml.load(fs.readFileSync(filePath, 'utf8'));
    const { questions } = normalizeQuestionFile(loaded);   // config: section ignored inside a repo
    const validationError = validateQuestions(questions, safe);
    if (validationError) return res.status(400).json({ error: validationError });
    touchSession(sessionId);
    // Optional per-session answer shuffling (config.yaml `shuffle: true`).
    // A per-question `shuffle: false` opts an individual question out.
    const shuffled = questions.map(q =>
      (s.shuffle && q.shuffle !== false) ? shuffleAnswers(q) : q
    );
    res.json({ questions: shuffled });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse YAML: ' + err.message });
  }
});

// Generate QR code for a URL (host-only)
app.get('/api/qr', requireHost, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate QR code for a URL (public — used by projector view)
app.get('/api/qr-public', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  // Only allow generating QR codes for join URLs on this same host — otherwise
  // this becomes a no-auth QR generator for any attacker-chosen URL served from
  // our trusted domain (checking the path alone lets any host through). An
  // optional leading path prefix is allowed so this still works behind a
  // reverse proxy that mounts the app under a subpath (e.g. /quiqui/join/...).
  const joinPattern = /^(?:\/[a-zA-Z0-9_-]+)*\/join\/[a-zA-Z0-9_-]+$/;
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  // `req.headers.host`/`parsed.host` here is the HTTP Host header (protocol
  // concept — scheme+hostname+port), unrelated to the "host" role/HOST_SLUG
  // introduced elsewhere in this file. Kept as-is to avoid confusing this
  // well-known Express/HTTP idiom with an app-specific rename.
  if (parsed.host !== req.headers.host || !joinPattern.test(parsed.pathname)) {
    return res.status(403).json({ error: 'only join URLs on this host are allowed' });
  }
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    res.json({ dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current session info (for host page reload)
app.get('/api/session', requireHost, (req, res) => {
  const { sessionId } = req.query;
  const s = sessionId ? sessions.get(sessionId) : null;
  if (!s) return res.json({ session: null });
  res.json({
    session: {
      sessionId: s.sessionId,
      activeQuestion: s.activeQuestion,
      votes: s.votes,
      open: s.open,
      total: s.voters.size,
    }
  });
});

// ─── Session expiry ───────────────────────────────────────────────────────────

function expireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.open = false;
  // Scope both emits to this session's room only. A global io.emit here would
  // reach every other concurrent session too — their clients can't tell it
  // apart from their own expiry and would wrongly reset. The host joins its
  // room at pull time (see host.js pullRepo), so a room emit reaches it even
  // before the first activation; the sessionId lets clients confirm it's theirs.
  io.to(`session:${sessionId}`).emit('question-closed');
  io.to(`session:${sessionId}`).emit('session-expired', { sessionId });
  // Clean up cloned files
  fs.promises.rm(s.questionsDir, { recursive: true, force: true }).catch(() => {});
  sessions.delete(sessionId);
  log.info(`Session expired  session=${sessionId}`);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // Participant joins a session room
  socket.on('join-session', ({ sessionId }) => {
    socket.join(`session:${sessionId}`);

    const s = sessions.get(sessionId);
    if (s && s.activeQuestion) {
      const { correct, explanation, ...participantQuestion } = s.activeQuestion;
      const correctIndices = s.answersRevealed ? toCorrectIndices(s.activeQuestion.correct) : [];
      socket.emit('session-state', {
        exists: true,
        question: participantQuestion,
        votes: s.votes,
        open: s.open,
        total: s.voters.size,
        title: s.title || null,
        shortlink: s.shortlink || null,
        answersRevealed: s.answersRevealed,
        deactivated: !s.open && !s.answersRevealed,
        correctIndices,
        sessionToken: s.sessionToken,
      });
    } else {
      socket.emit('session-state', { exists: !!s, question: null, votes: null, open: false, total: 0, title: s ? s.title || null : null, shortlink: s ? s.shortlink || null : null, answersRevealed: false, deactivated: false, correctIndices: [], sessionToken: s ? s.sessionToken : null });
    }
  });

  // Host activates a question — token checked here because socket events have no HTTP headers
  socket.on('activate-question', ({ question, sessionId, token, title }) => {
    if (token !== HOST_SLUG) return;

    const s = sessions.get(sessionId);
    if (!s) return;

    socket.join(`session:${sessionId}`);
    s.title = title || null;
    s.open = true;
    s.answersRevealed = false;
    touchSession(sessionId);

    const sameQuestion = s.activeQuestion && s.activeQuestion.question === question.question;
    if (!sameQuestion) {
      s.votes = {};
      s.voters = new Set();
      question.answers.forEach((_, i) => { s.votes[i] = 0; });
    }
    s.activeQuestion = question;

    // Strip host-only fields before broadcasting to participants
    const { correct, explanation, ...participantQuestion } = question;
    io.to(`session:${sessionId}`).emit('question-activated', { question: participantQuestion, sessionId, title: s.title, votes: s.votes, total: s.voters.size, sessionToken: s.sessionToken });
  });

  // Host deactivates — voting closes, participants see bars without highlights
  socket.on('deactivate-question', ({ sessionId, token }) => {
    if (token !== HOST_SLUG) return;
    const s = sessions.get(sessionId);
    if (!s || !s.activeQuestion) return;
    s.open = false;
    s.answersRevealed = false;
    touchSession(sessionId);
    io.to(`session:${sessionId}`).emit('question-deactivated', { votes: s.votes, total: s.voters.size });
  });

  // Host reveals correct answers — broadcasts highlighted indices
  socket.on('show-answer', ({ sessionId, token }) => {
    if (token !== HOST_SLUG) return;
    const s = sessions.get(sessionId);
    if (!s || !s.activeQuestion) return;
    s.open = false;
    s.answersRevealed = true;
    touchSession(sessionId);
    const correctIndices = toCorrectIndices(s.activeQuestion.correct);
    io.to(`session:${sessionId}`).emit('answer-revealed', { correctIndices, votes: s.votes, total: s.voters.size });
  });

  // Host closes — participants sent to waiting screen, question cleared
  socket.on('close-question', ({ sessionId, token }) => {
    if (token !== HOST_SLUG) return;
    const s = sessions.get(sessionId);
    if (!s) return;
    s.open = false;
    s.answersRevealed = false;
    s.activeQuestion = null;
    touchSession(sessionId);
    io.to(`session:${sessionId}`).emit('question-closed');
  });

  // Participant submits answer(s)
  socket.on('submit-answer', ({ sessionId, selected, voterId }) => {
    const s = sessions.get(sessionId);
    if (!s || !s.open || !s.activeQuestion) return;
    // Deduplicate on the stable per-browser voterId so the guard survives a
    // reconnect (which yields a new socket.id). Fall back to socket.id for any
    // client that doesn't send a voterId.
    const voterKey = (typeof voterId === 'string' && voterId) ? `v:${voterId}` : socket.id;
    if (s.voters.has(voterKey)) return;
    // Voting is anonymous and voterId is client-supplied, so a scripted client
    // can mint unlimited fake voters — each one grows this set and fires a
    // room-wide vote-update broadcast. Cap it far above any real session size
    // to bound memory and broadcast load; legitimate sessions never reach it.
    if (s.voters.size >= 10000) return;

    // Validate selections: must be a non-empty array of valid integer indices
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > s.activeQuestion.answers.length) return;
    if (selected.some(i => !Number.isInteger(i) || i < 0 || i >= s.activeQuestion.answers.length)) return;

    // Dedupe and enforce single-choice — a single submission must not stack a
    // bar with duplicate indices, or pick several options on a single-answer
    // question. The UI already prevents both; this blocks a scripted client.
    const unique = [...new Set(selected)];
    if (s.activeQuestion.type === 'single' && unique.length > 1) return;

    s.voters.add(voterKey);
    unique.forEach(idx => {
      if (s.votes[idx] !== undefined) s.votes[idx]++;
    });

    const total = s.voters.size;
    io.to(`session:${sessionId}`).emit('vote-update', { votes: s.votes, total });
  });

});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log.info(`QuiQui v${APP_VERSION}`);
  log.info(`running on http://localhost:${PORT}${BASE_PATH}`);
  log.info(`Host page: http://localhost:${PORT}${BASE_PATH}/${HOST_SLUG}`);
});
