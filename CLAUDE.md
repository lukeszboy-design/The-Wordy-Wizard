# The Wordy Wizard

Spelling games for elementary students. Parents enter the week's words by hand or with a CSV, or teachers enter them at the start of the week, and the words feed the games.

## Project facts
- The whole app is one file: `index.html` (HTML, CSS and JavaScript inline). Keep it that way unless Luke asks otherwise.
- Uses three.js r128 from cdnjs for the 3D scene.
- `music.txt` is the background music ("Skipping Song"), stored as base64-encoded MP3 text. Don't edit it by hand. Music plays at 35% in the lair and 10% in games, and dips to 30% of that whenever any voice speaks (`MUSIC.talk`, called by VOICE). iPhones and iPads ignore an audio element's volume, so there the song is routed through Web Audio (set up in the first tap).
- Voices are handled by `VOICE` in index.html, with three sources:
  - The wizard's own lines use "George" (Kokoro, a kindly British gentleman), pre-recorded in `voice.txt` (one MP3 per sentence, keyed `"0.9|sentence"`). After adding or changing a wizard `say(...)` line, re-record with `uv run --python 3.12 --with kokoro-onnx --with soundfile tools/make_voice.py` (needs ffmpeg). On computers, a wizard line that isn't in voice.txt is made by the Kokoro engine in the browser (~90 MB); phones, tablets and Chromebooks never load it.
  - Spelling words in every game (Town Crier included) use MeloTTS (Cloudflare Workers AI), chosen by Luke on 2026-10-06. The service in `classroom-api/` records each word once, when a word list is saved (`POST /voices`, up to 4 words per request), stores it in KV, and every device plays it (`GET /voices/:word`, 204 if not recorded yet). Limits: single short words only (letters, ' and -, up to 30), plus the Town Crier's two phrases; 600 new recordings a day in total and 300 per network address. Grown-ups can tap 🔊 on a word and re-record it said like another spelling ("read" said like "red"); that's kept in `WORDS.say` and travels with a classroom. Clips are named `melo1|<what's said>`. Every voice except the wizard's plays a little slower than recorded (`PACE` = .88 in VOICE: clips are stretched in the browser without changing pitch, and the device-voice fallback gets a lower rate).
  - The device's built-in voice (speechSynthesis) is the backup for any word that isn't recorded yet or ready within ~2.5 s, and for wizard lines when needed. Keep that fallback.
  - The Grown-ups screen tells families their spelling words are sent to the voice server.
- Hosted on GitHub Pages from the `main` branch at https://lukeszboy-design.github.io/The-Wordy-Wizard/ (repo: lukeszboy-design/The-Wordy-Wizard).
- Word lists and progress are saved in the browser with localStorage. Don't break existing saved data when changing its format.
- Classrooms: in Grown-ups a teacher can create a 4-digit classroom code, with an optional class name (e.g. "Room 12"); children tap **Join my class** in the wizard's room (no grown-ups lock, since a code can only fetch words), or families enter it in Grown-ups, to get the teacher's words. Joining shows the class name and first words to confirm, and puts the family's own list aside (`wordy-wizard-words-home`) so Grown-ups can bring it back on leaving. Wrong codes: a 30-second pause after 3 in the app, and 60 per network address per hour in the service. The words refresh whenever the app opens. The lists live in a small Cloudflare Worker with KV storage in `classroom-api/` (publish with `npx wrangler deploy` from that folder). Only the teacher's device holds the key that can change a class's words; the code alone can only read them. The app's `CLASSROOM` module talks to it.

## Design direction
- Opening scene is a real 3D cartoon wizard's castle lair (chosen over 2.5D).
- Players pick games from an open spellbook.
- Current games: Dragon's Hoard, Save the Squire, Potion Mix-Up, Broken Castle Wall, The Town Crier, The Jester's Tricks, The Joust, Forge the Sword, Gem Mine, Shield Match, Stable Sort (grown-ups pick the sort; it travels with a classroom), The Royal Court, Feed the Baby Dragon (grows over the week) and Drawbridge Dash. Crossword is the one placeholder left.
- Each game is a module (`const XGame = (() => { ... return { mount, unmount, practice } })()`) listed in `GAME_MODULES`, with an entry in `GAMES`, an icon in `ICONS` and a place in `SPREADS`. Games start through `launch()`, which waits for the voice before mounting. The game modules and `launch()` sit before the WebGL check (`if (!window.THREE) { fail(); return; }`) so they still work on devices without 3D, where `openFlat()` opens a game straight from the list of spells. Keep game code free of three.js and put new games there too.
- The wizard's room has easter eggs: tap Webster the spider or a potion (`EGGS`).

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
