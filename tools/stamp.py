"""Cache-busting: give every script and stylesheet link in index.html a ?v= version so a
browser fetches the new files after each deploy (GitHub Pages lets browsers keep files for
10 minutes, some keep them longer). Run before committing a change to anything index.html loads.
usage: python tools/stamp.py"""
import re, time, pathlib
p = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
s = p.read_text(encoding='utf-8')
v = time.strftime('%Y%m%d%H%M')
s, n1 = re.subn(r'(<script src="(?:js|vendor)/[^"?]+)(\?v=\w+)?"', lambda m: f'{m.group(1)}?v={v}"', s)
s, n2 = re.subn(r'(<link[^>]*href="(?:css|assets)/[^"?]+\.css)(\?v=\w+)?"', lambda m: f'{m.group(1)}?v={v}"', s)
p.write_text(s, encoding='utf-8')
print(f'stamped {n1} scripts and {n2} stylesheets with v={v}')

# The offline manifest (js/offline.js): every file the game loads, with its size and a hash of
# its content, so a browser downloads each file once and again only when it changes.
import hashlib, json
root = p.parent
files = [p]
for d in ('css', 'js', 'assets'):
    files += sorted(f for f in (root / d).rglob('*') if f.is_file())
skip = {root / 'assets' / 'manifest.json'}
out = []
for f in files:
    if f in skip or f.suffix in ('.md', '.py', '.map') or f.name.startswith('.'):
        continue
    b = f.read_bytes()
    out.append({'p': f.relative_to(root).as_posix(), 's': len(b), 'h': hashlib.sha1(b).hexdigest()[:12]})
(root / 'assets' / 'manifest.json').write_text(json.dumps({'v': v, 'files': out}, separators=(',', ':')), encoding='utf-8')
print(f'manifest: {len(out)} files, {sum(f["s"] for f in out) / 1048576:.1f} MB')
