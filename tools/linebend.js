// Moves a circuit's racing line sideways at one spot, in a smooth bump, and stores it in js/lines.js.
// For a line that runs too close to a wall, found with a real lap. Positive moves toward + offset.
// usage: node tools/linebend.js TRACK METRES_ROUND_THE_LAP MOVE_METRES [HALF_WIDTH_METRES]
const fs = require('fs'), path = require('path');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js']);
const [id, at, by, W] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5] || 30];
const Ls = F1.Lines, tr = F1.Tracks.build(F1.Tracks.byId(id)), S = Ls[id], st = Ls.stride, n = S.length;
const a = Math.round(at / tr.ds / st), R = Math.round(W / tr.ds / st);
for (let q = -R; q <= R; q++) { const j = (a + q + n) % n; S[j] = +(S[j] + by * (0.5 + 0.5 * Math.cos(Math.PI * q / R))).toFixed(2); }
const P = path.join(__dirname, '..', 'js', 'lines.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Lines = ')[0];
let s = head + 'G.F1.Lines = { stride: ' + st + ',\n';
for (const k of Object.keys(Ls)) if (k !== 'stride') s += `    ${/^[a-z]\w*$/i.test(k) ? k : JSON.stringify(k)}: [${Array.from(Ls[k]).join(',')}],\n`;
fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
console.log(id, 'moved', by, 'm at', at, 'm');
