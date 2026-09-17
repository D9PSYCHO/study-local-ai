import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  loadModel,
  completion,
  close,
  QWEN3_1_7B_INST_Q4,
} from '@qvac/sdk';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// On-device model manager
//
// Qwen3 1.7B (Q4 quantised) is downloaded once (first run) and kept loaded in
// memory. Everything runs locally through the QVAC SDK — no cloud, no API key,
// and the user's notes are never written to disk or sent anywhere.
// ---------------------------------------------------------------------------
const MODEL_STATE = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
};

const model = {
  state: MODEL_STATE.IDLE,
  id: null,
  progress: 0,
  downloaded: 0,
  total: 0,
  error: null,
  loadPromise: null,
  name: QWEN3_1_7B_INST_Q4.name,
};

// Clients subscribed to progress events (Server-Sent Events).
const clients = new Set();

function broadcast(event) {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function broadcastStatus() {
  broadcast({
    type: 'status',
    state: model.state,
    progress: model.progress,
    downloaded: model.downloaded,
    total: model.total,
    error: model.error,
    name: model.name,
  });
}

function ensureModelLoaded() {
  if (model.state === MODEL_STATE.READY) return Promise.resolve(model.id);
  if (model.loadPromise) return model.loadPromise;

  model.state = MODEL_STATE.LOADING;
  model.progress = 0;
  model.error = null;
  broadcastStatus();

  model.loadPromise = loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelConfig: {
      ctx_size: 4096,
    },
    onProgress: (p) => {
      model.progress = Math.round(p.percentage ?? 0);
      model.downloaded = p.downloaded ?? 0;
      model.total = p.total ?? 0;
      broadcastStatus();
    },
  })
    .then((id) => {
      model.id = id;
      model.state = MODEL_STATE.READY;
      model.progress = 100;
      broadcastStatus();
      console.log('[studylocal] LLM ready:', id);
      return id;
    })
    .catch((err) => {
      model.state = MODEL_STATE.ERROR;
      model.error = err?.message || String(err);
      model.loadPromise = null;
      broadcastStatus();
      console.error('[studylocal] model load failed:', model.error);
      throw err;
    });

  return model.loadPromise;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function truncateNotes(notes, maxChars = 14000) {
  if (notes.length <= maxChars) return notes;
  return (
    notes.slice(0, Math.floor(maxChars * 0.7)) +
    '\n\n[…notes truncated for context window…]\n\n' +
    notes.slice(-Math.floor(maxChars * 0.3))
  );
}

function buildQuizPrompt({ notes, count, difficulty }) {
  return [
    {
      role: 'system',
      content:
        'You are a careful quiz writer. Generate multiple-choice questions strictly grounded in the user\'s notes. ' +
        'Respond with ONLY valid JSON — no prose, no markdown fences. ' +
        'JSON shape: {"questions":[{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":0,"explanation":"..."}]}. ' +
        '`answer` is the 0-based index of the correct option. ' +
        '`explanation` references a specific fact from the notes. ' +
        'All questions must be answerable from the notes alone.',
    },
    {
      role: 'user',
      content:
        `Difficulty: ${difficulty}. Create exactly ${count} multiple-choice questions from these notes.\n\n` +
        `NOTES:\n${truncateNotes(notes)}\n\n` +
        `Return JSON only.`,
    },
  ];
}

function buildSummaryPrompt({ notes, length }) {
  const lenHint =
    length === 'short'
      ? '3–5 bullet points, ~80 words.'
      : length === 'long'
        ? 'A thorough paragraph-by-paragraph summary, ~400 words.'
        : 'A balanced summary with key terms, ~180 words.';
  return [
    {
      role: 'system',
      content:
        'You are a concise study summariser. Summarise the user\'s notes faithfully — ' +
        'only include facts present in the notes, never invent details. ' +
        'Preserve key terms, names and dates verbatim.',
    },
    {
      role: 'user',
      content:
        `Length: ${lenHint}\n\nNOTES:\n${truncateNotes(notes)}\n\nReturn the summary only.`,
    },
  ];
}

function buildExplainPrompt({ notes, question }) {
  return [
    {
      role: 'system',
      content:
        'You are a patient tutor. Answer the user\'s question using ONLY the provided notes. ' +
        'If the notes do not contain the answer, say "The notes do not cover this." and suggest what to look for. ' +
        'Cite the relevant part of the notes inline in brackets.',
    },
    {
      role: 'user',
      content:
        `QUESTION: ${question}\n\nNOTES:\n${truncateNotes(notes)}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Completion helper — invokes the on-device LLM and returns the final text.
// We do NOT stream to the client here; the frontend can fake streaming by
// chunking the returned text for nicer UX.
// ---------------------------------------------------------------------------
// Strip the model's internal <think>…</think> reasoning blocks so only the
// final answer reaches the UI. Falls back to the raw text if no closing tag
// is present (some generations stop early).
function stripThinking(text) {
  if (!text) return text;
  let t = String(text);
  // Repeatedly strip any <think>…</think> block, including across newlines.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // If the model left an unterminated <think> block, drop it too.
  const openIdx = t.indexOf('<think>');
  if (openIdx !== -1) t = t.slice(0, openIdx);
  return t.trim();
}

async function runCompletion(history, maxTokens = 1024) {
  const modelId = await ensureModelLoaded();
  const run = completion({
    modelId,
    history,
    stream: false,
    maxTokens,
  });
  const final = await run.final;
  const raw = final?.content ?? final?.raw?.fullText ?? '';
  return stripThinking(raw);
}

// Quiz needs strict JSON. We retry once if the model returns junk.
function safeParseJson(text) {
  // Strip markdown fences if present.
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  }
  // Find the first { and last } to be tolerant of stray text.
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}

async function generateQuiz({ notes, count, difficulty }) {
  const history = buildQuizPrompt({ notes, count, difficulty });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await runCompletion(history, 1800);
      const parsed = safeParseJson(text);
      if (
        parsed &&
        Array.isArray(parsed.questions) &&
        parsed.questions.length > 0
      ) {
        // Normalise each question.
        const qs = parsed.questions
          .filter(
            (q) =>
              q &&
              typeof q.question === 'string' &&
              Array.isArray(q.options) &&
              q.options.length >= 2 &&
              Number.isInteger(q.answer) &&
              q.answer >= 0 &&
              q.answer < q.options.length
          )
          .slice(0, count)
          .map((q, i) => ({
            id: i,
            question: q.question,
            options: q.options.map((o) => String(o)),
            answer: q.answer,
            explanation: q.explanation || '',
          }));
        if (qs.length > 0) return qs;
      }
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
  throw new Error('The model did not return valid quiz JSON.');
}

// ---------------------------------------------------------------------------
// HTTP setup
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Live model-download / readiness stream.
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.write(
    `event: status\ndata: ${JSON.stringify({
      type: 'status',
      state: model.state,
      progress: model.progress,
      downloaded: model.downloaded,
      total: model.total,
      error: model.error,
      name: model.name,
    })}\n\n`
  );
  req.on('close', () => clients.delete(res));
});

app.get('/api/status', (_req, res) => {
  res.json({
    state: model.state,
    progress: model.progress,
    downloaded: model.downloaded,
    total: model.total,
    error: model.error,
    modelName: model.name,
    sdkVersion: '@qvac/sdk ^0.19.1',
  });
});

// Warm the model up without generating yet.
app.post('/api/prepare', async (_req, res) => {
  try {
    await ensureModelLoaded();
    res.json({ ok: true, state: model.state });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Quiz endpoint — strict JSON output.
app.post('/api/quiz', async (req, res) => {
  const notes = (req.body?.notes ?? '').toString();
  const count = Math.min(Math.max(parseInt(req.body?.count ?? '5', 10) || 5, 1), 12);
  const difficulty = ['easy', 'medium', 'hard'].includes(req.body?.difficulty)
    ? req.body.difficulty
    : 'medium';

  if (!notes.trim()) {
    return res.status(400).json({ ok: false, error: 'No notes provided.' });
  }
  if (notes.trim().length < 80) {
    return res
      .status(400)
      .json({ ok: false, error: 'Notes are too short to generate a quiz (need ~80+ chars).' });
  }

  try {
    const started = Date.now();
    const questions = await generateQuiz({ notes, count, difficulty });
    const wallMs = Date.now() - started;
    res.json({
      ok: true,
      questions,
      meta: {
        modelName: model.name,
        count: questions.length,
        difficulty,
        wallMs,
        notesChars: notes.length,
      },
    });
  } catch (err) {
    console.error('[studylocal] quiz failed:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Summary endpoint — free-form text.
app.post('/api/summary', async (req, res) => {
  const notes = (req.body?.notes ?? '').toString();
  const length = ['short', 'medium', 'long'].includes(req.body?.length)
    ? req.body.length
    : 'medium';
  if (!notes.trim()) {
    return res.status(400).json({ ok: false, error: 'No notes provided.' });
  }
  try {
    const started = Date.now();
    const text = await runCompletion(buildSummaryPrompt({ notes, length }), 700);
    const wallMs = Date.now() - started;
    res.json({ ok: true, summary: text.trim(), wallMs, modelName: model.name });
  } catch (err) {
    console.error('[studylocal] summary failed:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Explain endpoint — answer a question grounded in the notes.
app.post('/api/explain', async (req, res) => {
  const notes = (req.body?.notes ?? '').toString();
  const question = (req.body?.question ?? '').toString().trim();
  if (!notes.trim() || !question) {
    return res
      .status(400)
      .json({ ok: false, error: 'Both notes and a question are required.' });
  }
  try {
    const started = Date.now();
    const text = await runCompletion(buildExplainPrompt({ notes, question }), 600);
    const wallMs = Date.now() - started;
    res.json({ ok: true, answer: text.trim(), wallMs, modelName: model.name });
  } catch (err) {
    console.error('[studylocal] explain failed:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Simple health check.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// PDF text extraction — accepts base64-encoded PDF, returns plain text.
app.post('/api/parse-pdf', async (req, res) => {
  const base64 = (req.body?.pdf ?? '').toString();
  if (!base64) {
    return res.status(400).json({ ok: false, error: 'No PDF data provided.' });
  }
  try {
    const buffer = Buffer.from(base64, 'base64');
    const data = await pdfParse(buffer);
    res.json({
      ok: true,
      text: data.text,
      pages: data.numpages,
      info: data.info,
    });
  } catch (err) {
    console.error('[studylocal] pdf parse failed:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Failed to parse PDF. The file may be corrupted or password-protected.' });
  }
});

const server = app.listen(PORT, () => {
  console.log('');
  console.log('  StudyLocal — on-device AI study assistant');
  console.log(`  →  http://localhost:${PORT}`);
  console.log('  All inference runs locally via the QVAC SDK. Nothing is uploaded.');
  console.log('');
  // Kick off the model load in the background so first generation is fast.
  ensureModelLoaded().catch(() => {});
});

async function shutdown() {
  console.log('\n[studylocal] shutting down…');
  server.close();
  try {
    await close();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);