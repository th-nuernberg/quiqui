<img src="public/quiqui-logo.png" alt="QuiQui" width="240" />

# Quickstart for Lecturers

> Part of the [QuiQui](https://github.com/th-nuernberg/quiqui) open source project. Hosted instance: [kiz1.in.ohmportal.de/quiqui](https://kiz1.in.ohmportal.de/quiqui).
>
> Got a quick question? See the **[FAQ](FAQ.md)**.

QuiQui lets you pose a question to your class and see live answers on screen — no app, no login, no setup for participants.

QuiQui stores nothing itself — you bring the questions. The fastest way to start is a **single file** you edit on your own computer; when your question deck grows, you can move it to a **GitHub repo** for a bookmarkable, reusable setup. Both paths are below — start with the file.

---

## What you need

- Your QuiQui **host URL** (bookmarked once, reused every lecture) — get it from your [hosted-instance operator](https://kiz1.in.ohmportal.de/quiqui/impressum#en), or run [your own server](https://github.com/th-nuernberg/quiqui#installation)
- A **question file** — start from the ready-made example (below); no account, no repo needed

---

## Quick start (from a file)

The lowest-effort way to run your first session — no GitHub account, no repo, nothing to install.

1. **Get your host URL** — from your hosted-instance operator, or your own server (see [What you need](#what-you-need) above). You only do this once.
2. **Download the example file:** right-click **[self-contained-example.yaml](https://raw.githubusercontent.com/th-nuernberg/quiqui-questions/main/self-contained-example.yaml)** → *Save link as…* (or [view it on GitHub](https://github.com/th-nuernberg/quiqui-questions/blob/main/self-contained-example.yaml) first). Open it in any text editor and change `session_url` from `example` to something unmistakably yours — it must be unique on the server, and QuiQui warns upon load if it still says `example`. The file's own comments explain how to pick a good one.
3. **Add your questions** — replace the example `questions:` with your own (same file, `questions:` section). See [Designing your questions](#designing-your-questions) for the format.
4. **Open your host URL and click "From file"** — pick your edited file. Your session starts straight from your computer; the QR code and join URL appear immediately.

To change questions, edit the file and load it again with **Replace file**.

> **Tip:** a file can't be bookmarked (your browser can't re-supply it), so you re-pick it each session. When you're running the same deck regularly, that's the moment to move to a GitHub repo — see below.

---

## When your deck grows: use a GitHub repo

> **See it in action first.** On the host page, the repo URL is pre-filled with the example repo — just click **From GitHub** to load it. That deck is a guided tour of QuiQui *built in QuiQui*: its `lesson*.yaml` files demonstrate every feature (loading questions, formatting, images, self-hosting, …) by asking about it. Run through it once to get an overview before setting up your own.

Once you run the same questions regularly, a **public GitHub repo** is worth the one-time setup. The payoff:

- **Your host URL becomes bookmarkable.** Load a repo once and QuiQui puts the repo address in your browser's address bar (`…/<host-slug>?repo=https://github.com/you/quiqui-questions`). Bookmark that, and every future lecture is one click — the page opens *and* pulls your latest questions automatically. (A file can't do this — the browser can't re-supply a local file.)
- **Edit anywhere, no re-upload.** Change a question on GitHub, click **Pull latest** in the host view — done. Nothing to download or re-pick.
- **Reusable and shareable** — colleagues can point their own host URL at the same repo.

You don't need to know Git or write any code — GitHub's website does everything below with clicks.

1. **Create a free GitHub account** at [github.com/join](https://github.com/join) if you don't have one — just an email address, no payment details
2. **[Create your own copy →](https://github.com/new?template_owner=th-nuernberg&template_name=quiqui-questions&name=quiqui-questions&description=My+QuiQui+questions&visibility=public)** — this pre-fills GitHub's "create repository" page from the example repo as a template; confirm and click **Create repository**. Keep it **Public** (pre-set in the link; QuiQui only reads public repos).
3. **Edit `config.yaml`** on GitHub: open it, click the pencil ✎, set `session_url` to something unmistakably yours (the file's comments explain how — it must be unique on the server), then **Commit changes**.
4. **Edit or add `.yaml` question files** the same way — click ✎ on a file, change the questions, **Commit changes**. Use **Add file → Create new file** for a new topic.
5. **Load it:** paste your repo URL (`https://github.com/you/quiqui-questions`) into the host page and click **From GitHub**. Then bookmark the resulting host URL as described above.

From here on, everything (new questions, fixes) is the same loop: edit on GitHub, commit, click **Pull latest**.

---

## Designing your questions

Questions are written in YAML — whether in a single file or a repo, the format is identical. The **[question repo README](https://github.com/th-nuernberg/quiqui-questions)** is the full reference: field format, Markdown + LaTeX support, copy-paste examples, ready-made templates, and even a prompt for generating a question file with ChatGPT or Claude. Start there.

Two things to decide before you write questions:

- **Scored or generic?** Include a `correct` field and the **✓ Reveal** button highlights the right option(s) in green for the room. Omit it to keep the question text in your slides and just collect votes — Reveal is hidden, and answers show as letter badges (A, B, C, …). The ready-made [`lesson5-generic-templates.yaml`](https://github.com/th-nuernberg/quiqui-questions/blob/main/lesson5-generic-templates.yaml) has A/B/C/D, Yes/No, True/False, and agreement-scale templates for this mode. (There is no separate "true/false" question type — a true/false or yes/no question is just a single-choice question with two answers.)
- **Where to start?** [`self-contained-example.yaml`](https://github.com/th-nuernberg/quiqui-questions/blob/main/self-contained-example.yaml) shows scored single- and multiple-choice questions, plus Markdown, LaTeX maths, and a code block — a good starting point whether you go the file or the repo route.

To change questions later: with a file, edit and load it again (**Replace file**); with a repo, edit on GitHub and click **Pull latest** — no server restart needed either way.

---

## During the lecture

<img src="public/host-view.png" alt="Host View" width="600" />

1. **Open your host URL** and load your questions — **From file** (pick your file) or **From GitHub** (a bookmarked repo URL pulls automatically). The QR code appears as soon as they load.
2. **Project the QR code** so participants can join (or share the URL verbally)
3. **Pick a question** — from a repo, choose the file from the dropdown first; then click a question to preview it
4. **Click ▶ Open** — voting opens; badge shows **● Active**. Click again (**⏸ Pause**) to stop voting without revealing answers — participants see the result bars but no highlights
5. **Click ✓ Reveal** to show the correct answers highlighted in green for everyone in the room
6. **Click ✕ Close** to send participants back to the waiting screen without revealing answers
7. **Click Next question →** to move on — participants return to the waiting screen automatically

> **Happy path:** Open → (participants vote) → Reveal → Close → Next question →

> **Tip:** Open the host page a minute before class and load your questions, so the QR code is ready before participants arrive.

> **Session lifetime:** A session expires after **90 minutes of inactivity**. After expiry, just load your questions again (From file or From GitHub) to start a fresh session — the participant URL stays the same.

> **"Session may be in use elsewhere" warning:** If you load questions at a `session_url` that already has a **live** poll running from a different browser, QuiQui warns you before taking it over — the safety net for two people accidentally using the same `session_url` (e.g. both trying the shared demo). It doesn't matter whether the other session came from a file or a repo; what matters is that a poll is live. If it's your own poll from another tab or device, confirm to continue; if you don't recognise it, cancel and check your `session_url` is unique to you.

---

## What participants see

<img src="public/participant-view.png" alt="Participant View" width="400" />

Participants visit the join URL or scan the QR code — no login, no app install. They see "Waiting for the next question" until you open a question. After submitting their answer (only once per question), the result bars appear live under each answer option.

- **Pause** — participants see the bars without correct answer highlights
- **Reveal** — correct answers highlighted in green for everyone
- **Close** — participants return to the waiting screen

If a participant hasn't voted when you pause or reveal, they see "Voting has ended." and the bars — but cannot submit. If a participant refreshes after submitting, they see the question with bars but cannot submit again.

---

## Projector view (beamer)

<img src="public/projector-view.png" alt="Projector View" width="700" />

Open `/view/<session_url>` in your browser and project it on the beamer. It shows the same question and live result bars as the participant view, plus the QR code and join URL — so participants can scan at any time. No submit button, no interaction needed.

The projector URL is shown in the host view next to the participant join URL as soon as your questions are loaded. If your organisation doesn't allow browser add-ins in PowerPoint, this is the recommended way to display live results during a presentation.
