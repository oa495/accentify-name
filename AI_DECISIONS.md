# AI Decisions Log

## 2026-04-01 — Phonetic Transcription Feature

### Goal
Convert audio recordings to a human-readable pronunciation respelling in the format `ah-mah-yeh-lee`, optimized for non-English names.

### Approach Chosen
**Web Speech API → syllable-based respelling engine**

1. `SpeechRecognition` runs in parallel with `MediaRecorder` during recording to produce a text transcript.
2. `syllabify()` breaks each word into CV syllables using consonant-cluster rules.
3. `syllableToRespelling()` maps each syllable to readable phoneme sequences using a digraph table and pure vowel mappings tuned for non-English names: `a`→`ah`, `e`→`eh`, `i`→`ee`, `o`→`oh`, `u`→`oo`.
4. Syllables are joined with `-` to produce output like `ah-mah-yeh-lee`.
5. No CDN or external dependencies — fully self-contained.

### Vowel Strategy
Pure vowel mappings (Spanish/Japanese/Arabic style) were chosen because:
- Non-English names use consistent, unambiguous vowel sounds
- These languages share the same 5-vowel system
- English-style ambiguous vowels (e.g. "a" = ay/ah/uh) would produce incorrect results for foreign names

### Alternatives Considered
- **IPA output**: Harder for non-linguists to read; superseded by human-readable respelling.
- **compromise-phonetics CDN**: Package does not exist on unpkg or jsdelivr (404).
- **Other IPA CDN libraries** (`en-ipa`, `ipa-translator`): Also unavailable on CDN.
- **Claude API / backend proxy**: Best quality, but requires server and API key — overkill for a local tool.

### Tradeoffs
- Web Speech API only works in Chrome/Edge. Fallback message shown for unsupported browsers.
- Requires secure context (HTTPS or localhost) — works fine with `live-server`.
- The Speech API may mishear uncommon foreign names; the respelling reflects whatever text it produces.

### Key Files
- `recorder.js` — `syllabify()`, `syllableToRespelling()`, `wordToRespelling()`, `textToRespelling()`; `SpeechRecognition` parallel to `MediaRecorder`
- `recorder.css` — `.phonetic`, `.phonetic-text`, `.phonetic-unsupported`
