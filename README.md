<img src="public/quiqui-logo.png" alt="QuiQui" width="240" />

# Live quiz & audience response tool for lectures, meetings, and talks — fully open-source, AI-ready, YAML questions in Git, no accounts, no database

**QuiQui — short for *quick quiz* — is a free, self-hostable quiz tool where your questions are plain YAML text you bring yourself: a single file from your computer, or a GitHub repo of many. Write them yourself or hand a topic to ChatGPT or Claude. No accounts, no database, no cap on how many people can join.**

**→ [Quickstart for lecturers](QUICKSTART.md)** — your own quiz running in 5 minutes  
**→ [Try the hosted instance](https://kiz1.in.ohmportal.de/quiqui)** — no setup required  
**→ [FAQ](FAQ.md)** — common questions answered

---

## Why QuiQui?

Commercial quiz and poll tools want an account, a subscription, your participants' data, and a lot of tedious clicking to create your questions. 
QuiQui makes **live in-class polling as simple as possible.**

Everything that defines a session — questions, join URL, title, correct answers, explanations — is *injected* from content you own. The tool itself stores nothing: no database, no accounts, no persistent state. You bring the questions; QuiQui just runs the room.

What makes it different:

- **Your questions are plain text you own.** Write them as simple YAML — a single self-contained file on your computer, or a public GitHub repo of many files you can version, diff, and reuse across courses. Edit them in any editor; no clunky web form, no vendor lock-in.
- **Two ways in, no account needed.** Load a file straight from your computer via **From file**, or point QuiQui at a GitHub repo. A repo additionally gives you a bookmarkable host URL that re-pulls your latest questions in one click.
- **Write questions with AI, not a form.** Because questions are just text, drafting isn't locked behind a paywalled "AI Quiz Generator". Paste our [ready-made prompt](https://github.com/th-nuernberg/quiqui-questions#generate-questions-with-an-ai-assistant) into ChatGPT, Claude, or any assistant, describe your topic, and drop the YAML it returns straight in — a whole lecture's questions in minutes.
- **Built for real teaching content.** Markdown, LaTeX math, code blocks, and images in questions *and* answers — single- or multiple-choice per question.
- **Zero friction for participants.** They scan a QR code (or type a short URL) and they're in — no login, no app, no email, any phone with a browser. No cap on how many can join.
- **Live results, host-paced.** You decide which question is live; participants can't skip ahead. The bar chart fills in real time, then you **reveal the correct answer** with one click and it turns green on every screen. A live stopwatch shows how long voting's been open.
- **A view for every screen.** A dedicated **projector view** puts the QR code and live results on the beamer while you drive from the host view.
- **Yours to run, free and private.** No tracking, no leaderboards. Session state lives in memory and vanishes when the quiz ends. Vanilla HTML/CSS/JS, no build step — deploy anywhere Node.js runs.

---

## Hosted service

There is always an instance running at [kiz1.in.ohmportal.de/quiqui](https://kiz1.in.ohmportal.de/quiqui) — no setup required, and free to use. To get access as a lecturer, just ask for the host URL — [reach out to us](https://kiz1.in.ohmportal.de/quiqui/impressum#en) at the address on our Impressum.

For self-hosting see [Installation](#installation) below.

---

## Question format

Questions are plain YAML, one `.yaml` file per session topic. See [th-nuernberg/quiqui-questions](https://github.com/th-nuernberg/quiqui-questions) for the full format reference and working examples. Load them either from a **public GitHub repo** or as a **self-contained file straight from your computer** (**From file** on the host page, no account needed — start from [`self-contained-example.yaml`](https://github.com/th-nuernberg/quiqui-questions/blob/main/self-contained-example.yaml)).

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

**Multiple hosts, one instance.** A single deployment safely supports many concurrent sessions — each is isolated by its `session_url`, so hosts never see or affect one another's questions, votes, or results. The one thing to know is that the host slug is a *single shared secret*: anyone who knows it can control any session on the instance. If your hosts should not be able to act on each other's sessions, give each their own deployment with its own `HOST_SLUG`.

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
