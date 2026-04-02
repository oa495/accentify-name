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

/**
 * Splits a lowercase word into CV syllables.
 * Uses a simple consonant-cluster rule: one consonant before the next
 * vowel goes with the next syllable; two or more consonants split so the
 * first stays with the current syllable.
 *
 * @param {string} w - Lowercase alphabetic word to syllabify.
 * @returns {string[]} Array of syllable strings, e.g. ['a', 'ma', 'ye', 'li'].
 *
 * @example
 * syllabify('amayeli'); // ['a', 'ma', 'ye', 'li']
 */
function syllabify(w) {
  const syllables = [];
  let syl = '';
  for (let i = 0; i < w.length; i++) {
    syl += w[i];
    if (isV(w[i])) {
      const rest = w.slice(i + 1); // characters after the current vowel
      const nextVIdx = [...rest].findIndex(c => isV(c)); // distance to the next vowel
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
        i++; // skip the consonant we just consumed
        syllables.push(syl);
        syl = '';
      }
    }
  }
  syllables.push(syl);
  return syllables.filter(Boolean);
}

/**
 * Converts a single syllable string to its human-readable phoneme respelling.
 * Processes multi-character digraphs first (longest match), then maps
 * individual vowels to pure-vowel equivalents and consonants to their
 * spoken equivalents.
 *
 * @param {string} syl - A single syllable (lowercase, alphabetic).
 * @returns {string} Respelling string, e.g. 'mah', 'yeh', 'lee'.
 *
 * @example
 * syllableToRespelling('ma'); // 'mah'
 * syllableToRespelling('ye'); // 'yeh'
 * syllableToRespelling('shi'); // 'shee'
 */
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
    const m3 = syl.slice(i, i + 3); // candidate 3-char digraph
    const m2 = syl.slice(i, i + 2); // candidate 2-char digraph
    // Try longest match first to avoid splitting multi-char patterns
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
      case 'y': out += (i === 0) ? 'y' : 'ee'; break; // consonant at start, vowel elsewhere
      case 'j': out += 'y';  break; // handles Spanish j → y sound
      case 'c': out += (next && 'ei'.includes(next)) ? 's' : 'k'; break; // soft c before e/i
      case 'g': out += (next && 'ei'.includes(next)) ? 'j' : 'g'; break; // soft g before e/i
      case 'q': out += 'k';  break;
      case 'x': out += 'ks'; break; // x always expands to two sounds
      default:  out += c;
    }
    i++;
  }
  return out;
}

/**
 * Converts a single word to a hyphen-separated pronunciation respelling.
 *
 * @param {string} word - The word to convert (any case, may contain non-alpha chars).
 * @returns {string} Hyphenated respelling, e.g. 'ah-mah-yeh-lee', or empty string if input is empty.
 *
 * @example
 * wordToRespelling('Amayeli'); // 'ah-mah-yeh-lee'
 * wordToRespelling('Yuki');    // 'yoo-kee'
 */
function wordToRespelling(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, ''); // strip non-alpha and normalise case
  if (!w) return '';
  return syllabify(w).map(syllableToRespelling).filter(Boolean).join('-');
}

/**
 * Converts a text transcript to a full pronunciation respelling.
 * Multiple words are separated by two spaces for readability.
 *
 * @param {string} text - The transcript text to convert.
 * @returns {string|null} Respelling string (e.g. 'ah-mah-yeh-lee'), or null if input is empty.
 *
 * @example
 * textToRespelling('Amayeli');       // 'ah-mah-yeh-lee'
 * textToRespelling('Maria Jose');    // 'mah-ree-ah  yoh-seh'
 * textToRespelling('');              // null
 */
function textToRespelling(text) {
  if (!text || !text.trim()) return null;
  const result = text.trim().split(/\s+/).filter(Boolean).map(wordToRespelling).join('  ');
  return result || null;
}

// --- Speech Recognition ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Starts a SpeechRecognition session that accumulates the spoken transcript
 * into the module-level `currentTranscript` variable.
 * Does nothing if the browser does not support SpeechRecognition.
 *
 * @returns {void}
 */
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
      if (e.results[i].isFinal) finalAccum += t + ' '; // append confirmed results permanently
      else interim += t; // interim results may still change
    }
    currentTranscript = (finalAccum + interim).trim(); // combine stable + in-progress text
  };

  recognition.onerror = () => {};
  currentTranscript = '';
  finalAccum = '';
  recognition.start();
}

/**
 * Stops the active SpeechRecognition session, if one is running.
 *
 * @returns {void}
 */
function stopRecognition() {
  if (recognition) { recognition.stop(); recognition = null; }
}

// --- Visualizer ---

/**
 * Draws the idle (flat line) state on the visualizer canvas.
 *
 * @returns {void}
 */
function drawIdle() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#12121a';
  ctx.fillRect(0, 0, w, h);
  const mid = h / 2; // vertical centre for the flat line
  ctx.beginPath();
  ctx.strokeStyle = '#252535';
  ctx.lineWidth = 1.5;
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

/**
 * Draws one frame of the live waveform on the visualizer canvas using
 * time-domain data from the Web Audio analyser node, then schedules itself
 * via requestAnimationFrame for the next frame.
 *
 * @returns {void}
 */
function drawLive() {
  animFrameId = requestAnimationFrame(drawLive);
  const w = canvas.width, h = canvas.height;
  const bufLen = analyser.frequencyBinCount; // number of samples in the time-domain buffer
  const data   = new Uint8Array(bufLen);
  analyser.getByteTimeDomainData(data); // fill data with waveform amplitude values (0–255)

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#12121a';
  ctx.fillRect(0, 0, w, h);

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#e84040';
  ctx.beginPath();

  const sliceW = w / bufLen; // horizontal pixels per sample
  let x = 0;
  for (let i = 0; i < bufLen; i++) {
    const v = data[i] / 128.0; // normalise 0–255 to 0–2 range
    const y = (v * h) / 2;     // scale to canvas height, centred at mid
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    x += sliceW;
  }
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

/**
 * Resizes the visualizer canvas to match its CSS layout size and redraws
 * the idle state if not currently recording.
 *
 * @returns {void}
 */
function resizeCanvas() {
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  if (!mediaRecorder || mediaRecorder.state !== 'recording') drawIdle();
}

// --- Timer ---

/**
 * Resets and starts the recording timer, updating the timer display every second.
 *
 * @returns {void}
 */
function startTimer() {
  seconds = 0;
  timerEl.textContent = '0:00';
  timerInterval = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);          // whole minutes elapsed
    const s = String(seconds % 60).padStart(2, '0'); // remaining seconds, zero-padded
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

/**
 * Stops the recording timer.
 *
 * @returns {void}
 */
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

/**
 * Requests microphone access, sets up the Web Audio analyser for the
 * visualizer, initialises MediaRecorder, and starts recording, speech
 * recognition, the timer, and the live waveform animation.
 *
 * @async
 * @returns {Promise<void>}
 */
async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    statusEl.textContent = 'Microphone access denied.';
    return;
  }

  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048; // FFT size determines frequency resolution of the analyser
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(analyser); // route mic input through the analyser (no output — avoids feedback)

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

/**
 * Stops an active recording session: halts speech recognition, MediaRecorder,
 * microphone tracks, Web Audio context, animation frame, and timer.
 *
 * @returns {void}
 */
function stopRecording() {
  if (!mediaRecorder) return;
  stopRecognition();
  mediaRecorder.stop();
  stream.getTracks().forEach(t => t.stop()); // release the microphone
  audioCtx.close();
  cancelAnimationFrame(animFrameId);
  stopTimer();
  recordBtn.classList.remove('recording');
  statusEl.textContent = 'Saving...';
  drawIdle();
}

/**
 * Finalises a recording after MediaRecorder stops: creates a Blob URL,
 * generates the phonetic respelling from the captured transcript, and
 * prepends a new recording item (label, audio player, download button,
 * phonetic display) to the recordings list.
 *
 * @returns {void}
 */
function saveRecording() {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const url  = URL.createObjectURL(blob); // create an in-memory URL for the recorded audio
  recCount++;

  const now   = new Date();
  const label = `#${recCount} · ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  const duration = seconds;
  const m = Math.floor(duration / 60), s = String(duration % 60).padStart(2, '0'); // format mm:ss

  const capturedTranscript = currentTranscript; // snapshot before any next recording overwrites it
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

  recordingsList.prepend(item); // newest recording appears at the top
  statusEl.textContent = `Saved recording ${recCount} (${m}:${s})`;
}

// Init
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
drawIdle();
