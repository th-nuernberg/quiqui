# QuiQui — Claude context

## What this project is

Live audience response tool for university lectures. Lecturer activates a question, students answer via QR/URL, class sees a live bar chart. No correct answer revealed — the point is discussion.

Deliberately minimal: one session at a time, no database, no login, no build step.

## Stack

- **Backend:** Node.js, Express, Socket.io, js-yaml, simple-git, qrcode
- **Frontend:** Vanilla HTML/CSS/JS — no framework, no bundler
- `npm start` / `npm run dev` to run — both go via `start.sh`, do NOT use `node server.js` directly

## Project structure

```
quiqui/
├── server.js          # All backend logic — Express routes, Socket.io, session state
├── teacher.html       # Teacher page — NOT in public/ (see below)
├── start.sh           # Sets GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=true, GIT_PAGER=cat before launching
├── package.json
├── .env.example
└── public/            # Served statically, no auth
    ├── student.html
    ├── style.css
    ├── teacher.js
    └── student.js
```

## Key architectural decisions

**`teacher.html` is in the project root, not `public/`.** `express.static` serves everything in `public/` by filename — putting `teacher.html` there would expose it at `/teacher.html` regardless of the slug. The slug route serves it explicitly via `sendFile`.

**Security model — slug as shared secret:**
- Teacher HTML only reachable at `/:TEACHER_SLUG`
- Teacher API routes (`/api/pull`, `/api/questions`, `/api/qr`, `/api/session`) require `X-Teacher-Token: <slug>` header
- Teacher socket events (`activate-question`, `close-voting`) require a `token` field matching the slug
- The teacher page reads its own slug from `window.location.pathname` and sends it automatically — no extra config for the teacher

**Session ID:** comes from `session_url` in the question repo's `config.yaml`. If absent, a random 6-char ID is generated at activation time. A stable ID lets students stay on the same `/join/<id>` URL across questions. QR code and join URL are shown in the top card as soon as the repo is pulled (not after activation).

**Always re-clone on pull** — never `git pull`. Simpler, always clean.

**`correct` field is teacher-only** — stripped server-side (destructured out) before any Socket.io broadcast to students.

## In-memory session state shape

```js
session = {
  sessionId: string,
  activeQuestion: { question, type, answers, correct?, explanation? },
  title: string | null,         // from config.yaml, sent to students on activation
  votes: { 0: n, 1: n, ... },  // answer index → count
  voters: Set,                  // socket IDs, prevents double voting
  open: bool,
}
```

One session at a time. All state lost on server restart — intentional.

## Question repo

Companion repo: https://github.com/albrechtje/quiqui-questions

YAML format:
```yaml
- question: "..."
  type: single | multiple
  answers: ["...", "..."]
  correct: "B — explanation text"   # optional, teacher-only
```

`config.yaml` in repo root:
```yaml
session_url: python101
title: Python 101
```
- `session_url` — stable join URL segment
- `title` — shown in header/tab as `QuiQui: <title>` on both teacher and student pages

## Teacher UI behaviour

- Selecting a question from the list shows a preview with empty bars immediately and scrolls to the panel
- **Activate** starts the question; **Close voting** ends it; **Next question →** advances to the next (always visible if not last)
- QR code and join URL live in the top "Select a question file" card — shown as soon as repo is pulled, stable for the whole session
- When voting closes, students are sent back to the waiting screen (not frozen on results)
- `session_url` from `config.yaml` is the join URL slug — students can bookmark `/join/<session_url>`

## v1 scope limits (don't add these without discussion)

- No multiple concurrent sessions
- No authentication / user accounts
- No persistent results
- No correct answer reveal to students
