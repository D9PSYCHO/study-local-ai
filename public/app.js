// StudyLocal — on-device AI study assistant frontend.

const els = {
  statusPill: document.getElementById('statusPill'),
  statusText: document.getElementById('statusText'),
  modelCard: document.getElementById('modelCard'),
  modelTitle: document.getElementById('modelTitle'),
  modelSub: document.getElementById('modelSub'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  progressBytes: document.getElementById('progressBytes'),
  notesInput: document.getElementById('notesInput'),
  charCount: document.getElementById('charCount'),
  wordCount: document.getElementById('wordCount'),
  sampleBtn: document.getElementById('sampleBtn'),
  uploadBtn: document.getElementById('uploadBtn'),
  clearBtn: document.getElementById('clearBtn'),
  fileInput: document.getElementById('fileInput'),
  segBtns: Array.from(document.querySelectorAll('.seg-btn')),
  optsQuiz: document.getElementById('optsQuiz'),
  optsSummary: document.getElementById('optsSummary'),
  optsExplain: document.getElementById('optsExplain'),
  quizCount: document.getElementById('quizCount'),
  quizCountVal: document.getElementById('quizCountVal'),
  quizDifficulty: document.getElementById('quizDifficulty'),
  summaryLength: document.getElementById('summaryLength'),
  explainQuestion: document.getElementById('explainQuestion'),
  runBtn: document.getElementById('runBtn'),
  runLabel: document.getElementById('runLabel'),
  runHint: document.getElementById('runHint'),
  resultCard: document.getElementById('resultCard'),
  resultTitle: document.getElementById('resultTitle'),
  resultMeta: document.getElementById('resultMeta'),
  resultBody: document.getElementById('resultBody'),
};

const state = {
  mode: 'quiz',
  modelReady: false,
  busy: false,
  quiz: null,         // last generated quiz
  answers: new Map(), // questionId -> chosen option index
  checked: false,
};

// ----- Mode switching -------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  els.segBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  els.optsQuiz.classList.toggle('hidden', mode !== 'quiz');
  els.optsSummary.classList.toggle('hidden', mode !== 'summary');
  els.optsExplain.classList.toggle('hidden', mode !== 'explain');

  const labels = {
    quiz: { btn: 'Generate quiz', hint: 'Runs on-device · ~10–30s for 5 questions' },
    summary: { btn: 'Summarise notes', hint: 'Runs on-device · ~10–25s' },
    explain: { btn: 'Explain', hint: 'Runs on-device · ~10–25s' },
  };
  els.runLabel.textContent = labels[mode].btn;
  els.runHint.textContent = labels[mode].hint;
  refreshRunButton();
}

els.segBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ----- Quiz count slider ----------------------------------------------------

els.quizCount.addEventListener('input', () => {
  els.quizCountVal.textContent = els.quizCount.value;
});

// ----- Notes input handlers -------------------------------------------------

function updateCounts() {
  const v = els.notesInput.value;
  els.charCount.textContent = `${v.length.toLocaleString()} characters`;
  const words = v.trim() ? v.trim().split(/\s+/).length : 0;
  els.wordCount.textContent = `${words.toLocaleString()} words`;
  refreshRunButton();
}
els.notesInput.addEventListener('input', updateCounts);

els.sampleBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/sample-notes/cell-biology.txt');
    if (!res.ok) throw new Error('Sample not found');
    const txt = await res.text();
    els.notesInput.value = txt;
    updateCounts();
    els.notesInput.focus();
  } catch (err) {
    console.error(err);
  }
});

els.uploadBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const txt = await file.text();
  els.notesInput.value = txt;
  updateCounts();
  els.fileInput.value = '';
});

els.clearBtn.addEventListener('click', () => {
  els.notesInput.value = '';
  state.quiz = null;
  state.answers.clear();
  state.checked = false;
  els.resultCard.hidden = true;
  updateCounts();
});

// ----- SSE model-status stream ----------------------------------------------

const es = new EventSource('/api/events');
es.addEventListener('status', (ev) => {
  let data;
  try { data = JSON.parse(ev.data); } catch { return; }
  applyStatus(data);
});
es.onerror = () => { /* browser will auto-reconnect */ };

function applyStatus({ state: s, progress, downloaded, total, error, name }) {
  const label = {
    idle: 'Idle',
    loading: `Loading ${name || 'model'}…`,
    ready: 'Ready · on-device',
    error: 'Error',
  }[s] || s;

  els.statusPill.dataset.state = s;
  els.statusText.textContent = label;
  els.modelCard.dataset.state = s;

  if (s === 'ready') {
    state.modelReady = true;
    els.progressFill.style.width = '100%';
    els.progressLabel.textContent = '100%';
    els.progressBytes.textContent = 'Cached on this device';
    els.modelTitle.textContent = `${name || 'Model'} ready`;
    els.modelSub.textContent = 'All future requests reuse the cached model — no re-download.';
  } else if (s === 'loading') {
    els.progressFill.style.width = `${progress}%`;
    els.progressLabel.textContent = `${progress}%`;
    if (total) {
      const mb = (n) => (n / (1024 * 1024)).toFixed(1);
      els.progressBytes.textContent = `${mb(downloaded)} / ${mb(total)} MB`;
    }
    els.modelTitle.textContent = 'First-run download';
    els.modelSub.textContent = `${name || 'The model'} is being downloaded once and cached locally. Subsequent starts are instant.`;
  } else if (s === 'error') {
    els.modelTitle.textContent = 'Model failed to load';
    els.modelSub.textContent = error || 'Unknown error';
  }
  refreshRunButton();
}

// ----- Run button & dispatch ------------------------------------------------

function refreshRunButton() {
  const hasNotes = els.notesInput.value.trim().length > 0;
  const explainOk = state.mode !== 'explain' || els.explainQuestion.value.trim().length > 0;
  els.runBtn.disabled = !hasNotes || !state.modelReady || state.busy || !explainOk;
}

els.explainQuestion.addEventListener('input', refreshRunButton);

els.runBtn.addEventListener('click', run);

async function run() {
  if (state.busy || !state.modelReady) return;
  state.busy = true;
  els.runBtn.disabled = true;
  els.runBtn.classList.add('busy');

  const notes = els.notesInput.value.trim();
  els.resultCard.hidden = false;
  els.resultBody.innerHTML = '';
  renderLoading();

  try {
    if (state.mode === 'quiz') {
      const res = await fetchJson('/api/quiz', {
        notes,
        count: parseInt(els.quizCount.value, 10),
        difficulty: els.quizDifficulty.value,
      });
      renderQuiz(res);
    } else if (state.mode === 'summary') {
      const res = await fetchJson('/api/summary', {
        notes,
        length: els.summaryLength.value,
      });
      renderSummary(res);
    } else if (state.mode === 'explain') {
      const res = await fetchJson('/api/explain', {
        notes,
        question: els.explainQuestion.value.trim(),
      });
      renderExplain(res);
    }
  } catch (err) {
    renderError(err.message || String(err));
  } finally {
    state.busy = false;
    els.runBtn.classList.remove('busy');
    refreshRunButton();
  }
}

async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad JSON response.' }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ----- Render: loading & error ---------------------------------------------

function renderLoading() {
  els.resultTitle.textContent = state.mode === 'quiz' ? 'Generating quiz…' :
    state.mode === 'summary' ? 'Summarising…' : 'Thinking…';
  els.resultMeta.innerHTML = '';
  els.resultBody.innerHTML = `
    <div class="loading-overlay">
      <div class="spinner" style="width:30px;height:30px;border-width:3px;"></div>
      <div class="loading-text">Running on-device with Qwen3 1.7B…</div>
      <div class="loading-sub">This usually takes 10–30 seconds.</div>
    </div>`;
}

function renderError(msg) {
  els.resultTitle.textContent = 'Something went wrong';
  els.resultMeta.innerHTML = '';
  els.resultBody.innerHTML = `<div class="text-out" style="border-color:var(--bad);color:var(--bad)">${escapeHtml(msg)}</div>`;
}

// ----- Render: quiz ---------------------------------------------------------

function renderQuiz({ questions, meta }) {
  state.quiz = questions;
  state.answers.clear();
  state.checked = false;

  els.resultTitle.textContent = `Quiz · ${questions.length} questions`;
  els.resultMeta.innerHTML = metaChips([
    ['Difficulty', meta.difficulty],
    ['Wall time', `${(meta.wallMs / 1000).toFixed(1)}s`],
    ['Notes', `${meta.notesChars.toLocaleString()} chars`],
    ['Model', meta.modelName],
  ]);

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const html = questions.map((q) => `
    <div class="q-card" data-qid="${q.id}">
      <div class="q-num">${q.id + 1}</div>
      <div class="q-text">${escapeHtml(q.question)}</div>
      <div class="q-opts">
        ${q.options.map((opt, i) => `
          <button class="q-opt" data-i="${i}" type="button">
            <span class="letter">${letters[i] || (i + 1)}</span>
            <span>${escapeHtml(opt)}</span>
          </button>`).join('')}
      </div>
      <div class="q-explain"><strong>Why:</strong> ${escapeHtml(q.explanation)}</div>
    </div>`).join('');

  els.resultBody.innerHTML = `
    <div class="quiz">${html}</div>
    <div class="quiz-foot">
      <div class="score">
        <span>Pick an answer for each question, then check.</span>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn ghost" id="resetQuizBtn" type="button">Reset</button>
        <button class="btn primary" id="checkQuizBtn" type="button">Check answers</button>
      </div>
    </div>`;

  els.resultBody.querySelectorAll('.q-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.q-card');
      const qid = parseInt(card.dataset.qid, 10);
      if (state.checked) return;
      card.querySelectorAll('.q-opt').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.set(qid, parseInt(btn.dataset.i, 10));
    });
  });

  document.getElementById('checkQuizBtn').addEventListener('click', checkQuiz);
  document.getElementById('resetQuizBtn').addEventListener('click', () => renderQuiz({ questions, meta }));
}

function checkQuiz() {
  if (!state.quiz) return;
  state.checked = true;
  let correct = 0;
  state.quiz.forEach((q) => {
    const chosen = state.answers.get(q.id);
    const card = els.resultBody.querySelector(`.q-card[data-qid="${q.id}"]`);
    const btns = card.querySelectorAll('.q-opt');
    btns.forEach((b, i) => {
      b.disabled = true;
      if (i === q.answer) b.classList.add('correct');
      else if (i === chosen) b.classList.add('wrong');
    });
    card.querySelector('.q-explain').classList.add('show');
    if (chosen === q.answer) correct++;
  });
  const total = state.quiz.length;
  els.resultBody.querySelector('.score').innerHTML = `
    <span class="score">You scored</span>
    <span class="score-badge">${correct} / ${total}</span>
  `;
}

// ----- Render: summary ------------------------------------------------------

function renderSummary({ summary, wallMs, modelName }) {
  els.resultTitle.textContent = 'Summary';
  els.resultMeta.innerHTML = metaChips([
    ['Wall time', `${(wallMs / 1000).toFixed(1)}s`],
    ['Length', `${summary.length} chars`],
    ['Model', modelName],
  ]);
  els.resultBody.innerHTML = `<div class="text-out">${escapeHtml(summary)}</div>`;
}

// ----- Render: explain ------------------------------------------------------

function renderExplain({ answer, wallMs, modelName }) {
  els.resultTitle.textContent = 'Answer';
  els.resultMeta.innerHTML = metaChips([
    ['Wall time', `${(wallMs / 1000).toFixed(1)}s`],
    ['Model', modelName],
  ]);
  els.resultBody.innerHTML = `<div class="text-out">${escapeHtml(answer)}</div>`;
}

// ----- Helpers --------------------------------------------------------------

function metaChips(items) {
  return items.map(([k, v]) => `<span class="chip">${escapeHtml(k)}: <strong>${escapeHtml(String(v))}</strong></span>`).join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Init
updateCounts();
setMode('quiz');