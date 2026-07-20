<img src="public/quiqui-logo.png" alt="QuiQui" width="240" />

# Live quiz & audience response tool for lectures, meetings, and talks — fully open-source, AI-ready, YAML questions in Git, no accounts, no database

**QuiQui — short for *quick quiz* — is a free, self-hostable quiz tool where questions are plain YAML text in a Git repo. Write them yourself or hand a topic to ChatGPT or Claude. No cap on how many people can join.**

No host or participant sign-up. No app to install. No login. No admin panel to click through — **your questions are just YAML files in a GitHub repo**, so ChatGPT, Claude, or any AI assistant can draft a whole question file for you in one prompt — no vendor AI add-on required. Full Markdown, LaTeX math, code blocks, and images are supported out of the box.
See [th-nuernberg/quiqui-questions](https://github.com/th-nuernberg/quiqui-questions) for example.

You open a question for voting, participants scan a QR code and answer on their phones, and the whole room watches the results fill in on a live bar chart. Reveal the correct answer whenever you like — it lights up green for everyone at once.

**→ [Try the hosted instance](https://kiz1.in.ohmportal.de/quiqui)** — no setup required  
**→ [Quickstart for lecturers](QUICKSTART.md)** — your own quiz running in 5 minutes  
**→ [FAQ](FAQ.md)** — common questions answered

---

## Why QuiQui?

Commercial quiz and poll tools want an account, a subscription, your participants' data, and a lot of tedious clicking to create your questions. 
QuiQui makes **live in-class polling as simple as possible.**

**Everything is injected from your Git repo — the tool stores nothing.**
Your questions *and* everything that defines a session — the join URL, the title, the correct answers, the explanations — are loaded from your GitHub repo. QuiQui itself keeps no database, no local files, no accounts: the repo is the single source of truth, and pointing QuiQui at it is all it takes for a session to appear. Nothing about your content or your identity lives inside the tool.

**Your questions are plain text in Git.**
Write questions as simple YAML in a public GitHub repo. Version them, diff them, copy them between courses, edit them in your favourite editor. No clunky web form, no vendor lock-in — pull the latest into a session anytime.

**Write questions with AI, not a form.**
Because questions are just text, drafting them isn't locked behind a paywalled "AI Quiz Generator" button. Paste our [ready-made prompt](https://github.com/th-nuernberg/quiqui-questions#generate-questions-with-an-ai-assistant) into any assistant you already use — ChatGPT, Claude, whatever — describe your topic, and paste the YAML it hands back straight into your repo. A whole lecture's worth of questions, generated and version-controlled in minutes.

**Built for real teaching content.**
Markdown, LaTeX math, code blocks, and images in questions *and* answers — the things a real lecture is made of, not just plain text. Single- and multiple-choice per question.

**Zero friction for participants.**
They scan a QR code (or type a short URL) and they're in. No login, no app, no email. Works on any phone with a browser.

**Live results, host-paced.**
You decide which question is live — participants can't skip ahead. The bar chart updates in real time as votes land, then you **reveal the correct answer** with one click and it turns green on every screen in the room.

**A view for every screen.**
A dedicated **projector view** shows the QR code and live results on the beamer, while you drive everything from the host view — complete with a live stopwatch so you know how long voting's been open.

**Yours to run, free and private.**
No database, no tracking, no scoring leaderboards. Session state lives in memory and vanishes when the quiz ends. 

---

## Hosted service

There is always an instance running at [kiz1.in.ohmportal.de/quiqui](https://kiz1.in.ohmportal.de/quiqui) — no setup required, and free to use. To get access as a lecturer, just ask for the host URL — [reach out to us](https://kiz1.in.ohmportal.de/quiqui/impressum#en) at the address on our Impressum.

For self-hosting see [Installation](#installation) below.

---

## Full feature list

- **Everything injected from the repo** — questions *and* all session-defining data (join URL, title, correct answers, explanations) come from your GitHub repo on every pull; the tool holds no persistent state of its own — no database, no local files, no accounts. The repo is the single source of truth
- **Host-paced** — the host controls which question is active; participants cannot browse ahead
- **No participant login** — participants join by scanning a QR code or visiting a URL
- **Live results** — bar chart updates in real time as participants submit
- **Four-state flow** — Open → Pause (bars, no highlights) → Reveal (correct answers highlighted) → Close (participants return to waiting screen)
- **Reveal answer** — host reveals correct answers; correct options are highlighted in green for everyone in the room
- **Projector view** — read-only beamer view showing the QR code and live results, separate from the host controls
- **Run timer** — while a question is active, the host view shows a live stopwatch counting up, so the host can see how long voting has been open
- **Single and multiple choice** — per-question type configured in YAML
- **Markdown and LaTeX** — question text and answers support code blocks, inline code, and math expressions
- **Questions in Git** — question files are plain YAML in a public GitHub repo; versionable, diffable, reusable, no admin interface needed
- **AI-assisted question writing** — a [ready-made prompt](https://github.com/th-nuernberg/quiqui-questions#generate-questions-with-an-ai-assistant) lets any LLM (ChatGPT, Claude, …) draft a whole question file in the correct YAML format; no built-in AI add-on to pay for or get locked into
- **Optional shortlink** — a host-provided `host_shortlink` in `config.yaml` is shown in the host view and used in place of the long join URL on the projector, so participants can type a memorable address
- **Multiple concurrent sessions** — each repo's `session_url` defines an independent session; the URL must be unique per host (e.g. `tum-python101`), as two sessions with the same `session_url` from different repos cannot coexist
- **No database** — the only state is the live session, held in memory and intentionally ephemeral; it vanishes on restart or when the session ends
- **No build step** — vanilla HTML/CSS/JS frontend, deploy anywhere Node.js runs

---

## Question format

Questions live in a **public GitHub repository**, one `.yaml` file per session topic. See [th-nuernberg/quiqui-questions](https://github.com/th-nuernberg/quiqui-questions) for the full format reference and working examples.

> **Limits:** QuiQui checks the repository size via the GitHub API before cloning and rejects repos larger than **1 MB**. Individual question files larger than **100 KB** are rejected when loaded. Each question may have at most **6 answer options**. YAML files are validated on load — format errors are shown as a clear error message in the host view.

---

## Installation

> **Lecturer?** See the [Quickstart guide](QUICKSTART.md) for a step-by-step walkthrough with screenshots.

### Prerequisites

- Node.js 18 or later
- A public GitHub repository containing your question YAML files (see [th-nuernberg/quiqui-questions](https://github.com/th-nuernberg/quiqui-questions))

```bash
git clone https://github.com/th-nuernberg/quiqui.git
cd quiqui
npm install
```

### Configuration

Copy `.env.example` to `.env` and set your values:

```bash
cp .env.example .env
```

```env
HOST_SLUG=host-xk92p   # The secret path segment for the host page
PORT=3000
```

`HOST_SLUG` is the only thing protecting your host page — choose something hard to guess before deploying. If not set, it defaults to `host` (fine for local development).

### Run locally

```bash
npm start
```

Or with auto-restart on file changes:

```bash
npm run dev
```

Both commands set the required git environment variables (`GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`, `GIT_PAGER`) automatically — `npm start` via `start.sh`, `npm run dev` inline. Don't launch the server without them (e.g. plain `node server.js`) — git cloning will hang or fail.

Then open:
- Host page: `http://localhost:3000/host` (or your configured slug)
- Participant page: `http://localhost:3000/join/<session_url>` (shown as QR code after pulling a repo)

### Run with Docker

A prebuilt image is published at [`ghcr.io/th-nuernberg/quiqui`](https://github.com/th-nuernberg/quiqui/pkgs/container/quiqui) — no clone or `npm install` needed.

```bash
docker pull ghcr.io/th-nuernberg/quiqui:latest
docker run -p 3000:3000 --env-file .env ghcr.io/th-nuernberg/quiqui:latest
```

`--env-file .env` loads your configuration from a local `.env` file (copy `.env.example` first, as above). Alternatively, pass individual variables with `-e`:

```bash
docker run -p 3000:3000 -e HOST_SLUG=host-xk92p ghcr.io/th-nuernberg/quiqui:latest
```

The container includes git, required at runtime to clone question repositories — no extra setup needed. Sessions are in-memory only, so they're lost on container restart, same as running the server directly.

**Behind a reverse proxy on a subpath (e.g. `https://your-domain/quiqui`):** there are two ways to do this — pick whichever fits your proxy.

*Option A — the proxy strips the prefix (simplest).* Forward the subpath to the container with the prefix removed, so the container still receives root-relative requests. Leave `BASE_PATH` unset. Note the trailing `/` on both lines — that's what triggers the rewrite:

```nginx
location /quiqui/ {
    proxy_pass http://container:3000/;   # trailing slash strips /quiqui
    proxy_set_header Host $host;
}
```

*Option B — the proxy passes the prefix through unchanged.* Some setups keep the full path (`/quiqui/...` reaches the container as-is) — for example when the proxy's access/filter rules are written against the public path and a rewrite would bypass them. In that case set `BASE_PATH` to the subpath so the app mounts all routes, assets, and the socket.io endpoint under it:

```nginx
location /quiqui/ {
    proxy_pass http://container:3000;    # no trailing slash — path passed through
    proxy_set_header Host $host;
}
```

```bash
BASE_PATH=/quiqui   # in .env — no trailing slash
```

In both cases the proxy must pass through the original `Host` header (and the usual `Upgrade`/`Connection` headers for the Socket.io WebSocket). `BASE_PATH` defaults to empty, so a root deployment needs no configuration.

### Releases

Releases are cut from version tags. Pushing a `v*` tag triggers the CI pipeline (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)), which — only after the test suite passes:

1. builds and publishes the Docker image to [`ghcr.io/th-nuernberg/quiqui`](https://github.com/th-nuernberg/quiqui/pkgs/container/quiqui), tagged `:latest` and `:<version>`, and
2. creates the matching [GitHub Release](https://github.com/th-nuernberg/quiqui/releases) with auto-generated notes.

So a release is a single, explicit, tested action:

```bash
npm version patch        # bumps package.json + package-lock, creates the vX.Y.Z tag
git push --follow-tags   # pushes the commit and the tag → CI does the rest
```

Pushes to `main` and pull requests run the tests but do not publish or release.

---

## Tests

```bash
npm test
```

An end-to-end suite in [`test/security.test.js`](test/security.test.js) boots the real server on a throwaway port and drives it over HTTP and Socket.io to verify the security-relevant behaviour: server-side vote validation (dedupe + single-choice enforcement), the voter-count cap, room-scoped session expiry (so concurrent sessions can't disturb each other), the `/api/qr-public` host restriction, and `session_url` validation. It also runs `npm audit` in CI. Some checks clone the public companion question repo; if GitHub is unreachable those are skipped rather than failed, so the suite still runs offline. The suite runs automatically on every push to `main` and on pull requests (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## Security model

QuiQui uses a shared-secret approach suited for single-instance deployments:

- **Host page** is only reachable at `/:hostSlug` — the HTML file is not accessible as a static asset
- **Host API endpoints** (`/api/pull`, `/api/questions`, `/api/qr`, `/api/session`) require an `X-Host-Token` header matching the slug
- **Host socket events** (`activate-question`, `deactivate-question`, `show-answer`, `close-question`) require a `token` field matching the slug
- **Participant endpoints** (`/join/:sessionId`, socket events) are intentionally open — no login required
- **Only public GitHub repos** are accepted — `file://` and `ssh://` URLs are rejected; repo size is checked via the GitHub API before cloning
- **Untrusted question content is sanitised** — question and answer text comes from a public GitHub repo (which the host may not control), so it is treated as untrusted. The client renders Markdown/LaTeX with `marked` + KaTeX and then runs the result through [DOMPurify](https://github.com/cure53/DOMPurify) before inserting it into the page, preventing stored XSS from a malicious repo. DOMPurify's default profile permits HTML, SVG, and MathML, so KaTeX's rendered math is preserved. This applies to the host, participant, and projector views alike.

**Multiple hosts, one instance.** A single deployment safely supports many concurrent sessions — each is isolated by its `session_url` (see [Features](#full-feature-list)), so hosts never see or affect one another's questions, votes, or results. The one thing to know is that the host slug is a *single shared secret*: anyone who knows it can control any session on the instance. If your hosts should not be able to act on each other's sessions, give each their own deployment with its own `HOST_SLUG`.

The slug is a shared secret, not real authentication — keep your instance behind HTTPS so it can't be read off the wire.

These properties — vote-tally integrity, session isolation, and the input restrictions above — are covered by the [test suite](#tests), which runs on every push and pull request.

---

## Project structure

```
quiqui/
├── server.js               # Express + Socket.io server, all backend logic
├── host.html               # Host view — served only via the slug route, not as a static file
├── start.sh                # Sets required git env vars and launches server.js
├── package.json
├── .env.example            # Documents required environment variables
└── public/                 # Served statically (no auth required)
    ├── index.html          # Landing page
    ├── participant.html    # Participant view
    ├── projector.html      # Projector/beamer view — read-only, shows QR + live results
    ├── privacy.html        # Privacy policy (DE/EN)
    ├── style.css           # Shared styles
    ├── projector.css       # Projector-view styles
    ├── host.js             # Host frontend logic
    ├── participant.js      # Participant frontend logic
    ├── projector.js        # Projector-view frontend logic
    └── quiqui-logo.png     # Logo
```

**Why `start.sh`?** Node.js inherits the shell environment, which can include variables like `PAGER` or credential helpers that cause git to hang or throw security errors when cloning. `start.sh` sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, and `GIT_PAGER=cat` to give git a clean, non-interactive environment. `npm start` and `npm run dev` call it automatically.

**Why is `host.html` outside `public/`?**  
Everything in `public/` is served statically and is publicly accessible by filename. Moving `host.html` to the project root means it can only be reached through the slug route — visiting `/host.html` directly returns 404.

---

## Contributing

Bug fix pull requests are welcome. For improvement ideas and feature requests, please open an issue — this project is intentionally kept as simple as possible, so new features are discussed before implementation.

1. Fork the repo
2. Create a feature branch (`git checkout -b fix/my-fix`)
3. Commit your changes
4. Run `npm test` and make sure it passes
5. Open a pull request — CI runs the same tests on your PR

By submitting a contribution, you agree it is licensed under the project's [AGPL-3.0-or-later](LICENSE) terms.

---

## License

[AGPL-3.0](LICENSE)

**What this means for you, plainly:**

- ✅ **Running QuiQui for your lectures, meetings, or talks is completely free, with no obligations** — whether you use it as-is or tweak it for yourself. Just using it never requires you to share anything or ask permission.
- ✅ Self-host it for your university, department, or course as much as you like.
- 🔁 The only requirement: **if you publicly host a *modified* version**, you must make your changes available under the same license. In other words — improvements to QuiQui stay open for everyone, and nobody can take it closed-source. That's the whole point of the AGPL.

If you just want to use QuiQui in class, you owe nothing and need do nothing. The copyleft only ever applies to people who change the code *and* offer it to others.
