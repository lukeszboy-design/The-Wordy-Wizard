#!/usr/bin/env python3
"""Record the Wordy Wizard's lines into voice.txt.

Finds every line the wizard says in index.html, splits it into sentences, and
records each sentence with the Piper "Alan" voice (pitched down to sound like an
old sea captain). The clips are stored in voice.txt as JSON {sentence: base64 MP3}.

Run again after adding or changing a wizard line:
    uv run --with piper-tts tools/make_voice.py
Needs ffmpeg. The voice model (~60 MB) downloads to ~/.cache/wordy-wizard-voice.
"""
import base64, json, os, re, subprocess, sys, tempfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = 'en_GB-alan-medium'
URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/' + MODEL
CACHE = Path.home() / '.cache' / 'wordy-wizard-voice'
FILTER = 'asetrate={sr}*0.86,aresample={sr},atempo=1.08,vibrato=f=5.5:d=0.12,bass=g=4,acompressor,loudnorm=I=-16'

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

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    model = CACHE / (MODEL + '.onnx')
    for ext in ('.onnx', '.onnx.json'):
        f = CACHE / (MODEL + ext)
        if not f.exists():
            print('Downloading', f.name); urllib.request.urlretrieve(URL + ext, f)
    from piper import PiperVoice
    voice = PiperVoice.load(str(model))
    import wave
    from piper import SynthesisConfig
    cfg = SynthesisConfig(length_scale=1.12)
    lines = wizard_lines((ROOT / 'index.html').read_text())
    clips = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i, line in enumerate(lines):
            raw, mp3 = Path(tmp) / f'{i}.wav', Path(tmp) / f'{i}.mp3'
            with wave.open(str(raw), 'wb') as w: voice.synthesize_wav(line, w, syn_config=cfg)
            sr = voice.config.sample_rate
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-af', FILTER.format(sr=sr),
                            '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', str(mp3)], check=True)
            clips[line] = base64.b64encode(mp3.read_bytes()).decode()
            print(f'{i + 1:2}/{len(lines)}  {line}')
    (ROOT / 'voice.txt').write_text(json.dumps(clips, ensure_ascii=False, indent=0))
    print('Wrote voice.txt:', len(clips), 'clips,', (ROOT / 'voice.txt').stat().st_size // 1024, 'KB')

if __name__ == '__main__':
    main()
