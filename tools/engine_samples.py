"""Recorded engine sounds from BeamNG F1 car mods (the 2023 F1 pack's ZIPs), for js/audio.js.

Each mod's art/sound/blends/*.sfxBlend2D.json lists its engine recordings: two rows (off load,
on load), each recording made at one steady RPM. The cars share four sets, one per power unit
(Ferrari, Renault, Mercedes, Honda), plus one Ferrari variant (Alfa Romeo: one recording mapped
to another RPM). This finds the steadiest 3 s of every recording, turns it into a seamless loop,
and writes it twice over as a small mono MP3, so the encoder's padding at the start never falls
inside the loop (js/engine-sounds.js gives the loop points and the sets). The MP3s go into a script,
js/assets/engine_audio.js, loaded when the recorded engines are chosen: a page opened from a file
(file://) may not fetch files, but it may load scripts.

usage: python tools/engine_samples.py "E:/F1 AUDIO"
needs numpy and ffmpeg on the PATH."""
import sys, os, io, json, re, zipfile, wave, hashlib, subprocess, tempfile, pathlib, base64
from concurrent.futures import ProcessPoolExecutor
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(tempfile.gettempdir()) / 'slip_engine_mp3'
SR = 44100
LOOP = 3.0      # seconds in a loop
FADE = 0.25     # seconds of crossfade at the seam
# which set each car's power unit is (the mods' own names); the game's teams pick one by engine
SETS = {'ferriari': 'ferrari', 'bmw': 'ferrari', 'alfa_romeo': 'ferrari_b', 'alpine': 'renault', 'lotus': 'renault',
        'benz_a': 'mercedes', 'mclaren': 'mercedes', 'williams': 'mercedes', 'red_bull': 'honda', 'tauri': 'honda'}


def blend_of(zf):
    for n in zf.namelist():
        m = n.replace('\\', '/')
        if m.endswith('.sfxBlend2D.json'):
            txt = re.sub(r',\s*([\]}])', r'\1', zf.read(n).decode('utf-8', 'replace'))
            return json.loads(txt)
    return None


def read_wav(b):
    w = wave.open(io.BytesIO(b))
    ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    assert sw == 2 and sr == SR, (sw, sr)
    a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    return a.reshape(-1, ch).mean(1)


def steadiest(a):
    """start of the LOOP + FADE seconds whose sound changes least (level and colour)"""
    fr = int(0.1 * SR)
    nf = len(a) // fr
    bands = np.geomspace(40, 4000, 25)
    feats = []
    for k in range(nf):
        seg = a[k * fr:(k + 1) * fr] * np.hanning(fr)
        sp = np.abs(np.fft.rfft(seg)) ** 2
        f = np.fft.rfftfreq(fr, 1 / SR)
        feats.append([np.log10(sp[(f >= lo) & (f < hi)].sum() + 1e-9) for lo, hi in zip(bands[:-1], bands[1:])])
    feats = np.array(feats)
    w = int((LOOP + FADE + 0.3) / 0.1)
    lo, hi = int(nf * 0.08), max(int(nf * 0.08) + 1, nf - w - int(nf * 0.05))
    if hi <= lo:
        lo, hi = 0, max(1, nf - w)
    best, bk = 1e18, lo
    for k in range(lo, hi):
        x = feats[k:k + w]
        s = ((x - x.mean(0)) ** 2).mean()
        if s < best:
            best, bk = s, k
    return bk * fr


def make_loop(a):
    s0 = steadiest(a)
    n0, x = int(LOOP * SR), int(FADE * SR)
    seg = a[s0:s0 + n0 + x + int(0.25 * SR)]
    # the loop's length, within 0.2 s of LOOP, where the sound past the end best matches its start
    head = seg[:x]
    best, bn = -2, n0
    for n in range(n0 - int(0.1 * SR), n0 + int(0.1 * SR)):
        tail = seg[n:n + x]
        if len(tail) < x:
            break
        c = float(np.dot(head, tail) / (np.linalg.norm(head) * np.linalg.norm(tail) + 1e-9))
        if c > best:
            best, bn = c, n
    out = seg[:bn].copy()
    t = np.linspace(0, 1, x, dtype=np.float32)
    # matched (correlated) ends fade linearly, so the level holds through the seam
    out[:x] = seg[:x] * t + seg[bn:bn + x] * (1 - t)
    return out, best


def job(arg):
    key, b = arg
    a = read_wav(b)
    loop, corr = make_loop(a)
    rms = float(np.sqrt(np.mean(loop ** 2)))
    data = np.concatenate([loop, loop])
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
    tmp.close()
    dst = OUT / (key + '.mp3')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp.name, '-c:a', 'libmp3lame', '-b:a', '128k', str(dst)], check=True)
    os.unlink(tmp.name)
    return key, len(loop) / SR, rms, corr


def main():
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'E:/F1 AUDIO')
    OUT.mkdir(parents=True, exist_ok=True)
    sets, wavs = {}, {}
    for z in sorted(src.glob('*.zip')):
        car = re.sub(r'^d_d_2023_f1_', '', z.stem)
        name = SETS.get(car)
        if not name:
            print('skipped (no set for it):', z.name); continue
        zf = zipfile.ZipFile(z)
        bl = blend_of(zf)
        byname = {n.replace('\\', '/').split('/')[-1]: n for n in zf.namelist() if n.lower().endswith('.wav')}
        rows = []
        for row in bl['samples']:
            r = []
            for path, rpm in row:
                fn = path.replace('\\', '/').split('/')[-1]
                b = zf.read(byname[fn])
                key = re.sub(r'[^a-z0-9]+', '_', fn[:-4].lower()) + '_' + hashlib.sha1(b).hexdigest()[:6]
                wavs.setdefault(key, b)
                r.append([key, rpm])
            rows.append(r)
        if name in sets and sets[name] != rows:
            print('note: %s differs from the %s set it shares' % (car, name))
        sets.setdefault(name, rows)
        print(car, '->', name)
    keys = sorted(wavs)
    info = {}
    done = 0
    with ProcessPoolExecutor() as ex:
        for key, dur, rms, corr in ex.map(job, [(k, wavs[k]) for k in keys]):
            info[key] = {'len': round(dur, 5), 'rms': round(rms, 4)}
            done += 1
            print('\r[%-30s] %3d%%  %d/%d  %s (seam match %.2f)' % ('#' * (30 * done // len(keys)), 100 * done // len(keys), done, len(keys), key, corr), end='', flush=True)
    print()
    # every set to the same loudness: its loudest recording (top RPM, on load) at the same level
    gains = {}
    for name, rows in sets.items():
        top = max(info[k]['rms'] for k, _ in rows[1])
        gains[name] = round(0.25 / top, 3)
    js = ROOT / 'js' / 'engine-sounds.js'
    js.write_text(
        '// Generated by tools/engine_samples.py from the BeamNG 2023 F1 car mods\' engine recordings: one\n'
        '// set per power unit, each recording a steady RPM (rows: off load, on load). Each file holds its\n'
        '// loop twice; play the loop from len / 2 for len seconds. Do not edit by hand.\n'
        '(function (G) {\n  G.F1 = G.F1 || {};\n  G.F1.EngineSounds = ' +
        json.dumps({'script': 'js/assets/engine_audio.js', 'files': info, 'sets': sets, 'gain': gains,
                    'onLoadGain': 1.1, 'offLoadGain': 0.8}, separators=(',', ':')) +
        ';\n})(typeof self !== \'undefined\' ? self : this);\n', encoding='utf-8')
    total = sum((OUT / (k + '.mp3')).stat().st_size for k in keys)
    blob = ',\n'.join('  %s: "%s"' % (json.dumps(k), base64.b64encode((OUT / (k + '.mp3')).read_bytes()).decode()) for k in keys)
    aud = ROOT / 'js' / 'assets' / 'engine_audio.js'
    aud.write_text('// Generated by tools/engine_samples.py: the recorded engines\' loops as base64 MP3 (js/engine-sounds.js).\n'
                   '// Loaded by js/audio.js when the recorded engines are chosen. Do not edit.\n'
                   '(function (G) { G.F1 = G.F1 || {}; G.F1.EngineAudio = {\n' + blob + '\n}; })(typeof self !== \'undefined\' ? self : this);\n',
                   encoding='utf-8')
    print('wrote %d loops (%.1f MB of MP3) into %s and %s' % (len(keys), total / 1e6, aud, js))


if __name__ == '__main__':
    main()
