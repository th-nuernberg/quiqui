<img src="public/quiqui-logo.png" alt="QuiQui" width="240" />

# Frequently asked questions

> Part of the [QuiQui](https://github.com/th-nuernberg/quiqui) open source project.

---

### How to get started?

Start with the [Quickstart for lecturers](QUICKSTART.md).

---

### Do I need a GitHub repo, or can I just use a file?

Either works. On the host page you choose **From file** — a single self-contained `.yaml` from your computer, no GitHub and no account — or **From GitHub**, a public repo of many question files. A file is the quickest way to start; a repo additionally gives you a bookmarkable host URL that re-pulls your latest questions in one click (see below). See the [Quickstart](QUICKSTART.md) for both routes.

---

### How do I open a quiz fastest during the lecture?

If your questions live in a GitHub repo, bookmark your full host URL — the one that already contains the repo address, e.g.:

```
https://kiz1.in.ohmportal.de/quiqui/<host-slug>?repo=https://github.com/you/quiqui-questions
```

Opening it pulls your questions and shows the QR code automatically — no further setup. Save it as a browser bookmark or drop it on your laptop or phone home screen, and you're one click from a running session at the start of every lecture. (A local file can't be bookmarked this way — the browser can't re-supply a file on its own, so you re-pick it with **From file** each time.)

---

### Can I use generative AI to create questions?

Yes. Use the AI assistant of your choice (ChatGPT, Claude, …) to draft your questions, then save the result as a `.yaml` file — load it directly with **From file**, or commit it to your question GitHub repo. QuiQui's YAML format is simple and LLMs generate it reliably.

There's a ready-made prompt that describes the exact format — copy it from **[Generate questions with an AI assistant](https://github.com/th-nuernberg/quiqui-questions#generate-questions-with-an-ai-assistant)** in the question repo, fill in your topic, and paste the assistant's output into a `.yaml` file.

---

### How do I show images or figures in a question?

Use standard Markdown image syntax in the question or an answer: `![caption](url)`. Two kinds of source work:

- **An external image URL** (`https://…`) — works from both a local file and a repo.
- **A repo-relative path** (`![Signal](grafiken/foo.gif)`) — for repos only. Commit the image alongside your `.yaml` files and QuiQui serves it from your pulled repo. (A local file has no repo behind it, so use a full `https://` URL there instead.)

Images render on the participant, projector, and host views alike. Keep them slide-resolution — a repo is capped at 1 MB and each image at 512 KB by default.

---

### Can I just use the example question repo, or do I need my own?

You can use [th-nuernberg/quiqui-questions](https://github.com/th-nuernberg/quiqui-questions) directly to try QuiQui out, but it's shared by everyone doing the same thing — if someone else runs a live poll from it at the same time, you'll land in the same session and see each other's votes. QuiQui warns you before this happens ("session may be in use elsewhere") so you don't clobber a colleague's poll by accident, but for a real lecture you want your own questions. Two easy ways: download the [`self-contained-example.yaml`](https://github.com/th-nuernberg/quiqui-questions/blob/main/self-contained-example.yaml) file, edit it, and load it with **From file** — or fork your own copy of the repo (a GitHub click, no coding involved). See [Creating your own question repo](QUICKSTART.md#creating-your-own-question-repo) in the Quickstart.

---

### Can I build graded tests with multiple questions that participants complete on their own?

No. QuiQui is a live, host-paced response tool with no login, and it deliberately stores no per-participant results — votes are anonymous and vanish when the session ends. If you need self-paced tests with grading and a gradebook, use Moodle or a similar platform instead.

---

Have a question that isn't covered here? [Open an issue](https://github.com/th-nuernberg/quiqui/issues).
