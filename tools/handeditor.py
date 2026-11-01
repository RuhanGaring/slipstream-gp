"""Hand pose editor: serves the game folder and saves the poses the editor makes.

Opens tools/handeditor.html, where every car's steering wheel can be gripped by hand: the glove's
finger joints and the hand itself have Blender-style move and rotate gizmos, and the fingers close
on the handle by themselves until they touch it. Save writes tools/data/handposes.json, which
tools/handbake.py turns into the game's js/assets/handpose.js.

usage: python tools/handeditor.py [PORT]      (default 8765; opens the browser)
"""
import sys, json, functools, http.server, socketserver, pathlib, webbrowser

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'tools' / 'data' / 'handposes.json'
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8765)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def do_GET(self):
        if self.path.split('?')[0] == '/handposes':
            body = DATA.read_bytes() if DATA.exists() else b'{"version": 1, "cars": {}}'
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)
        else:
            super().do_GET()
    def do_POST(self):
        if self.path.split('?')[0] != '/handposes':
            self.send_error(404); return
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        DATA.parent.mkdir(parents=True, exist_ok=True)
        DATA.write_text(json.dumps(data, indent=1))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'saved': str(DATA.relative_to(ROOT)), 'cars': sorted(data.get('cars', {}))}).encode())
        print('saved', DATA.relative_to(ROOT), sorted(data.get('cars', {})), flush=True)

socketserver.ThreadingTCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=str(ROOT)))
url = f'http://127.0.0.1:{PORT}/tools/handeditor.html'
print('hand editor at', url, flush=True)
if '--no-browser' not in sys.argv: webbrowser.open(url)
srv.serve_forever()
