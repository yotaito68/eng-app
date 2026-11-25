'use strict';
/* 瞬間英作文 — personal practice app (PWA). All data stays in this browser. */

// ---------- constants ----------
const STORE_KEY = 'ie_state_v1';
const SCENES = ['日常','食事','買い物','旅行','仕事','会議','雑談','気持ち','健康・病院','電話・メール'];
const WORDSET = new Set(WORDS2000);
const PLACEMENT_N = 12;
const DAY = 86400000;
const REVIEW_INTERVALS = [1, 3, 7, 14, 30]; // days
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-flash-latest'];
const LEVEL_DESC = {
  1:'3〜5語のごく短い文（挨拶・現在形）', 2:'5〜7語の基本文（現在・過去）', 3:'依頼・許可・疑問文（can, could, may）',
  4:'未来・比較・頻度など7〜9語', 5:'現在完了・if・because を含む8〜11語', 6:'句動詞・受動態・9〜12語',
  7:'関係詞・should have・仮定法過去完了など10〜14語', 8:'ニュアンスのある会話・ビジネス表現 12〜16語',
  9:'慣用表現・婉曲表現 13〜18語', 10:'抽象的・高度な語彙を含む複雑な文'
};

// ---------- state ----------
function defaultState() {
  return {
    v: 1,
    settings: { apiKey: '', model: '', modelPinned: false, speed: 'fast', models: [], reviewStreak: 2, scenes: [], autoSpeak: true, inputMode: 'voice' },
    rating: null, ratingHist: [], placement: null,
    active: {},          // lemma -> {t: firstTs, n: count}
    items: {},           // id -> {n, t, s, st, due, rev}
    generated: [],       // AI-generated sentences
    history: [],         // {t,id,s,wpm,rt,lv}
    qCount: 0
  };
}
let S = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const d = JSON.parse(raw), base = defaultState();
    return Object.assign(base, d, { settings: Object.assign(base.settings, d.settings || {}) });
  } catch (e) { return defaultState(); }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch (e) { toast('保存に失敗しました（容量不足の可能性）'); }
}

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function allSentences() { return SENTENCES.concat(S.generated); }
function findSentence(id) { return allSentences().find(x => x.id === id); }
function scoreClass(s) { return s >= 80 ? 'good' : s >= 60 ? 'mid' : 'bad'; }
function countWords(t) { return (String(t).match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length; }
function activeCount() { return Object.keys(S.active).filter(w => WORDSET.has(w)).length; }
function levelLabel(r) { return r == null ? '—' : 'Lv ' + r.toFixed(1); }

// ---------- adaptive level ----------
// Expected performance (0..1) on a sentence of level L for a learner rated R.
// At R = L the learner is expected to score about 80; the level settles where
// the "slightly harder" questions you get are answered at roughly 70-75 points.
function pSuccess(R, L) { return 1 / (1 + Math.exp(-1.1 * (R - L) - 1.1)); }
// Convert a 0-100 score (plus speaking speed) into a 0..1 performance value
function perfValue(score, wpm) {
  let s = clamp((score - 40) / 50, 0, 1);
  if (wpm && s > 0.5) s *= 0.88 + 0.12 * clamp(wpm / 110, 0, 1); // slow speech counts slightly less
  return s;
}
function updateRating(L, score, wpm, K) {
  const R = S.rating ?? 4.5;
  const next = clamp(R + K * (perfValue(score, wpm) - pSuccess(R, L)), 1, 10);
  S.rating = Math.round(next * 100) / 100;
  S.ratingHist.push([Date.now(), S.rating]);
  if (S.ratingHist.length > 500) S.ratingHist.shift();
  return next - R;
}

// ---------- question selection ----------
function sceneOk(x) { return !S.settings.scenes.length || S.settings.scenes.includes(x.sc); }
function dueReviews() {
  const now = Date.now();
  return allSentences().filter(x => { const it = S.items[x.id]; return it && it.rev && it.due <= now; })
    .sort((a, b) => S.items[a.id].due - S.items[b.id].due);
}
function newWordCount(x) { return (x.w || []).filter(w => WORDSET.has(w) && !S.active[w]).length; }
function recentIds(n) { return new Set(S.history.slice(-n).map(h => h.id)); }

function pickPlacement() {
  const R = S.placement.r, lv = clamp(Math.round(R), 1, 10);
  const used = new Set(S.placement.used);
  let pool = SENTENCES.filter(x => x.lv === lv && !used.has(x.id));
  if (!pool.length) pool = SENTENCES.filter(x => Math.abs(x.lv - lv) <= 1 && !used.has(x.id));
  return pool[Math.floor(Math.random() * pool.length)];
}

// returns {s: sentence, review: bool} or null if AI generation is needed
function pickNext(excludeId) {
  const due = dueReviews().filter(x => x.id !== excludeId);
  if (due.length && (S.qCount % 2 === 0 || due.length > 8)) return { s: due[0], review: true };
  const target = (S.rating ?? 4.5) + 0.4;
  const recent = recentIds(25);
  const cands = allSentences().filter(x => sceneOk(x) && x.id !== excludeId && !recent.has(x.id) && Math.abs(x.lv - target) <= 1.6);
  const unseen = cands.filter(x => !S.items[x.id]);
  if (unseen.length) {
    let best = null, bv = -1e9;
    for (const x of unseen) {
      const v = -Math.abs(x.lv - target) * 2 + 0.35 * Math.min(newWordCount(x), 5) + Math.random() * 0.9;
      if (v > bv) { bv = v; best = x; }
    }
    return { s: best, review: false };
  }
  return null; // run out → generate new sentences
}
function pickFallback(excludeId) {
  const target = (S.rating ?? 4.5) + 0.4;
  const c = allSentences().filter(x => sceneOk(x) && x.id !== excludeId && Math.abs(x.lv - target) <= 1.6)
    .sort((a, b) => (S.items[a.id]?.t || 0) - (S.items[b.id]?.t || 0));
  return c[0] || SENTENCES[0];
}

// ---------- recording (PCM → WAV) ----------
const Rec = {
  stream: null, ctx: null, node: null, src: null, chunks: [], rate: 44100, on: false, t0: 0,
  async ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.stream || !this.stream.active) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    }
  },
  async start() {
    await this.ensure();
    this.rate = this.ctx.sampleRate; this.chunks = [];
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = e => { if (this.on) this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    this.src.connect(this.node); this.node.connect(this.ctx.destination);
    this.on = true; this.t0 = performance.now();
  },
  stop() {
    this.on = false;
    try { this.src.disconnect(); this.node.disconnect(); } catch (e) {}
    const len = this.chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(len);
    let o = 0; for (const c of this.chunks) { all.set(c, o); o += c.length; }
    const pcm = downsample(all, this.rate, 16000);
    return { wav: encodeWav(pcm, 16000), voiced: voicedSeconds(pcm, 16000), total: pcm.length / 16000 };
  },
  release() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  }
};
function downsample(buf, from, to) {
  if (from === to) return buf;
  const ratio = from / to, n = Math.floor(buf.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(buf.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += buf[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}
// Length of speech between the first and last frame above an adaptive loudness threshold
function voicedSeconds(pcm, rate) {
  const f = Math.floor(rate * 0.02), rms = [];
  for (let i = 0; i + f <= pcm.length; i += f) {
    let s = 0; for (let j = i; j < i + f; j++) s += pcm[j] * pcm[j];
    rms.push(Math.sqrt(s / f));
  }
  if (!rms.length) return 0;
  const sorted = rms.slice().sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.1)], peak = sorted[sorted.length - 1];
  const thr = Math.max(0.008, floor * 3, peak * 0.08);
  let a = rms.findIndex(v => v > thr), b = rms.length - 1 - rms.slice().reverse().findIndex(v => v > thr);
  if (a < 0) return 0;
  return (b - a + 1) * 0.02;
}
function encodeWav(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, clamp(pcm[i], -1, 1) * 0x7fff, true);
  return new Uint8Array(buf);
}
function b64(bytes) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

// ---------- text to speech ----------
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 0.95;
  const v = speechSynthesis.getVoices().find(v => v.lang === 'en-US' && /Samantha|Ava|Allison|Google US/i.test(v.name))
    || speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('en-US'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// ---------- Gemini ----------
const API = 'https://generativelanguage.googleapis.com/v1beta';
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function listModels(key) {
  const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!r.ok) throw new ApiError(await errText(r), r.status);
  const d = await r.json();
  const names = (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /flash/.test(n) && !/(image|tts|live|audio|embed|thinking|exp|translate|transcribe|omni|computer|robotics)/.test(n));
  return [...new Set(names)];
}
async function errText(r) {
  try { const j = await r.json(); return j.error?.message || r.statusText; } catch (e) { return r.statusText; }
}
// Model order. "fast" (default) puts the lightweight Flash-Lite models first: they answer in 1-3 s.
function modelOrder() {
  const st = S.settings, fast = st.speed !== 'quality';
  const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : (/latest/.test(n) ? 3 : 0); };
  const rank = n => (/lite/.test(n) === fast ? 100 : 0) + ver(n) * 10 - (/preview/.test(n) ? 4 : 0) - (/-\d{2,}$/.test(n) ? 1 : 0) - (/latest/.test(n) ? 0.5 : 0);
  const all = [...new Set([...(st.models || []), ...FALLBACK_MODELS])].sort((a, b) => rank(b) - rank(a));
  // interleave: best preferred model, then best of the other family as a backup, then the rest
  const pref = all.filter(n => /lite/.test(n) === fast), other = all.filter(n => /lite/.test(n) !== fast);
  const base = [];
  for (let i = 0; i < Math.max(pref.length, other.length); i++) { if (pref[i]) base.push(pref[i]); if (other[i]) base.push(other[i]); }
  return [...new Set([st.modelPinned ? st.model : null, ...base].filter(Boolean))];
}
let curCtl = null; // lets the "やめる" button abort the request in flight
function cancelRequest() { if (curCtl) { curCtl.userCancel = true; curCtl.abort(); } }
async function gemini(parts, schema, opt = {}) {
  const key = S.settings.apiKey, fast = S.settings.speed !== 'quality';
  if (!key) throw new ApiError('APIキーが未設定です。設定タブで入力してください。', 0);
  const timeout = opt.timeout || (fast ? 10000 : 25000);
  let lastErr;
  for (const model of modelOrder().slice(0, 3)) {
    const g3 = !/gemini-[12]\./.test(model);
    // minimal thinking = fastest answer; retry without the setting if a model rejects it
    for (const withThinking of [true, false]) {
      const gc = { responseMimeType: 'application/json', responseSchema: schema };
      if (!g3 && opt.temperature != null) gc.temperature = opt.temperature;
      if (withThinking) gc.thinkingConfig = g3 ? { thinkingLevel: fast ? 'minimal' : 'low' } : { thinkingBudget: 0 };
      const ctl = new AbortController(); curCtl = ctl;
      const timer = setTimeout(() => ctl.abort(), timeout);
      let r;
      try {
        r = await fetch(`${API}/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: ctl.signal,
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: gc })
        });
      } catch (e) {
        clearTimeout(timer);
        if (ctl.userCancel) throw new ApiError('中止しました', -1);
        if (e.name === 'AbortError') { lastErr = new ApiError('AIの応答に時間がかかりすぎました。', 408); break; } // try next model
        throw new ApiError('通信できませんでした。電波の状態を確認してください。', 0);
      }
      let d;
      try { d = r.ok ? await r.json() : null; } catch (e) {
        clearTimeout(timer);
        if (ctl.userCancel) throw new ApiError('中止しました', -1);
        lastErr = new ApiError('AIの応答に時間がかかりすぎました。', 408); break;
      }
      clearTimeout(timer);
      if (r.ok) {
        const text = (d.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
        if (!text) { lastErr = new ApiError('AIから空の応答が返りました。もう一度試してください。', 200); break; }
        if (!S.settings.modelPinned && S.settings.model !== model) { S.settings.model = model; save(); }
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      }
      const msg = await errText(r);
      lastErr = new ApiError(msg, r.status);
      if (r.status === 400 && withThinking && /think/i.test(msg)) continue;
      if (r.status === 400 && /API key/i.test(msg)) throw new ApiError('APIキーが正しくないようです。設定を確認してください。', 400);
      if (r.status === 401 || r.status === 403) throw new ApiError('APIキーが使えません（' + msg + '）', r.status);
      break; // 404/429/5xx → try next model
    }
  }
  if (lastErr?.status === 429) throw new ApiError('今日の無料枠の上限に達したようです。少し時間をおくか、明日（日本時間の夕方以降）に再開してください。', 429);
  throw lastErr || new ApiError('AIの呼び出しに失敗しました', 0);
}

const GRADE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    score: { type: 'INTEGER' },
    corrected: { type: 'STRING' },
    natural: { type: 'STRING' },
    feedback_ja: { type: 'ARRAY', items: { type: 'STRING' } },
    errors: { type: 'ARRAY', items: { type: 'OBJECT', properties: { wrong: { type: 'STRING' }, right: { type: 'STRING' }, why_ja: { type: 'STRING' } }, required: ['wrong', 'right', 'why_ja'] } },
    correct_lemmas: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['transcript', 'score', 'corrected', 'natural', 'feedback_ja', 'errors', 'correct_lemmas']
};
function gradePrompt(s, typed) {
  return `You are an English speaking coach for a Japanese learner doing "瞬間英作文" (instant translation practice).
Japanese prompt: ${s.ja}
Reference translation (one of many acceptable answers): ${s.en}
The learner's answer is ${typed ? `this typed text: """${typed}"""` : 'in the attached audio recording.'}

Be brief — speed matters. Reply in JSON:
1. transcript: ${typed ? 'copy the learner\'s text as is.' : 'transcribe exactly what the learner said in English, verbatim, keeping their mistakes. Do NOT correct anything. If the audio is silent or unintelligible, return an empty string.'}
2. score (0-100): how accurately and naturally the answer expresses the meaning of the Japanese prompt. There are many correct answers — do not penalize wording that differs from the reference if it is natural and accurate. Ignore capitalization and punctuation${typed ? '' : ', and ignore pronunciation unless a word is unintelligible'}.
   95-100: natural and accurate. 80-94: correct meaning, minor awkwardness. 60-79: understandable but with grammar mistakes or missing nuance. 30-59: major errors or part of the meaning missing. 0-29: wrong or no answer.
3. corrected: the learner's answer with the minimum changes needed to be correct and natural (same as transcript if already fine; reference translation if the answer is empty).
4. natural: the most natural thing a native speaker would say in this situation.
5. feedback_ja: at most 2 very short points in polite Japanese (です・ます, under 40 characters each). What to fix and why, or what was good.
6. errors: up to 3 mistakes as {wrong, right, why_ja (under 30 Japanese characters)}. Empty array if none.
7. correct_lemmas: lowercase dictionary forms (e.g. went→go, children→child) of the English words the learner used correctly in their answer. Exclude words used incorrectly.`;
}
const norm = t => String(t).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
async function grade(s, wav, typed) {
  // exact match with the model answer → instant result, no AI call
  if (typed && norm(typed) === norm(s.en)) {
    return { transcript: typed, score: 100, corrected: s.en, natural: s.en, feedback_ja: ['模範解答どおりです。完璧です！'], errors: [], correct_lemmas: (s.w || []).slice() };
  }
  const parts = [{ text: gradePrompt(s, typed) }];
  if (!typed) parts.push({ inlineData: { mimeType: 'audio/wav', data: b64(wav) } });
  const r = await gemini(parts, GRADE_SCHEMA, { temperature: 0.2 });
  r.score = clamp(Math.round(Number(r.score) || 0), 0, 100);
  return r;
}

const GEN_SCHEMA = { type: 'ARRAY', items: { type: 'OBJECT', properties: {
  ja: { type: 'STRING' }, en: { type: 'STRING' }, sc: { type: 'STRING' }, w: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['ja', 'en', 'sc', 'w'] } };
async function generateSentences(level, n = 10) {
  const scenes = S.settings.scenes.length ? S.settings.scenes : SCENES;
  const unused = WORDS2000.slice(80).filter(w => !S.active[w]);
  const sample = []; for (let i = 0; i < 20 && unused.length; i++) sample.push(unused.splice(Math.floor(Math.random() * Math.min(unused.length, 900)), 1)[0]);
  const examples = allSentences().filter(x => x.lv === level).slice(0, 4).map(x => `- ${x.ja} → ${x.en}`).join('\n');
  const avoid = allSentences().filter(x => Math.abs(x.lv - level) <= 1).map(x => x.en).slice(-60).join(' | ');
  const prompt = `Create ${n} new practice items for a Japanese learner doing "瞬間英作文" (translate Japanese into spoken English instantly).
Difficulty: level ${level} on a 1-10 scale. Level ${level} means: ${LEVEL_DESC[level]}.
Examples at this level:
${examples}
Rules:
- ja: natural everyday Japanese a person would actually say. en: the most natural spoken English for it (one sentence, or two short ones).
- sc: one of these scenes: ${scenes.join(', ')}. Spread the items across the scenes.
- Where it fits naturally, use some of these words the learner has not used yet: ${sample.join(', ')}.
- w: lowercase dictionary forms of all English words in en.
- Do not repeat these existing sentences: ${avoid}`;
  const arr = await gemini([{ text: prompt }], GEN_SCHEMA, { temperature: 0.9, timeout: 40000 });
  const ts = Date.now().toString(36);
  const out = (Array.isArray(arr) ? arr : []).filter(x => x && x.ja && x.en).map((x, i) => ({
    id: `g${ts}${i}`, lv: level, sc: SCENES.includes(x.sc) ? x.sc : scenes[i % scenes.length], ja: x.ja, en: x.en,
    w: [...new Set((x.w || []).map(w => String(w).toLowerCase()))].filter(w => WORDSET.has(w)), gen: true
  }));
  S.generated.push(...out); save();
  return out;
}

// ---------- recording results into state ----------
function recordResult(s, res, wpm, rt, mode) {
  const now = Date.now();
  const it = S.items[s.id] || { n: 0, st: 0, rev: false, due: 0 };
  it.n++; it.t = now; it.s = res.score;
  if (res.score < 70) { it.rev = true; it.st = 0; it.due = now + DAY; }
  else if (it.rev) {
    if (res.score >= 80) {
      it.st++;
      if (it.st >= S.settings.reviewStreak) { it.rev = false; it.due = 0; }
      else it.due = now + REVIEW_INTERVALS[Math.min(it.st, REVIEW_INTERVALS.length - 1)] * DAY;
    } else it.due = now + DAY;
  }
  S.items[s.id] = it;
  const fresh = [];
  for (const raw of res.correct_lemmas || []) {
    const w = String(raw).toLowerCase().trim();
    if (!/^[a-z][a-z'-]*$/.test(w)) continue;
    if (!S.active[w]) { S.active[w] = { t: now, n: 0 }; if (WORDSET.has(w)) fresh.push(w); }
    S.active[w].n++;
  }
  S.history.push({ t: now, id: s.id, s: res.score, wpm: wpm || null, rt: rt || null, lv: s.lv, m: mode });
  if (S.history.length > 3000) S.history.splice(0, S.history.length - 3000);
  return fresh;
}

// ---------- views ----------
let tab = 'practice';
let P = null; // current practice context
function setTab(t) {
  if (Rec.on) return toast('録音中です');
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (t !== 'practice') Rec.release();
  render();
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
function render() {
  window.scrollTo(0, 0);
  if (!S.settings.apiKey) return renderSetup();
  ({ practice: renderPractice, stats: renderStats, vocab: renderVocab, settings: renderSettings })[tab]();
}

// --- first-run setup
function renderSetup() {
  $('#view').innerHTML = `
  <h1>はじめに</h1>
  <div class="card">
    <p>採点にはGoogleのGemini APIを使います（無料枠）。キーはこのiPhoneの中にだけ保存されます。</p>
    <ol class="steps sub">
      <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> をGoogleアカウントで開く</li>
      <li>「Create API key（APIキーを作成）」を押す</li>
      <li>表示されたキー（AQ. または AIza から始まる文字列）をコピーして下に貼り付け</li>
    </ol>
    <label>Gemini APIキー</label>
    <input id="key" type="password" autocomplete="off" placeholder="AQ.... / AIza...">
    <p></p>
    <button class="primary full" id="go">保存して始める</button>
    <p id="msg" class="sub"></p>
  </div>`;
  if (tab !== 'settings') document.querySelectorAll('#tabs button').forEach(b => b.disabled = true);
  $('#go').onclick = async () => {
    const key = $('#key').value.trim();
    if (!key) return;
    $('#msg').innerHTML = '<span class="spin"></span> 確認中…';
    try {
      const models = await listModels(key);
      S.settings.apiKey = key; S.settings.models = models; S.settings.model = ''; S.settings.modelPinned = false;
      save();
      document.querySelectorAll('#tabs button').forEach(b => b.disabled = false);
      toast('設定しました');
      tab = 'practice'; render();
    } catch (e) { $('#msg').textContent = 'キーを確認できませんでした：' + e.message; }
  };
}

// --- practice
function renderPractice() {
  if (S.rating == null && !S.placement) return renderPlacementIntro();
  if (!P || P.done) return nextQuestion();
  drawQuestion();
}
function renderPlacementIntro() {
  P = null;
  $('#view').innerHTML = `
  <h1>レベル測定</h1>
  <div class="card">
    <p>最初に${PLACEMENT_N}問だけ解いて、今の実力に合ったレベルを決めます。</p>
    <p class="sub">日本語の文を見たら、すぐに英語で話してください。正解の言い方は一つではありません。わからなければ「パス」でOKです。</p>
    <p></p>
    <button class="primary full" id="start">測定を始める</button>
  </div>
  <div class="card">
    <p class="sub">レベルが分かっている場合は、測定せずに始めることもできます。</p>
    <div class="row"><select id="lv">${[1,2,3,4,5,6,7,8,9,10].map(i => `<option value="${i}" ${i===4?'selected':''}>Lv ${i}：${LEVEL_DESC[i]}</option>`).join('')}</select></div>
    <p></p>
    <button class="full" id="skip">このレベルで始める</button>
  </div>`;
  $('#start').onclick = () => { S.placement = { i: 0, r: 4.0, used: [] }; save(); P = null; nextQuestion(); };
  $('#skip').onclick = () => { S.rating = Number($('#lv').value); S.ratingHist.push([Date.now(), S.rating]); save(); P = null; nextQuestion(); };
}

async function nextQuestion(excludeId) {
  if (S.placement) {
    const s = pickPlacement();
    P = { s, review: false, placement: true, shown: Date.now(), state: 'ask' };
    return drawQuestion();
  }
  let pick = pickNext(excludeId);
  if (!pick) {
    $('#view').innerHTML = `<div class="card center"><p><span class="spin"></span></p><p>あなたのレベルに合った新しい例文をAIが作っています…</p></div>`;
    try {
      const lv = clamp(Math.round((S.rating ?? 4.5) + 0.4), 1, 10);
      await generateSentences(lv, 10);
      pick = pickNext(excludeId);
    } catch (e) { toast('例文の生成に失敗：' + e.message, 4000); }
    if (!pick) pick = { s: pickFallback(excludeId), review: false };
  }
  P = { s: pick.s, review: pick.review, placement: false, shown: Date.now(), state: 'ask' };
  drawQuestion();
}

function drawQuestion() {
  const { s } = P, mode = S.settings.inputMode;
  const head = P.placement
    ? `<span class="chip">レベル測定 ${S.placement.i + 1}/${PLACEMENT_N}</span>`
    : `<span class="chip">Lv ${s.lv}</span> <span class="chip gray">${esc(s.sc)}</span> ${P.review ? '<span class="chip rev">復習</span>' : ''}`;
  $('#view').innerHTML = `
  <div class="row">${head}<span class="spacer"></span><span class="sub">${P.placement ? '' : levelLabel(S.rating)}</span></div>
  <div class="card">
    <div class="ja">${esc(s.ja)}</div>
    <div id="ans"></div>
  </div>
  <div id="res"></div>`;
  drawAnswerArea(mode);
}
function drawAnswerArea(mode) {
  const box = $('#ans');
  if (P.state === 'busy') {
    box.innerHTML = `<div class="center" style="padding:20px"><span class="spin"></span><p class="sub">採点中… <span class="timer" id="bt">0.0秒</span></p><button class="ghost" id="cancel">やめる</button></div>`;
    const t0 = Date.now();
    clearInterval(drawAnswerArea._t);
    drawAnswerArea._t = setInterval(() => { const e = $('#bt'); if (!e || P.state !== 'busy') return clearInterval(drawAnswerArea._t); e.textContent = ((Date.now() - t0) / 1000).toFixed(1) + '秒'; }, 100);
    $('#cancel').onclick = cancelRequest;
    return;
  }
  if (P.state === 'done') { box.innerHTML = ''; return; }
  if (mode === 'voice') {
    box.innerHTML = `
      <button class="mic" id="mic" aria-label="録音">●</button>
      <p class="center sub" id="hint">タップして話す → もう一度タップで終了</p>
      <div class="row"><button class="ghost" id="sw">⌨ キーボードで答える</button><span class="spacer"></span><button class="ghost" id="pass">パス</button></div>`;
    $('#mic').onclick = toggleRec;
    $('#sw').onclick = () => { S.settings.inputMode = 'text'; save(); drawAnswerArea('text'); };
  } else {
    box.innerHTML = `
      <textarea id="txt" placeholder="英語で入力（キーボードのマイクで音声入力もできます）" autocapitalize="sentences" autocorrect="off" spellcheck="false"></textarea>
      <p></p>
      <div class="row"><button class="primary" id="send">答える</button><button class="ghost" id="sw">🎙 声で答える</button><span class="spacer"></span><button class="ghost" id="pass">パス</button></div>`;
    $('#txt').addEventListener('input', () => { if (!P.typeStart) P.typeStart = Date.now(); }, { once: true });
    $('#send').onclick = () => { const t = $('#txt').value.trim(); if (t) submit(null, t); };
    $('#sw').onclick = () => { S.settings.inputMode = 'voice'; save(); drawAnswerArea('voice'); };
  }
  $('#pass').onclick = () => passQuestion();
}
let recTimer = null;
async function toggleRec() {
  const mic = $('#mic');
  if (!Rec.on) {
    try {
      await Rec.start();
    } catch (e) {
      toast('マイクを使えません。iPhoneの設定でマイクを許可するか、キーボードで答えてください。', 4500);
      return;
    }
    P.recStart = Date.now();
    mic.classList.add('rec'); mic.textContent = '■';
    $('#hint').innerHTML = '<span class="timer" id="tm">0.0秒</span>　話し終えたらタップ';
    recTimer = setInterval(() => {
      const sec = (performance.now() - Rec.t0) / 1000;
      const tm = $('#tm'); if (tm) tm.textContent = sec.toFixed(1) + '秒';
      if (sec > 30) toggleRec();
    }, 100);
  } else {
    clearInterval(recTimer);
    const out = Rec.stop();
    if (out.total < 0.4) { toast('短すぎました。もう一度どうぞ'); drawAnswerArea('voice'); return; }
    submit(out, null);
  }
}
function showResend(msg) {
  const box = $('#ans'), d = document.createElement('div');
  d.className = 'card'; d.style.margin = '12px 0 0';
  d.innerHTML = `<p class="bad" style="margin-top:0">${esc(msg)}</p><button class="primary full" id="resend">回答を再送信する</button>`;
  box.appendChild(d);
  $('#resend').onclick = () => { const p = P.pending; if (p) submit(p.audio, p.typed); };
}
function passQuestion() {
  submit(null, null, true);
}
async function submit(audio, typed, passed) {
  const s = P.s;
  P.state = 'busy'; drawAnswerArea();
  let res;
  if (passed) {
    res = { transcript: '', score: 0, corrected: s.en, natural: s.en, feedback_ja: ['パスしました。模範解答を声に出して何度か言ってみましょう。'], errors: [], correct_lemmas: [] };
  } else {
    try { res = await grade(s, audio && audio.wav, typed); }
    catch (e) {
      // keep the answer so it can be resent (e.g. no signal in a tunnel)
      P.state = 'ask'; P.pending = { audio, typed };
      drawAnswerArea(typed ? 'text' : S.settings.inputMode);
      if (typed && $('#txt')) $('#txt').value = typed;
      showResend(e.message);
      return;
    }
    P.pending = null;
  }
  // speed: words per minute of actual speech; reaction = time until you started answering
  let wpm = null, rt = null;
  if (audio && res.transcript) {
    const n = countWords(res.transcript);
    if (n >= 2 && audio.voiced >= 0.6) wpm = Math.min(300, Math.round(n / (audio.voiced / 60)));
    rt = P.recStart ? (P.recStart - P.shown) / 1000 : null;
  } else if (typed && P.typeStart) rt = (P.typeStart - P.shown) / 1000;

  let delta = 0, fresh = [];
  const first = !P.retry;
  if (first) {
    fresh = recordResult(s, res, wpm, rt, passed ? 'pass' : typed ? 'text' : 'voice');
    if (P.placement) {
      const pl = S.placement; pl.used.push(s.id);
      const K = 1.5 * Math.pow(0.86, pl.i);
      const R0 = pl.r;
      pl.r = clamp(R0 + K * (perfValue(res.score, wpm) - pSuccess(R0, s.lv)), 1, 10);
      pl.i++;
    } else {
      delta = updateRating(s.lv, res.score, wpm, P.review ? 0.2 : 0.35);
      S.qCount++;
    }
  } else {
    // retry of the same sentence: count words, don't move the level
    for (const raw of res.correct_lemmas || []) { const w = String(raw).toLowerCase(); if (!S.active[w]) { S.active[w] = { t: Date.now(), n: 1 }; if (WORDSET.has(w)) fresh.push(w); } }
    if (res.score >= 80 && S.items[s.id]) { S.items[s.id].due = Date.now() + DAY; }
  }
  save();
  P.state = 'done'; P.res = res; P.wpm = wpm; P.rt = rt; P.delta = delta; P.fresh = fresh;
  drawAnswerArea();
  drawResult();
  if (S.settings.autoSpeak && res.score < 95) setTimeout(() => speak(res.natural || s.en), 300);
}

function drawResult() {
  const { s, res, wpm, rt, delta, fresh } = P;
  const placementFinished = P.placement && S.placement.i >= PLACEMENT_N;
  const sameAsCorrected = (res.corrected || '').trim().toLowerCase() === (res.transcript || '').trim().toLowerCase();
  const items = [];
  items.push(`<div class="row"><div class="score ${scoreClass(res.score)}">${res.score}</div><div class="sub">/100</div><span class="spacer"></span>
    <div style="text-align:right" class="sub">${wpm ? `話す速さ <b>${wpm}</b> 語/分<br>` : ''}${rt != null ? `反応 ${rt.toFixed(1)}秒` : ''}${!P.placement && delta ? `<br>レベル ${delta > 0 ? '+' : ''}${delta.toFixed(2)}` : ''}</div></div>`);
  items.push(`<div class="lbl">あなたの回答</div><div class="en">${res.transcript ? esc(res.transcript) : '<span class="sub">（なし）</span>'}</div>`);
  if (res.transcript && !sameAsCorrected) items.push(`<div class="lbl">直すなら</div><div class="say"><div class="en good">${esc(res.corrected)}</div><button class="spk" data-say="${esc(res.corrected)}">▶</button></div>`);
  if (res.feedback_ja?.length) items.push(`<ul class="fb">${res.feedback_ja.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`);
  if (res.errors?.length) items.push(res.errors.map(e => `<div class="err"><s>${esc(e.wrong)}</s> → <b>${esc(e.right)}</b><br><span class="sub">${esc(e.why_ja)}</span></div>`).join(''));
  items.push(`<div class="lbl">ネイティブならこう言う</div><div class="say"><div class="en">${esc(res.natural)}</div><button class="spk" data-say="${esc(res.natural)}">▶</button></div>`);
  if ((res.natural || '').trim() !== s.en.trim()) items.push(`<div class="lbl">模範解答</div><div class="say"><div class="en">${esc(s.en)}</div><button class="spk" data-say="${esc(s.en)}">▶</button></div>`);
  if (fresh?.length) items.push(`<div class="lbl">新しく使えた単語 +${fresh.length}</div><div class="words">${fresh.map(w => `<span class="new">${esc(w)}</span>`).join('')}</div>`);
  const btns = placementFinished
    ? `<button class="primary full" id="fin">結果を見る</button>`
    : `<div class="row"><button class="primary" style="flex:2" id="next">次へ</button><button style="flex:1" id="retry">もう一度</button></div>`;
  $('#res').innerHTML = `<div class="card">${items.join('')}</div>${btns}`;
  document.querySelectorAll('[data-say]').forEach(b => b.onclick = () => speak(b.dataset.say));
  if (placementFinished) $('#fin').onclick = finishPlacement;
  else {
    $('#next').onclick = () => { speechSynthesis?.cancel(); nextQuestion(s.id); };
    $('#retry').onclick = () => { speechSynthesis?.cancel(); P = { s, review: P.review, placement: false, retry: true, shown: Date.now(), state: 'ask' }; drawQuestion(); };
  }
  $('#res').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function finishPlacement() {
  const r = Math.round(S.placement.r * 10) / 10;
  S.rating = r; S.ratingHist.push([Date.now(), r]); S.placement = null; save();
  $('#view').innerHTML = `
  <h1>測定結果</h1>
  <div class="card center">
    <div class="sub">あなたのレベル</div>
    <div class="score" style="margin:8px 0">Lv ${r.toFixed(1)}</div>
    <p class="sub">${LEVEL_DESC[clamp(Math.round(r), 1, 10)]}</p>
  </div>
  <div class="card"><p>ここからは、今のレベルより<b>少しだけ難しい</b>文が出ます。答えるたびにレベルが自動で上下します。間違えた文は日をおいて復習に出てきます。</p></div>
  <button class="primary full" id="go">練習を始める</button>`;
  P = null;
  $('#go').onclick = () => nextQuestion();
}

// --- stats
function renderStats() {
  const h = S.history, now = Date.now();
  const today = h.filter(x => new Date(x.t).toDateString() === new Date().toDateString());
  const spoken = h.filter(x => x.wpm).slice(-20);
  const avgWpm = spoken.length ? Math.round(spoken.reduce((a, x) => a + x.wpm, 0) / spoken.length) : null;
  const last20 = h.filter(x => x.m !== 'pass').slice(-20);
  const avgScore = last20.length ? Math.round(last20.reduce((a, x) => a + x.s, 0) / last20.length) : null;
  const ac = activeCount();
  const due = dueReviews().length, inRev = Object.values(S.items).filter(x => x.rev).length;
  const days = new Set(h.map(x => new Date(x.t).toDateString()));
  let streak = 0; for (let d = new Date(); days.has(d.toDateString()); d = new Date(d - DAY)) streak++;
  $('#view').innerHTML = `
  <h1>記録</h1>
  <div class="card">
    <div class="sub">現在のレベル</div><div class="big">${levelLabel(S.rating)}</div>
    <div class="sub">${S.rating ? LEVEL_DESC[clamp(Math.round(S.rating), 1, 10)] : ''}</div>
    ${spark(S.ratingHist.map(x => x[1]))}
  </div>
  <div class="card">
    <div class="sub">使える単語（よく使う2,000語のうち）</div>
    <div class="big">${ac} <span class="sub">/ 2,000</span></div>
    <div class="bar"><i style="width:${(ac / 20).toFixed(1)}%"></i></div>
  </div>
  <div class="stat">
    <div class="card"><div class="sub">話す速さ（直近平均）</div><div class="big">${avgWpm ?? '—'}</div><div class="sub">語/分　目標 150</div></div>
    <div class="card"><div class="sub">平均スコア（直近20問）</div><div class="big">${avgScore ?? '—'}</div></div>
    <div class="card"><div class="sub">今日の回答数</div><div class="big">${today.length}</div><div class="sub">連続 ${streak}日</div></div>
    <div class="card"><div class="sub">復習</div><div class="big">${due}</div><div class="sub">今日やる分／全${inRev}問</div></div>
  </div>
  <div class="card"><div class="sub">累計 ${h.length}問・AIが作った例文 ${S.generated.length}文</div></div>`;
}
function spark(vals) {
  if (vals.length < 2) return '<p class="sub">練習するとレベルの推移がここに表示されます。</p>';
  const v = vals.slice(-120), mn = Math.max(1, Math.min(...v) - 0.5), mx = Math.min(10, Math.max(...v) + 0.5);
  const pts = v.map((y, i) => `${(i / (v.length - 1) * 300).toFixed(1)},${(75 - (y - mn) / (mx - mn || 1) * 70).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 80" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`;
}

// --- vocab
let vocabTab = 'used';
function renderVocab() {
  const used = Object.entries(S.active).filter(([w]) => WORDSET.has(w)).sort((a, b) => b[1].t - a[1].t);
  const notYet = WORDS2000.filter(w => !S.active[w]);
  const weekAgo = Date.now() - 7 * DAY;
  const list = vocabTab === 'used'
    ? (used.length ? used.map(([w, d]) => `<span class="${d.t > weekAgo ? 'new' : ''}">${esc(w)}</span>`).join('') : '<p class="sub">まだありません。練習で正しく使えた単語がここに増えていきます。</p>')
    : notYet.slice(0, 600).map(w => `<span>${esc(w)}</span>`).join('') + (notYet.length > 600 ? `<p class="sub">…ほか ${notYet.length - 600}語</p>` : '');
  $('#view').innerHTML = `
  <h1>単語</h1>
  <div class="seg"><button data-v="used" class="${vocabTab === 'used' ? 'on' : ''}">使えた ${used.length}</button><button data-v="not" class="${vocabTab === 'not' ? 'on' : ''}">まだ ${notYet.length}</button></div>
  <p class="sub">${vocabTab === 'used' ? '緑は直近1週間で新しく使えた単語です。' : 'よく使われる順に並んでいます。これらを含む文が優先して出題されます。'}</p>
  <div class="words">${list}</div>`;
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { vocabTab = b.dataset.v; renderVocab(); });
}

// --- settings
function renderSettings() {
  const st = S.settings;
  const models = [...new Set([st.model, ...(st.models || []), ...FALLBACK_MODELS].filter(Boolean))];
  $('#view').innerHTML = `
  <h1>設定</h1>
  <div class="card">
    <label>Gemini APIキー</label>
    <input id="key" type="password" value="${esc(st.apiKey)}" autocomplete="off">
    <label>採点の速さ</label>
    <div class="seg" id="speed"><button data-s="fast" class="${st.speed !== 'quality' ? 'on' : ''}">速さ優先</button><button data-s="quality" class="${st.speed === 'quality' ? 'on' : ''}">丁寧さ優先</button></div>
    <p class="sub">速さ優先：軽量モデルで素早く採点。丁寧さ優先：高性能モデルでじっくり採点（時間がかかります）。</p>
    <label>AIモデル</label>
    <div class="row"><select id="model"><option value="">自動（おすすめ）${!st.modelPinned && st.model ? '：' + esc(st.model) : ''}</option>${models.map(m => `<option value="${esc(m)}" ${st.modelPinned && m === st.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select><button id="refresh" title="一覧を更新">↻</button></div>
    <p class="sub">反応しないときや上限に達したときは、自動で別のモデルに切り替えます。</p>
    <button class="full" id="test">接続テスト</button><p id="tmsg" class="sub"></p>
  </div>
  <div class="card">
    <label>出題する場面（未選択ならすべて）</label>
    <div class="check">${SCENES.map(sc => `<label><input type="checkbox" value="${sc}" ${st.scenes.includes(sc) ? 'checked' : ''}>${sc}</label>`).join('')}</div>
    <label>復習から外すまでの連続正解数</label>
    <select id="streak">${[1,2,3,4,5].map(i => `<option ${i === st.reviewStreak ? 'selected' : ''}>${i}</option>`).join('')}</select>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="auto" style="width:auto" ${st.autoSpeak ? 'checked' : ''}>採点後にお手本を自動で読み上げる</label>
  </div>
  <div class="card">
    <label>バックアップ</label>
    <p class="sub">学習記録はこの端末の中にだけあります。機種変更の前などに書き出しておいてください。</p>
    <div class="row"><button id="exp" style="flex:1">書き出す</button><button id="imp" style="flex:1">読み込む</button></div>
    <input type="file" id="file" accept="application/json,.json" hidden>
  </div>
  <div class="card">
    <button class="full" id="replace">レベル測定をやり直す</button>
    <p></p>
    <button class="danger full" id="reset">すべての記録を消す</button>
  </div>
  <p class="sub center">データはこの端末内（とGoogleのAI）以外には送られません。</p>`;
  $('#key').onchange = e => { st.apiKey = e.target.value.trim(); save(); };
  $('#model').onchange = e => { st.model = e.target.value; st.modelPinned = !!e.target.value; save(); };
  document.querySelectorAll('#speed button').forEach(bt => bt.onclick = () => { st.speed = bt.dataset.s; if (!st.modelPinned) st.model = ''; save(); renderSettings(); });
  $('#refresh').onclick = async () => {
    try { st.models = await listModels(st.apiKey); if (st.modelPinned && !st.models.includes(st.model)) { st.model = ''; st.modelPinned = false; } save(); renderSettings(); toast('モデル一覧を更新しました'); }
    catch (e) { toast(e.message, 4000); }
  };
  $('#test').onclick = async () => {
    $('#tmsg').innerHTML = '<span class="spin"></span>';
    const t0 = performance.now();
    try {
      const r = await gemini([{ text: 'Reply with JSON {"ok": true}' }], { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] });
      $('#tmsg').textContent = r.ok ? `OK（${st.model}・${((performance.now() - t0) / 1000).toFixed(1)}秒）` : '応答が想定外でした';
    } catch (e) { $('#tmsg').textContent = e.message; }
  };
  document.querySelectorAll('.check input').forEach(c => c.onchange = () => {
    st.scenes = [...document.querySelectorAll('.check input:checked')].map(x => x.value); save();
  });
  $('#streak').onchange = e => { st.reviewStreak = Number(e.target.value); save(); };
  $('#auto').onchange = e => { st.autoSpeak = e.target.checked; save(); };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eng-app-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#imp').onclick = () => $('#file').click();
  $('#file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || d.v !== 1 || !d.items) throw new Error('形式が違います');
      if (!confirm('今の記録をバックアップの内容で置き換えます。よろしいですか？')) return;
      const key = S.settings.apiKey;
      S = Object.assign(defaultState(), d); if (!S.settings.apiKey) S.settings.apiKey = key;
      save(); P = null; toast('読み込みました'); renderSettings();
    } catch (err) { toast('読み込めませんでした：' + err.message, 4000); }
  };
  $('#replace').onclick = () => { if (confirm('レベル測定をやり直しますか？（単語や履歴は残ります）')) { S.rating = null; S.placement = null; save(); P = null; setTab('practice'); } };
  $('#reset').onclick = () => {
    if (!confirm('レベル・単語・履歴をすべて消します。元に戻せません。よろしいですか？')) return;
    const st2 = S.settings; S = defaultState(); S.settings = st2; save(); P = null; toast('消去しました'); setTab('practice');
  };
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if ('speechSynthesis' in window) speechSynthesis.getVoices();
render();
