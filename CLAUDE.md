# The Wordy Wizard

Spelling games for elementary students. Parents enter the week's words by hand or with a CSV, or teachers enter them at the start of the week, and the words feed the games.

## Project facts
- The whole app is one file: `index.html` (HTML, CSS and JavaScript inline). Keep it that way unless Luke asks otherwise.
- Uses three.js r128 from cdnjs for the 3D scene.
- `music.txt` is the background music ("Skipping Song"), stored as base64-encoded MP3 text. Don't edit it by hand.
- Voices are handled by `VOICE` in index.html, using the Kokoro speech engine in the browser (never the device's built-in voices). The wizard's own lines use "George" (a kindly British gentleman). Spelling words in every game (Town Crier included) use the word voice: a 60/40 blend of Emma and George in `word-voice.bin` (rebuild with `uv run --python 3.12 --with kokoro-onnx --with soundfile tools/make_word_voice.py`). It loads through the unused "Lily" voice slot. Clip names are `speed|text` for George and `blend1|speed|text` for the word voice.
  - `voice.txt` holds his pre-recorded lines: one MP3 clip per sentence (JSON, keyed `"0.9|sentence"`, base64). After adding or changing a wizard `say(...)` line, re-record with `uv run --python 3.12 --with kokoro-onnx --with soundfile tools/make_voice.py` (needs ffmpeg). Keep the wizard's lines fixed text where possible; anything not in voice.txt is recorded in the browser instead.
  - Spelling words are recorded in the browser: the Kokoro model (~90 MB, kokoro-js from jsdelivr, model from Hugging Face) runs in a Web Worker, and finished clips are saved in the browser's cache so later visits don't need the model. The browser's own voice is the fallback.
- Hosted on GitHub Pages from the `main` branch at https://lukeszboy-design.github.io/The-Wordy-Wizard/ (repo: lukeszboy-design/The-Wordy-Wizard).
- Word lists and progress are saved in the browser with localStorage. Don't break existing saved data when changing its format.

## Design direction
- Opening scene is a real 3D cartoon wizard's castle lair (chosen over 2.5D).
- Players pick games from an open spellbook.
- Current games include The Jester's Tricks, Save the Squire, Dragon's Hoard, Potion Mix-Up, Broken Castle Wall, The Town Crier and The Joust (spell against the clock).

## Style
- Audience is elementary kids: readable fonts, clear instructions, encouraging feedback.
- Test on a desktop browser and on iPad / Chromebook-sized screens.

## How we work
- Bugs and ideas are tracked as GitHub issues. Use `gh issue list` / `gh issue view N` to read them.
- Fix one issue at a time. End the commit message with `(fixes #N)` so GitHub closes the issue.
- Keep commits small, with a clear message describing what changed for the player.
- After making changes, tell Luke how to test them (open `index.html` in a browser) before committing and pushing.
- When a feature is added or changed, update README.md to match.
- Never commit secrets (API keys, passwords, `.env` files).
