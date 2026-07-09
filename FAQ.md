<img src="public/quiqui-logo.png" alt="QuiQui" width="240" />

# Frequently asked questions

> Part of the [QuiQui](https://github.com/th-nuernberg/quiqui) open source project. New here? Start with the [Quickstart for lecturers](QUICKSTART.md).

---

### How do I open a quiz fastest during the lecture?

Bookmark your full host URL — the one that already contains your question repo, e.g.:

```
https://kiz1.in.ohmportal.de/quiqui/<host-slug>?repo=https://github.com/you/quiqui-questions
```

Opening it pulls your questions and shows the QR code automatically — no further setup. Save it as a browser bookmark or drop it on your laptop or phone home screen, and you're one click from a running session at the start of every lecture.

---

### Can I use generative AI to create questions?

Yes. Use the AI assistant of your choice (ChatGPT, Claude, …) to draft your questions, then commit the result to your question GitHub repo. QuiQui's YAML format is simple and LLMs generate it reliably.

There's a ready-made prompt that describes the exact format — copy it from **[Generate questions with an AI assistant](https://github.com/th-nuernberg/quiqui-questions#generate-questions-with-an-ai-assistant)** in the question repo, fill in your topic, and paste the assistant's output into a `.yaml` file.

---

### How do I show images or figures in a question?

Put the figure on a slide and show it the usual way, then use QuiQui just for the question and answer options. QuiQui questions are text (with Markdown and LaTeX), so for visual material your slides and QuiQui work side by side: the figure on the beamer, the live poll on the phones.

---

### Can I just use the example question repo, or do I need my own?

You can use [th-nuernberg/quiqui-questions](https://github.com/th-nuernberg/quiqui-questions) directly to try QuiQui out, but it's shared by everyone doing the same thing — if someone else runs a live poll from it at the same time, you'll land in the same session and see each other's votes. QuiQui warns you before this happens ("session may be in use elsewhere") so you don't clobber a colleague's poll by accident, but the real fix is forking your own copy — it's a GitHub click, no coding involved. See [Creating your own question repo](QUICKSTART.md#creating-your-own-question-repo) in the Quickstart.

---

### Can I build graded tests with multiple questions that participants complete on their own?

No. QuiQui is a live, host-paced response tool with no login, and it deliberately stores no per-participant results — votes are anonymous and vanish when the session ends. If you need self-paced tests with grading and a gradebook, use Moodle or a similar platform instead.

---

Have a question that isn't covered here? [Open an issue](https://github.com/th-nuernberg/quiqui/issues).
