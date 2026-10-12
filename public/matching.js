// Shared rendering for `matching` and `ranking` questions — used by
// participant.js, projector.js and host.js (no bundler, so one plain script that
// exposes `window.QQ`). All three views show one row per item:
//
//   matching  "The capital of Germany is [ Berlin ▾ ]."   (blank inside the text)
//   ranking   "[ 2 ▾ ]  Embed the chunks"                  (rank in front)
//
// and, once results are visible, one stacked bar per row with a legend beneath.
//
// Wire shape (built by server.js buildAssignmentQuestion):
//   answers[i]   item text; matching: contains BLANK, ranking: plain item text
//   choices[i]   values offered for item i
//   capacity     null, or how often each value may be used (exclusive pool —
//                a value chosen in one dropdown disappears from the others)
//   scored       whether a key exists
//   correct      host only — correct index into choices[i], per item
//
// Modes: 'participant' (selects), 'projector' (read-only blanks), 'host' (the
// key is shown in place of the blank; bars always visible).

(function (global) {
  const BLANK = 'QUIQUIBLANK';
  const GREEN = '#4caf50';
  const GREY = '#cfcfca';
  // No green in here — green is reserved for "correct".
  const PALETTE = ['#3b6fd4', '#e08a1e', '#8e5bc4', '#c2517a', '#4aa3b8', '#7a8696'];

  const isAssignment = q => !!q && (q.type === 'matching' || q.type === 'ranking');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Put `node` where the blank token sits in already-sanitised HTML. Walks text
  // nodes (never string-replaces) so a token that ended up inside an attribute
  // can't be turned into markup. Falls back to appending if no token is found.
  function placeBlank(container, node) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      const at = t.nodeValue.indexOf(BLANK);
      if (at === -1) continue;
      const after = t.splitText(at + BLANK.length);
      t.nodeValue = t.nodeValue.slice(0, at);
      t.parentNode.insertBefore(node, after);
      return;
    }
    container.appendChild(node);
  }

  // opts: { mode, md (inline Markdown → sanitised HTML), onChange(picks, complete) }
  function create(root, q, opts) {
    const mode = opts.mode;
    const md = opts.md;
    const n = q.answers.length;
    const ranking = q.type === 'ranking';
    const unscoredRanking = ranking && q.scored === false;
    const hasKey = Array.isArray(q.correct);

    const picks = new Array(n).fill(-1);
    const rows = [];          // { row, widget, bar, legend, mean }
    let votes = null;
    let total = 0;
    let correct = null;       // revealed key: per-item choice index
    let barsVisible = mode === 'host';
    let locked = false;

    root.innerHTML = '';

    function makeWidget(i) {
      if (mode === 'participant') {
        const sel = el('select', 'match-select');
        sel.setAttribute('aria-label', `Answer for item ${i + 1}`);
        sel.addEventListener('change', () => {
          picks[i] = sel.value === '' ? -1 : parseInt(sel.value, 10);
          refreshOptions();
          if (opts.onChange) opts.onChange(picks.slice(), complete());
        });
        return sel;
      }
      if (mode === 'host' && hasKey) {
        const c = q.correct[i];
        return el('span', 'match-key', ranking ? String(c + 1) : q.choices[i][c]);
      }
      return el('span', 'match-blank');
    }

    for (let i = 0; i < n; i++) {
      const row = el('div', 'match-item');
      const line = el('div', 'match-line' + (ranking ? ' match-line--rank' : ''));
      const widget = makeWidget(i);
      if (ranking) {
        line.appendChild(widget);
        const text = el('span', 'match-text');
        text.innerHTML = md(q.answers[i]);
        line.appendChild(text);
      } else {
        line.innerHTML = md(q.answers[i]);
        placeBlank(line, widget);
      }
      const mean = el('span', 'match-mean');
      line.appendChild(mean);
      const bar = el('div', 'match-bar');
      const legend = el('div', 'match-legend');
      row.append(line, bar, legend);
      root.appendChild(row);
      rows.push({ row, widget, bar, legend, mean });
    }

    // ── Participant dropdowns ────────────────────────────────────────────────
    // Rebuilds every select's options so that, in an exclusive pool, a value
    // already used up elsewhere is no longer offered (the current value always is).
    function refreshOptions() {
      if (mode !== 'participant') return;
      const used = q.capacity ? q.capacity.map(() => 0) : null;
      if (used) picks.forEach(c => { if (c >= 0) used[c]++; });
      rows.forEach((r, i) => {
        const sel = r.widget;
        sel.innerHTML = '';
        sel.appendChild(new Option('—', ''));
        q.choices[i].forEach((label, c) => {
          if (used && c !== picks[i] && used[c] >= q.capacity[c]) return;
          const o = new Option(label, String(c));
          if (c === picks[i]) o.selected = true;
          sel.appendChild(o);
        });
        sel.value = picks[i] >= 0 ? String(picks[i]) : '';
        sel.disabled = locked;
      });
    }

    function complete() { return picks.every(c => c >= 0); }

    // ── Result bars ──────────────────────────────────────────────────────────
    function colorFor(i, c) {
      if (correct) return c === correct[i] ? GREEN : GREY;
      if (ranking) {
        const k = q.choices[i].length;
        return `hsl(215 60% ${28 + (k > 1 ? (44 * c) / (k - 1) : 0)}%)`;
      }
      return PALETTE[c % PALETTE.length];
    }

    function render() {
      const means = [];
      rows.forEach((r, i) => {
        const counts = (votes && votes[i]) || [];
        r.bar.classList.toggle('visible', barsVisible);
        r.legend.classList.toggle('visible', barsVisible && total > 0);
        r.bar.innerHTML = '';
        r.legend.innerHTML = '';
        let sum = 0;
        q.choices[i].forEach((label, c) => {
          const cnt = counts[c] || 0;
          sum += (c + 1) * cnt;
          if (!cnt || !total) return;
          const pct = Math.round((cnt / total) * 100);
          const color = colorFor(i, c);
          const seg = el('span', 'match-seg');
          seg.style.width = `${(cnt / total) * 100}%`;
          seg.style.background = color;
          r.bar.appendChild(seg);

          const isCorrect = !!correct && c === correct[i];
          const entry = el('span', 'match-leg'
            + (isCorrect ? ' match-leg--correct' : '')
            + (picks[i] === c && mode === 'participant' ? ' match-leg--mine' : ''));
          const sw = el('i', 'match-sw');
          sw.style.background = color;
          entry.append(sw, document.createTextNode(
            `${ranking ? 'Rank ' : ''}${label} ${pct}% (${cnt})`
            + (picks[i] === c && mode === 'participant' ? ' · you' : '')));
          r.legend.appendChild(entry);
        });
        means[i] = total ? sum / total : null;
      });

      // Unscored ranking: the room's consensus order is the result.
      if (unscoredRanking && barsVisible && total > 0) {
        const order = rows.map((_, i) => i).sort((a, b) => means[a] - means[b]);
        order.forEach(i => {
          rows[i].mean.textContent = `Ø ${means[i].toFixed(1)}`;
          root.appendChild(rows[i].row);
        });
      } else {
        rows.forEach((r, i) => { r.mean.textContent = ''; root.appendChild(r.row); });
      }

      // Per-row verdict on the participant's own pick + filled blanks elsewhere.
      rows.forEach((r, i) => {
        if (mode === 'participant') {
          r.widget.classList.toggle('match-select--ok', !!correct && picks[i] === correct[i]);
          r.widget.classList.toggle('match-select--bad', !!correct && picks[i] >= 0 && picks[i] !== correct[i]);
        } else if (mode === 'projector') {
          const showKey = !!correct;
          r.widget.textContent = showKey ? (ranking ? String(correct[i] + 1) : q.choices[i][correct[i]]) : '';
          r.widget.classList.toggle('match-blank--correct', showKey);
        } else if (mode === 'host' && hasKey) {
          r.widget.classList.toggle('match-key--correct', !!correct);
        }
      });
    }

    refreshOptions();
    render();

    return {
      picks: () => picks.slice(),
      complete,
      setPicks(arr) {
        arr.forEach((c, i) => { if (i < n && Number.isInteger(c)) picks[i] = c; });
        refreshOptions();
        render();
      },
      lock() { locked = true; refreshOptions(); },
      showBars() { barsVisible = true; render(); },
      update(v, t) { votes = v; total = t || 0; render(); },
      reveal(correctIdx) {
        if (Array.isArray(correctIdx) && correctIdx.length === n) correct = correctIdx;
        render();
      },
    };
  }

  // Host: rebuild the whole chart from current state (host.js re-renders on every
  // vote-update, like its single/multiple bar chart).
  function renderHost(root, q, votes, total, correctIdx, md) {
    const view = create(root, q, { mode: 'host', md });
    view.update(votes, total);
    if (correctIdx && correctIdx.length) view.reveal(correctIdx);
  }

  global.QQ = { BLANK, isAssignment, create, renderHost };
})(window);
