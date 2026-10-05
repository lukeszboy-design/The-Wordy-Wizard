#!/usr/bin/env python3
"""Record the Wordy Wizard's lines into voice.txt.

Finds every line the wizard says in index.html, splits it into sentences, and
records each sentence with the Kokoro "George" voice (a kindly British gentleman),
the same voice the game uses in the browser for spelling words. The clips are
stored in voice.txt as JSON {"0.9|sentence": base64 MP3}; 0.9 is his speaking
speed and must match speedFor(.85) in index.html.

Run again after adding or changing a wizard line:
    uv run --python 3.12 --with kokoro-onnx --with soundfile tools/make_voice.py
Needs ffmpeg. The full-quality model (~350 MB) downloads to ~/.cache/wordy-wizard-voice.
A sentence that isn't recorded still works: the game records it in the browser.
"""
import base64, json, re, subprocess, tempfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'
CACHE = Path.home() / '.cache' / 'wordy-wizard-voice'
VOICE, SPEED = 'bm_george', 0.9
BITRATE = '48k'   # a touch below full quality keeps voice.txt small; speech still sounds clean
# fixed phrases the games say in the word voice (the Emma + George blend in word-voice.bin), recorded here too so
# they play at once; keys must match keyFor() in index.html: 'blend1|' + speed + '|' + text, at speed .82
WORD_LINES, WORD_SPEED = ['Hear ye, hear ye! The word is:', 'Huzzah!'], 0.82

def sentences(text):
    return [p.strip() for p in re.split(r'(?<=[.!?])\s+', text) if p.strip()]

def wizard_lines(html):
    js_str = r'"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\''
    def strs(src): return [a or b for a, b in re.findall(js_str, src)]
    lines = []
    games = html[html.index('const GAMES = {'):html.index('const SPREADS')]
    lines += [m for m in re.findall(r'name:\s*(?:"([^"]+)"|\'([^\']+)\')', games) for m in m if m]
    lines = [n + '!' for n in lines]
    lines += [a or b for a, b in re.findall(r'say:\s*(?:' + js_str + ')', games)]
    for arr in ('QUIPS', 'CASTS'):
        block = re.search(r'const ' + arr + r' = \[(.*?)\];', html, re.S).group(1)
        lines += strs(block)
    # the wizard's own say(...) calls (not the games' say functions, which take a word)
    for call in re.findall(r'(?<![\w.])say\((.*?)\);', html):
        lines += strs(call)
    out = []
    for l in lines:
        for s in sentences(l.replace("\\'", "'").replace('\\"', '"')):
            if '${' not in s and s not in out: out.append(s)
    return out

def trim(x, rate):
    """Same as the browser: drop silence, keeping a breath before and a soft tail after."""
    import numpy as np
    loud = np.flatnonzero(np.abs(x) >= .01)
    if not len(loud): return x
    return x[max(0, loud[0] - round(rate * .04)):loud[-1] + round(rate * .1)]

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
        if not (CACHE / name).exists():
            print('Downloading', name); urllib.request.urlretrieve(URL + name, CACHE / name)
    import soundfile as sf
    from kokoro_onnx import Kokoro
    tts = Kokoro(str(CACHE / 'kokoro-v1.0.onnx'), str(CACHE / 'voices-v1.0.bin'))
    lines = wizard_lines((ROOT / 'index.html').read_text())
    clips = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i, line in enumerate(lines):
            raw, mp3 = Path(tmp) / f'{i}.wav', Path(tmp) / f'{i}.mp3'
            pcm, sr = tts.create(line, voice=VOICE, speed=SPEED, lang='en-gb')
            sf.write(raw, trim(pcm, sr), sr)
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', BITRATE, str(mp3)], check=True)
            clips[f'{SPEED}|{line}'] = base64.b64encode(mp3.read_bytes()).decode()
            print(f'{i + 1:2}/{len(lines)}  {line}')
        import numpy as np
        blend = np.fromfile(ROOT / 'word-voice.bin', dtype=np.float32).reshape(-1, 1, 256)
        for i, line in enumerate(WORD_LINES):
            raw, mp3 = Path(tmp) / f'w{i}.wav', Path(tmp) / f'w{i}.mp3'
            pcm, sr = tts.create(line, voice=blend, speed=WORD_SPEED, lang='en-gb')
            sf.write(raw, trim(pcm, sr), sr)
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', BITRATE, str(mp3)], check=True)
            clips[f'blend1|{WORD_SPEED}|{line}'] = base64.b64encode(mp3.read_bytes()).decode()
            print(f'word voice  {line}')
    (ROOT / 'voice.txt').write_text(json.dumps(clips, ensure_ascii=False, indent=0))
    print('Wrote voice.txt:', len(clips), 'clips,', (ROOT / 'voice.txt').stat().st_size // 1024, 'KB')

if __name__ == '__main__':
    main()
