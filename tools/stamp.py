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
