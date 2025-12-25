// app.js
// Movie Quotes v0.2 (no backend)
// - Daily shared set of 5 quotes, chosen via constrained rotation (simple version here)
// - First wrong ends run
// - Hints optional; tracked
// - Yesterday answers revealed next day (local to device)
// NOTE: This v0.2 uses deterministic daily selection with a cooldown-ish shuffle,
//       but without a server it can't enforce global cooldown across all users.
//       It *is* identical for everyone because it's derived from the date.
//       
// Author by Atif Mumtaz
// version 0.2


const STORAGE_KEY = "mq_v02_state";
const START_DATE_UTC = "2025-01-01"; // any fixed anchor date

// ------- DOM -------
const quoteText = document.getElementById("quoteText");
const progressBadge = document.getElementById("progressBadge");
const answerInput = document.getElementById("answerInput");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const hint1Btn = document.getElementById("hint1Btn");
const hint2Btn = document.getElementById("hint2Btn");
const hint1Box = document.getElementById("hint1Box");
const hint2Box = document.getElementById("hint2Box");
const hintUsedEl = document.getElementById("hintUsed");
const resultArea = document.getElementById("resultArea");
const resultMsg = document.getElementById("resultMsg");
const shareCardEl = document.getElementById("shareCard");
const shareBtn = document.getElementById("shareBtn");
const copyBtn = document.getElementById("copyBtn");
const runIdEl = document.getElementById("runId");

const yesterdayCard = document.getElementById("yesterdayCard");
const yesterdayList = document.getElementById("yesterdayList");
const hideYesterdayBtn = document.getElementById("hideYesterdayBtn");

const howBtn = document.getElementById("howBtn");
const howDialog = document.getElementById("howDialog");
const closeHowBtn = document.getElementById("closeHowBtn");

const PLAY_URL = "https://cuetheline.com/";

// ------- Helpers -------
function track(event, data = {}) {
  if (window.goatcounter && typeof window.goatcounter.count === "function") {
    window.goatcounter.count({
      path: `event/${event}`,
      title: JSON.stringify(data)
    });
  }
}

function todayKeyLocal() {
  const d = new Date();
  // local day key: YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysSinceAnchorLocal(anchorISO) {
  const anchor = new Date(anchorISO + "T00:00:00");
  const now = new Date();
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ms = b - a;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9 :\-]/g, "")   // keep letters, numbers, space, colon, dash
    .replace(/\s+/g, " ");
}

function mulberry32(seed) {
  // deterministic PRNG
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDeterministicDailySet(pool, dayIndex) {
  // Simple constrained selection:
  // - Choose 5 with target tiers: [1,2,2,3,4?] but we only have tiers 1-3 in sample.
  // We'll do: [1,2,2,3,3] and ensure quote #1 is not hard (tier 4).
  // Real 75-day cooldown needs a server or bigger local history; we'll keep it deterministic + varied.

  const rng = mulberry32(123456 + dayIndex * 99991);
  const byTier = new Map();
  for (const q of pool) {
    const t = q.tier || 2;
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(q);
  }
  // shuffle each tier deterministically
  for (const [t, arr] of byTier.entries()) {
    arr.sort(() => rng() - 0.5);
    byTier.set(t, arr);
  }

  const desired = [1, 2, 2, 3, 3]; // v0.2
  const chosen = [];
  for (const t of desired) {
    const arr = byTier.get(t) || [];
    if (arr.length) chosen.push(arr.pop());
  }

  // if missing due to small pool, fill from any tier
  if (chosen.length < 5) {
    const all = [...pool].sort(() => rng() - 0.5);
    for (const q of all) {
      if (chosen.find(x => x.id === q.id)) continue;
      chosen.push(q);
      if (chosen.length === 5) break;
    }
  }

  // shuffle order (but ensure first isn't "hard" tier 4 in future)
  chosen.sort(() => rng() - 0.5);
  // soft guard: quote #1 should not be tier 4
  if (chosen[0] && chosen[0].tier === 4) {
    const swapIdx = chosen.findIndex(q => q.tier !== 4);
    if (swapIdx > 0) [chosen[0], chosen[swapIdx]] = [chosen[swapIdx], chosen[0]];
  }

  return chosen.slice(0, 5);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function buildShareCard(stateForToday) {
  const marks = stateForToday.marks.join("");
  const streak = stateForToday.correctCount;
  const hintsUsed = stateForToday.hintsUsed;

  let line2 = "";
  if (streak === 5) {
    line2 = "Perfect 5/5";
  } else {
    line2 = `Score: ${streak}/5`;
  }

  return [
    "🎬 Cue The Line — Today’s run",
    marks,
    line2,
    `Hints used: ${hintsUsed}`,
    "",
    `Take the movie trivia challenge: ${PLAY_URL}`
  ].join("\n");
}

// ------- App -------
let DATA = null;
let pool = [];
let closers = [];

let today = todayKeyLocal();
let dayIndex = daysSinceAnchorLocal(START_DATE_UTC);
let runId = dayIndex + 1;

let dailySet = [];
let currentIdx = 0;

let state = loadState();

function getTodayState() {
  if (!state[today]) {
    state[today] = {
      startedAt: Date.now(),
      correctCount: 0,
      marks: [],
      hintsUsed: 0,
      hint1Shown: {},
      hint2Shown: {},
      completed: false,     // ✅ NEW
      completedAt: null,    // ✅ NEW
      setIds: []
    };
  }
  return state[today];
}

function getYesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function renderYesterdayIfAvailable() {
  const yKey = getYesterdayKey();
  const y = state[yKey];
  if (!y || !y.setIds || y.setIds.length !== 5) {
    yesterdayCard.hidden = true;
    return;
  }

  // Show list only if today has started (or if user explicitly wants it)
  yesterdayCard.hidden = false;
  yesterdayList.innerHTML = "";

  const items = y.setIds.map((id, idx) => {
    const q = pool.find(x => x.id === id);
    if (!q) return null;
    // display first answer variant (title-ish). We only store normalized answers, so show best guess from data:
    // We'll store a "display" later; for now show the first raw answer but Title-Case-ish:
    const dispTitle = q.display || "Unknown";
    return {
        idx: idx + 1,
        quote: q.quote,
        movie: dispTitle,
        year: q.year || ""
      };
  }).filter(Boolean);

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "yItem";
    div.innerHTML = `<div><b>${it.idx}.</b> “${escapeHtml(it.quote)}”</div>
                     <div>— <b>${escapeHtml(it.movie)}</b>${it.year ? ` (${it.year})` : ""}</div>`;
    yesterdayList.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(msg, tone = "muted") {
  statusEl.textContent = msg || "";
  statusEl.style.color = tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--bad)" : "var(--muted)";
}

function updateUIForQuote(tState) {
  const q = dailySet[currentIdx];
  progressBadge.hidden = false;
  progressBadge.textContent = `${currentIdx + 1} / 5`;
  quoteText.textContent = q.quote;

  // hints
  hint1Box.hidden = true;
  hint2Box.hidden = true;
  hint1Btn.disabled = false;
  hint2Btn.disabled = false;

  const shown1 = !!tState.hint1Shown[q.id];
  const shown2 = !!tState.hint2Shown[q.id];

  if (shown1) {
    hint1Box.hidden = false;
    hint1Box.textContent = `Hint 1: ${q.hint1}`;
    hint1Btn.disabled = true;
  }
  if (shown2) {
    hint2Box.hidden = false;
    hint2Box.textContent = `Hint 2: ${q.hint2}`;
    hint2Btn.disabled = true;
  }

  hintUsedEl.textContent = `Hints used: ${tState.hintsUsed}`;

  answerInput.value = "";
  answerInput.focus();
  resultArea.hidden = true;
  setStatus("");
}


function pickCloser(dayIdx) {
  if (!closers.length) return { quote: "Well, nobody’s perfect.", source: "Some Like It Hot" };
  const rng = mulberry32(777 + dayIdx * 1337);
  const i = Math.floor(rng() * closers.length);
  return closers[i];
}

function matchesAnswer(userInput, q) {
  const u = normalize(userInput);
  if (!u) return false;
  const answers = (q.answers || []).map(normalize);
  // allow direct match
  if (answers.includes(u)) return true;

  // light fuzzy: allow removing leading "the "
  const u2 = u.replace(/^the /, "");
  if (answers.includes(u2)) return true;

  // allow collapsing punctuation differences (we already stripped most)
  // allow matching if user typed subset and it's long enough (avoid too loose)
  for (const a of answers) {
    if (a.length >= 8 && u.length >= 8 && (a.includes(u) || u.includes(a))) return true;
  }
  return false;
}

async function init() {
  DATA = await fetch("quotes.json", { cache: "no-store" }).then(r => r.json());
  pool = DATA.pool || [];
  closers = DATA.perfect_closers || [];

  runIdEl.textContent = `QuoteRun #${runId}`;

  const tState = getTodayState();

  // Determine daily set deterministically from date.
  dailySet = pickDeterministicDailySet(pool, dayIndex);
  tState.setIds = dailySet.map(q => q.id); // store for "tomorrow reveal"
  saveState(state);

  // If run already ended today, show final state
  if (tState.completed) {
    // show last known share card + message
    progressBadge.hidden = true;
    submitBtn.disabled = true;
    answerInput.disabled = true;
    hint1Btn.disabled = true;
    hint2Btn.disabled = true;

    // Build "marks" display
    quoteText.textContent = "Today’s run is complete.";
    //progressBadge.textContent = `${clamp(tState.marks.length, 0, 5)} / 5`;
    resultArea.hidden = false;

    resultMsg.innerHTML = `
      <div><b>Here’s how you did today:</b></div>
      <div style="margin-top:6px">Score: ${tState.correctCount} / 5</div>
      <div class="returnHint">
        Tomorrow, today’s answers unlock above — and you’ll get a new set of 5 quotes.
      </div>
    `;

    shareCardEl.textContent = buildShareCard(tState);
    renderYesterdayIfAvailable();
    return;

  }

  // Otherwise render first quote (or resume)
  currentIdx = tState.marks.length; //  • Marks length = how many questions attempted
  updateUIForQuote(tState);
  renderYesterdayIfAvailable();
}

// ------- Events -------
hint1Btn.addEventListener("click", () => {
  const tState = getTodayState();
  const q = dailySet[currentIdx];
  if (!q) return;
  if (!tState.hint1Shown[q.id]) {
    tState.hint1Shown[q.id] = true;
    tState.hintsUsed += 1;
    track("hint_used", { hint: 1, index: currentIdx + 1 });
    saveState(state);
  }
  hint1Box.hidden = false;
  hint1Box.textContent = `Hint 1: ${q.hint1}`;
  hint1Btn.disabled = true;
  hintUsedEl.textContent = `Hints used: ${tState.hintsUsed}`;
});

hint2Btn.addEventListener("click", () => {
  const tState = getTodayState();
  const q = dailySet[currentIdx];
  if (!q) return;
  if (!tState.hint2Shown[q.id]) {
    tState.hint2Shown[q.id] = true;
    tState.hintsUsed += 1;
    track("hint_used", { hint: 2, index: currentIdx + 1 });
    saveState(state);
  }
  hint2Box.hidden = false;
  hint2Box.textContent = `Hint 2: ${q.hint2}`;
  hint2Btn.disabled = true;
  hintUsedEl.textContent = `Hints used: ${tState.hintsUsed}`;
});

submitBtn.addEventListener("click", () => {
  const tState = getTodayState();
  const q = dailySet[currentIdx];
  if (!q || tState.completed) return;

  const ans = answerInput.value;
  if (!ans.trim()) {
    setStatus("Type a movie name first.");
    return;
  }

  const ok = matchesAnswer(ans, q);

  // record result
  tState.marks.push(ok ? "✅" : "❌");
  if (ok) {
    tState.correctCount += 1;
    track("answer_correct", { index: currentIdx + 1 });
  } else {
    track("answer_wrong", { index: currentIdx + 1 });
  }

  saveState(state);

  // move forward
  currentIdx += 1;

  // finished all 5?
  if (currentIdx >= 5) {
    finishRun(tState);
    return;
  }

  // continue
  setStatus(ok ? "Correct." : "Not quite.", ok ? "ok" : "bad");
  setTimeout(() => {
    updateUIForQuote(getTodayState());
  }, 450);
  });

answerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitBtn.click();
});

shareBtn.addEventListener("click", async () => {
  const tState = getTodayState();
  const text = shareCardEl.textContent;
  track("share_clicked");
  try {
    if (navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      setStatus("Copied to clipboard.");
    }
  } catch {
    // ignore
  }
});

copyBtn.addEventListener("click", async () => {
  const text = shareCardEl.textContent;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied to clipboard.");
  } catch {
    setStatus("Could not copy. Select the text and copy manually.");
  }
});

hideYesterdayBtn.addEventListener("click", () => {
  yesterdayCard.hidden = true;
});

howBtn.addEventListener("click", () => howDialog.showModal());
closeHowBtn.addEventListener("click", () => howDialog.close());

// ------- Start -------
init().catch(() => {
  quoteText.textContent = "Could not load quotes.json";
  setStatus("Make sure quotes.json is in the same folder as index.html", "bad");
});

function finishRun(tState) {
  tState.completed = true;
  tState.completedAt = Date.now();
  saveState(state);

  track("run_completed", {
    score: tState.correctCount,
    hints_used: tState.hintsUsed
  });

  // UI lock
  submitBtn.disabled = true;
  answerInput.disabled = true;
  hint1Btn.disabled = true;
  hint2Btn.disabled = true;
  progressBadge.hidden = true;

  // Result message (v0.2 copy)
  resultArea.hidden = false;
  resultMsg.innerHTML = `
    <div><b>Here’s how you did today:</b></div>
    <div style="margin-top:6px">Score: ${tState.correctCount} / 5</div>
    <div class="returnHint">
      Tomorrow, today’s answers unlock above — and you’ll get a new set of 5 quotes.
    </div>
  `;

  shareCardEl.textContent = buildShareCard(tState);
  renderYesterdayIfAvailable();
}
