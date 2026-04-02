const recordBtn      = document.getElementById('recordBtn');
const timerEl        = document.getElementById('timer');
const statusEl       = document.getElementById('status');
const recordingsList = document.getElementById('recordings');
const canvas         = document.getElementById('visualizer');
const ctx            = canvas.getContext('2d');

let mediaRecorder = null;
let audioCtx      = null;
let analyser      = null;
let animFrameId   = null;
let timerInterval = null;
let seconds       = 0;
let chunks        = [];
let recCount      = 0;
let stream        = null;
let recognition   = null;
let currentTranscript = '';

// --- Phonetics: syllable-based respelling (e.g. "ah-mah-yeh-lee") ---
// Vowels treated as "pure" (Spanish/Japanese/Arabic style) so non-English
// names render correctly: a=ah, e=eh, i=ee, o=oh, u=oo.

const isV = c => 'aeiou'.includes(c);

// Break a word into CV syllables
function syllabify(w) {
  const syllables = [];
  let syl = '';
  for (let i = 0; i < w.length; i++) {
    syl += w[i];
    if (isV(w[i])) {
      const rest = w.slice(i + 1);
      const nextVIdx = [...rest].findIndex(c => isV(c));
      if (nextVIdx === -1) {
        // No more vowels — absorb remaining consonants into this syllable
        syl += rest;
        break;
      } else if (nextVIdx <= 1) {
        // 0 or 1 consonant before next vowel — break after current vowel
        syllables.push(syl);
        syl = '';
      } else {
        // 2+ consonants — first stays here, rest go with next syllable
        syl += rest[0];
        i++;
        syllables.push(syl);
        syl = '';
      }
    }
  }
  syllables.push(syl);
  return syllables.filter(Boolean);
}

// Convert one syllable's characters to respelling phonemes
function syllableToRespelling(syl) {
  const DIGRAPHS = {
    'tch':'ch', 'sch':'sk',              // 3-char (checked first via slice)
    'sh':'sh',  'ch':'ch', 'th':'th', 'ph':'f',
    'wh':'w',   'ck':'k',  'ng':'ng',  'kn':'n',
    'wr':'r',   'gh':'',
    'ai':'ay',  'ay':'ay', 'ea':'ee',  'ee':'ee',
    'ie':'ee',  'oa':'oh', 'oe':'oh',  'oo':'oo',
    'ou':'ow',  'ow':'oh', 'oi':'oy',  'oy':'oy',
    'au':'aw',  'aw':'aw', 'ew':'yoo', 'ue':'oo',
    'ui':'wee', 'igh':'eye',
  };

  let out = '', i = 0;
  while (i < syl.length) {
    // Try longest match first (3, then 2 chars)
    const m3 = syl.slice(i, i + 3);
    const m2 = syl.slice(i, i + 2);
    if (m3 in DIGRAPHS) { out += DIGRAPHS[m3]; i += 3; continue; }
    if (m2 in DIGRAPHS) { out += DIGRAPHS[m2]; i += 2; continue; }

    const c = syl[i];
    const next = syl[i + 1];
    switch (c) {
      case 'a': out += 'ah'; break;
      case 'e': out += 'eh'; break;
      case 'i': out += 'ee'; break;
      case 'o': out += 'oh'; break;
      case 'u': out += 'oo'; break;
      case 'y': out += (i === 0) ? 'y' : 'ee'; break;
      case 'j': out += 'y';  break; // handles Spanish j → y sound
      case 'c': out += (next && 'ei'.includes(next)) ? 's' : 'k'; break;
      case 'g': out += (next && 'ei'.includes(next)) ? 'j' : 'g'; break;
      case 'q': out += 'k';  break;
      case 'x': out += 'ks'; break;
      default:  out += c;
    }
    i++;
  }
  return out;
}

function wordToRespelling(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  return syllabify(w).map(syllableToRespelling).filter(Boolean).join('-');
}

function textToRespelling(text) {
  if (!text || !text.trim()) return null;
  const result = text.trim().split(/\s+/).filter(Boolean).map(wordToRespelling).join('  ');
  return result || null;
}

// --- Speech Recognition ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function startRecognition() {
  if (!SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  let finalAccum = '';

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalAccum += t + ' ';
      else interim += t;
    }
    currentTranscript = (finalAccum + interim).trim();
  };

  recognition.onerror = () => {};
  currentTranscript = '';
  finalAccum = '';
  recognition.start();
}

function stopRecognition() {
  if (recognition) { recognition.stop(); recognition = null; }
}

// --- Visualizer ---
function drawIdle() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#12121a';
  ctx.fillRect(0, 0, w, h);
  const mid = h / 2;
  ctx.beginPath();
  ctx.strokeStyle = '#252535';
  ctx.lineWidth = 1.5;
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

function drawLive() {
  animFrameId = requestAnimationFrame(drawLive);
  const w = canvas.width, h = canvas.height;
  const bufLen = analyser.frequencyBinCount;
  const data   = new Uint8Array(bufLen);
  analyser.getByteTimeDomainData(data);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#12121a';
  ctx.fillRect(0, 0, w, h);

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e84040';
  ctx.beginPath();

  const sliceW = w / bufLen;
  let x = 0;
  for (let i = 0; i < bufLen; i++) {
    const v = data[i] / 128.0;
    const y = (v * h) / 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    x += sliceW;
  }
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

function resizeCanvas() {
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  if (!mediaRecorder || mediaRecorder.state !== 'recording') drawIdle();
}

// --- Timer ---
function startTimer() {
  seconds = 0;
  timerEl.textContent = '0:00';
  timerInterval = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// --- Main record toggle ---
recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    statusEl.textContent = 'Microphone access denied.';
    return;
  }

  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(analyser);

  chunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start();

  startRecognition();
  recordBtn.classList.add('recording');
  statusEl.textContent = 'Recording...';
  startTimer();
  drawLive();
}

function stopRecording() {
  if (!mediaRecorder) return;
  stopRecognition();
  mediaRecorder.stop();
  stream.getTracks().forEach(t => t.stop());
  audioCtx.close();
  cancelAnimationFrame(animFrameId);
  stopTimer();
  recordBtn.classList.remove('recording');
  statusEl.textContent = 'Saving...';
  drawIdle();
}

function saveRecording() {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const url  = URL.createObjectURL(blob);
  recCount++;

  const now   = new Date();
  const label = `#${recCount} · ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  const duration = seconds;
  const m = Math.floor(duration / 60), s = String(duration % 60).padStart(2, '0');

  const capturedTranscript = currentTranscript;
  const respelling = textToRespelling(capturedTranscript);

  const item = document.createElement('div');
  item.className = 'recording-item';

  const lbl = document.createElement('span');
  lbl.className = 'rec-label';
  lbl.textContent = label;

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;

  const dlBtn = document.createElement('button');
  dlBtn.className = 'dl-btn';
  dlBtn.textContent = 'Save';
  dlBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${recCount}.webm`;
    a.click();
  });

  item.appendChild(lbl);
  item.appendChild(audio);
  item.appendChild(dlBtn);

  const phoneticEl = document.createElement('div');
  phoneticEl.className = 'phonetic';
  if (respelling) {
    phoneticEl.innerHTML = `<span class="phonetic-text">${respelling}</span>`;
  } else if (!SpeechRecognition) {
    phoneticEl.className += ' phonetic-unsupported';
    phoneticEl.textContent = 'Phonetic transcription requires Chrome or Edge.';
  } else {
    phoneticEl.className += ' phonetic-unsupported';
    phoneticEl.textContent = 'No speech detected.';
  }
  item.appendChild(phoneticEl);

  recordingsList.prepend(item);

  statusEl.textContent = `Saved recording ${recCount} (${m}:${s})`;
}

// Init
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
drawIdle();
