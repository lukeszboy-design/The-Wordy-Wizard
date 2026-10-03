# The Wordy Wizard

Spelling games for elementary students. Parents enter the week's words by hand or with a CSV, or teachers enter them at the start of the week, and the words feed the games.

## Project facts
- The whole app is one file: `index.html` (HTML, CSS and JavaScript inline). Keep it that way unless Luke asks otherwise.
- Uses three.js r128 from cdnjs for the 3D scene.
- `music.txt` is the background music, stored as base64-encoded MP3 text. Don't edit it by hand.
- Hosted on GitHub Pages from the `main` branch at https://lukeszboy-design.github.io/The-Wordy-Wizard/ (repo: lukeszboy-design/The-Wordy-Wizard).
- Word lists and progress are saved in the browser with localStorage. Don't break existing saved data when changing its format.

## Design direction
- Opening scene is a real 3D cartoon wizard's castle lair (chosen over 2.5D).
- Players pick games from an open spellbook.
- Current games include The Jester's Tricks, Save the Squire, Dragon's Hoard, Potion Mix-Up and Broken Castle Wall.

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
