#!/usr/bin/env python3
"""Make word-voice.bin, the voice that reads spelling words in every game.

It's a blend of two Kokoro voices: 60% Emma and 40% George, a warm British voice that is clear
for single words. The game loads it into the speech engine in the browser (see VOICE in index.html).

    uv run --python 3.12 --with kokoro-onnx --with soundfile tools/make_word_voice.py

To try a different mix, change BLEND, run this, and bump the 'blend1|' clip-name prefix in index.html
so saved clips of the old voice aren't reused.
"""
from pathlib import Path
import urllib.request
import numpy as np
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path.home() / '.cache' / 'wordy-wizard-voice'
URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'
BLEND = {'bf_emma': .6, 'bm_george': .4}

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
        if not (CACHE / name).exists():
            print('Downloading', name); urllib.request.urlretrieve(URL + name, CACHE / name)
    k = Kokoro(str(CACHE / 'kokoro-v1.0.onnx'), str(CACHE / 'voices-v1.0.bin'))
    style = sum(k.get_voice_style(v) * w for v, w in BLEND.items()).astype(np.float32)
    style.ravel().tofile(ROOT / 'word-voice.bin')
    print('Wrote word-voice.bin:', style.size * 4, 'bytes')

if __name__ == '__main__':
    main()
