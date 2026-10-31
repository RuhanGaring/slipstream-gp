// Front end: every screen is keyboard first (arrows / WASD, Enter, Esc) with full
// mouse support. Screens are built on demand from the current game state.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U, Data = F1.Data, Audio = F1.Audio;

  const UI = { cur: null, items: [], focus: 0, root: null, history: [] };
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  const TIPS = [
    'Brake in a straight line, then release the pedal as you turn in. The tyres can only do so much at once.',
    'Follow a car through a fast corner and you lose downforce. Hang back a little, then use the slipstream on the straight.',
    'Within one second of the car ahead at the detection line you can use Overtake mode (SPACE): extra electric deployment, held to higher speeds. Every car switches to low-drag X-mode aero on the straights by itself.',
    'Watch the ERS gauge: blue is deploying, green is harvesting. Lift and brake to recharge; run it flat and the car clips at the end of the straights.',
    'Softs are quick but fade. Hards last, but take longer to come into their window.',
    'Kerbs cost grip and grass costs much more. Gravel will stop you dead.',
    'Four wheels over the white line is a track limits strike. Three strikes earn a warning, the fourth a penalty.',
    'A damaged front wing costs front downforce. Pit for a new nose if the car will not turn.',
    'In Arcade, the racing line turns red where you need to be on the brakes.',
    'Racing line markers: brake at the red bar, turn in at yellow, clip the blue apex, let the car run out to the green track-out point.',
    'Before a long straight, apex late. Giving up a little entry speed for a better exit is worth more down the straight.',
  ];

  // ---------- generic screen plumbing ----------
  // Compact layout for phones (mobile mode, or any small screen): screens scroll instead of
  // being laid out for a monitor, the keyboard hints give way to a bar of real buttons along
  // the bottom (back, and the screen's main action), and a tap on a circuit, team or driver
  // shows it first; SELECT, or a second tap, takes it.
  const compact = () => !!((F1.Game && F1.Game.mobile && F1.Game.mobile()) || innerWidth < 900 || innerHeight < 520);
  function applyCompact() { document.body.classList.toggle('compact', compact()); }
  addEventListener('resize', applyCompact);
  function actionBar(scr) {
    if (!scr.back && !scr.primary && !scr.pickable) return;
    const bar = h('div', 'm-bar');
    if (scr.back) {
      const b = h('button', 'm-btn m-back', '<span class="a">&#8592;</span>BACK');
      b.addEventListener('click', () => { if (UI.cur !== scr) return; Audio.ui.back(); scr.back(); });
      bar.appendChild(b);
    }
    const label = scr.primary ? scr.primary.label : scr.pickable ? 'SELECT' : null;
    if (label) {
      const b = h('button', 'm-btn m-go', label + '<span class="a">&#8594;</span>');
      b.addEventListener('click', () => {
        if (UI.cur !== scr) return;
        Audio.ui.select();
        if (scr.primary) scr.primary.fn(); else { const it = UI.items[UI.focus]; if (it && it.activate) it.activate(); }
      });
      bar.appendChild(b);
    }
    scr.el.appendChild(bar);
  }
  function show(id, build, opts = {}) {
    applyCompact();
    const root = UI.root;
    const old = UI.cur;
    if (old) {
      old.el.classList.remove('on');
      const el = old.el;
      setTimeout(() => el.remove(), 400);
    }
    const scr = build(opts);
    scr.id = id;
    scr.el.id = 'scr-' + id;
    scr.el.classList.add('scr');
    // screens whose items preview on focus (circuits, teams, drivers) pick with SELECT on a phone
    scr.pickable = scr.pickable != null ? scr.pickable : (scr.items || []).some(it => it.onFocus && it.activate);
    actionBar(scr);
    root.appendChild(scr.el);
    UI.cur = scr;
    UI.items = scr.items || [];
    UI.focus = scr.focus || 0;
    requestAnimationFrame(() => requestAnimationFrame(() => scr.el.classList.add('on')));
    UI.items.forEach((it, k) => {
      // (not on a phone: a tap fires a hover first, which would make every first tap a pick)
      it.el.addEventListener('mouseenter', () => { if (UI.cur === scr && UI.focus !== k && !document.body.classList.contains('compact')) { setFocus(k); } });
      it.el.addEventListener('click', ev => {
        if (UI.cur !== scr) return;
        // on a phone the first tap on a previewable item only shows it
        if (document.body.classList.contains('compact') && scr.pickable && it.onFocus && UI.focus !== k && !it.right) { setFocus(k); return; }
        setFocus(k);
        if (it.right && ev.target.classList.contains('ar-l')) { it.left(); return; }
        if (it.right && ev.target.classList.contains('ar-r')) { it.right(); return; }
        if (it.activate) { Audio.ui.select(); it.activate(); } else if (it.right) it.right();
      });
    });
    setFocus(UI.focus, true);
    F1.Game.onScreen(id, scr);
    return scr;
  }

  function hide() {
    if (!UI.cur) return;
    const el = UI.cur.el;
    el.classList.remove('on');
    setTimeout(() => el.remove(), 400);
    UI.cur = null; UI.items = [];
  }

  function setFocus(k, silent) {
    if (!UI.items.length) return;
    k = U.clamp(k, 0, UI.items.length - 1);
    UI.items.forEach((it, i) => it.el.classList.toggle('f', i === k));
    if (UI.focus !== k && !silent) Audio.ui.move();
    UI.focus = k;
    const it = UI.items[k];
    if (it.el.scrollIntoView) it.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: silent ? 'auto' : 'smooth' });
    if (it.onFocus) it.onFocus();
  }

  function key(code) {
    const scr = UI.cur;
    if (!scr) return false;
    if (scr.onKey && scr.onKey(code)) return true;
    const it = UI.items[UI.focus];
    const nav = scr.nav || 'v';
    const cols = scr.cols || 1;
    const up = code === 'ArrowUp' || code === 'KeyW', down = code === 'ArrowDown' || code === 'KeyS';
    const left = code === 'ArrowLeft' || code === 'KeyA', right = code === 'ArrowRight' || code === 'KeyD';
    if (nav === 'v') {
      if (up) { setFocus(UI.focus - 1); return true; }
      if (down) { setFocus(UI.focus + 1); return true; }
      if (left && it && it.left) { it.left(); Audio.ui.tick(); return true; }
      if (right && it && it.right) { it.right(); Audio.ui.tick(); return true; }
    } else if (nav === 'h') {
      if (left) { setFocus(UI.focus - 1); return true; }
      if (right) { setFocus(UI.focus + 1); return true; }
    } else if (nav === 'grid') {
      if (left) { setFocus(UI.focus - 1); return true; }
      if (right) { setFocus(UI.focus + 1); return true; }
      if (up) { setFocus(UI.focus - cols); return true; }
      if (down) { setFocus(UI.focus + cols); return true; }
    }
    if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
      if (it && it.activate) { Audio.ui.select(); it.activate(); return true; }
      if (it && it.right) { it.right(); Audio.ui.tick(); return true; }
    }
    if (code === 'Escape' || code === 'Backspace') {
      if (scr.back) { Audio.ui.back(); scr.back(); return true; }
    }
    return false;
  }

  function foot(parts) {
    const f = h('div', 'foot');
    f.innerHTML = parts.map(p => (p === '|' ? '<span class="sp"></span>' : `<span><span class="key">${p[0]}</span>${p[1]}</span>`)).join('');
    return f;
  }

  // ---------- option row ----------
  function optRow(label, sub, values, get, set, fmt) {
    const el = h('div', 'opt');
    el.innerHTML = `<div class="on">${label}${sub ? `<small>${sub}</small>` : ''}</div><div><div class="val"><span class="ar ar-l">&#9664;</span><span class="v"></span><span class="ar ar-r">&#9654;</span></div><div class="pips"></div></div>`;
    const vEl = el.querySelector('.v'), pips = el.querySelector('.pips');
    pips.innerHTML = values.map(() => '<i></i>').join('');
    const render = () => {
      const v = get();
      const k = values.indexOf(v);
      vEl.textContent = fmt ? fmt(v) : v;
      Array.from(pips.children).forEach((p, i) => p.classList.toggle('on', i === k));
    };
    render();
    const move = d => { const k = values.indexOf(get()); set(values[(k + d + values.length) % values.length]); render(); };
    return { el, left: () => move(-1), right: () => move(1), render };
  }

  // ---------- track map ----------
  function drawTrackMap(cv, tr, opts = {}) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 600, H = cv.clientHeight || 300;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (let i = 0; i < tr.N; i++) { mnx = Math.min(mnx, tr.x[i]); mny = Math.min(mny, tr.y[i]); mxx = Math.max(mxx, tr.x[i]); mxy = Math.max(mxy, tr.y[i]); }
    const pad = opts.pad || 36;
    const k = Math.min((W - pad * 2) / (mxx - mnx), (H - pad * 2) / (mxy - mny));
    const ox = (W - (mxx - mnx) * k) / 2 - mnx * k, oy = (H - (mxy - mny) * k) / 2 - mny * k;
    const S = i => [ox + tr.x[i] * k, oy + tr.y[i] * k];
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = (i0, i1) => { g.beginPath(); for (let i = i0; i <= i1; i++) { const p = S(i % tr.N); i === i0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]); } };
    if (!opts.bare) { path(0, tr.N); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = opts.w ? opts.w + 6 : 14; g.stroke(); }
    const s1 = Math.round(tr.sectors[1] / tr.ds), s2 = Math.round(tr.sectors[2] / tr.ds);
    const secs = [[0, s1, '#ff3b30'], [s1, s2, '#3aa0ff'], [s2, tr.N, '#ffcc1f']];
    for (const [a, b, c] of secs) { path(a, b); g.strokeStyle = opts.mono ? '#f4f6f8' : c; g.lineWidth = opts.w || 7; g.stroke(); }
    // DRS zones
    if (!opts.mono) for (const z of tr.drs) {
      const a = Math.round(z.act / tr.ds), b = Math.round(z.end / tr.ds);
      path(a, b < a ? b + tr.N : b);
      g.strokeStyle = '#2bd66b'; g.lineWidth = 2.5; g.setLineDash([2, 5]); g.stroke(); g.setLineDash([]);
    }
    // start
    const p0 = S(0);
    if (opts.bare) return;
    g.save(); g.translate(p0[0], p0[1]); g.rotate(Math.atan2(tr.ty[0], tr.tx[0]));
    g.fillStyle = '#fff'; g.fillRect(-2, -12, 4, 24); g.restore();
    // corner numbers
    if (opts.corners && tr.apexes) {
      g.font = '700 11px Titillium Web, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      tr.apexes.forEach((a, n) => {
        const i = a.i, side = a.k > 0 ? -1 : 1;
        const x = ox + (tr.x[i] + tr.nx[i] * side * 70) * k, y = oy + (tr.y[i] + tr.ny[i] * side * 70) * k;
        g.fillStyle = 'rgba(255,255,255,.75)';
        g.fillText(n + 1, x, y);
      });
    }
  }

  // ---------- screens ----------
  const S = {};

  S.title = () => {
    const el = h('div');
    el.innerHTML = `<div class="stage"><div class="brand"><span class="w1">SLIPSTREAM</span><span class="w2">GRAND PRIX</span></div><div class="press">${F1.Game.mobile && F1.Game.mobile() ? 'TAP TO START' : 'PRESS ENTER'}</div></div>
      <div class="legal">A fictional championship. All teams, drivers and circuits are original. Car model: "Aston Martin F1 AMR23 2023" by Redgrund, CC BY 4.0, modified. Textures and skies: Poly Haven, ambientCG (CC0). See CREDITS.md.</div>`;
    return { el, items: [], onKey: c => { if (c === 'Enter' || c === 'Space' || c === 'NumpadEnter') { Audio.init(); Audio.ui.select(); F1.Game.menuMusic(); go('main'); return true; } return false; }, click: true };
  };

  S.main = () => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    wrap.innerHTML = `<div class="brand" style="margin-bottom:44px"><span class="w1" style="font-size:64px">SLIPSTREAM</span><span class="w2" style="font-size:18px">GRAND PRIX</span></div>`;
    const menu = h('div', 'menu');
    const entries = [
      ['QUICK RACE', 'Pick a circuit and a team. Lights out in under a minute.', () => { F1.Game.flow = { kind: 'race' }; go('mode'); }],
      ['GRAND PRIX WEEKEND', 'The full event: free practice, Q1, Q2 and Q3 knockout qualifying, then the race from your grid slot.', () => { F1.Game.flow = { kind: 'weekend' }; go('mode'); }],
      ['CHAMPIONSHIP', `${F1.Tracks.DEFS.length} rounds, points for the top ten, one title. Race days or full weekends.`, () => { F1.Game.flow = { kind: 'champ' }; go('mode'); }],
      ['TIME TRIAL', 'Hot laps against your own ghost.', () => { F1.Game.flow = { kind: 'tt' }; go('mode'); }],
      ['SPECTATE', 'Sit back and watch a full race: switch cars, every camera, a free camera and a TV director.', () => { F1.Game.flow = { kind: 'spectate', team: 0, driver: 0 }; go('mode'); }],
      ['SETTINGS', 'Audio, camera, units and HUD.', () => go('settings', { back: 'main' })],
      ['CONTROLS', 'Keyboard and gamepad layout.', () => go('controls', { back: 'main' })],
    ];
    const items = entries.map(([t, s, fn]) => {
      const e = h('div', 'mi', `${t}<small>${s}</small>`);
      menu.appendChild(e);
      return { el: e, activate: fn };
    });
    wrap.appendChild(menu);
    el.appendChild(wrap);
    el.appendChild(foot([['&#8593;&#8595;', 'select'], ['ENTER', 'confirm'], '|', ['M', 'mute']]));
    return { el, items, focus: UI.lastMain || 0, back: () => go('title'), onKey: c => { UI.lastMain = UI.focus; return false; } };
  };

  // ---------- race-weekend chrome ----------
  // The selection screens share a broadcast-style frame: a header strip with the event and a
  // step tracker (where you are in the flow), the page title, and the prompts bar at the foot.
  const KIND = { race: 'QUICK RACE', weekend: 'GRAND PRIX WEEKEND', champ: 'CHAMPIONSHIP', tt: 'TIME TRIAL', spectate: 'SPECTATE' };
  const STEP_NAME = { mode: 'HANDLING', track: 'CIRCUIT', team: 'TEAM', driver: 'DRIVER', setup: 'SETUP' };
  function steps(kind) { return kind === 'champ' ? ['mode', 'team', 'driver', 'setup'] : kind === 'spectate' ? ['mode', 'track', 'setup'] : ['mode', 'track', 'team', 'driver', 'setup']; }
  function header(cur) {
    const flow = F1.Game.flow, list = steps(flow.kind), at = list.indexOf(cur);
    const e = h('div', 'hdr');
    e.innerHTML = `<div class="hdr-ev"><span class="mark"><i></i>SLIPSTREAM GP</span><span class="ev">${KIND[flow.kind] || 'QUICK RACE'}</span>${flow.mode && cur !== 'mode' ? `<span class="ev dim">${flow.mode === 'sim' ? 'SIMULATION' : 'ARCADE'}</span>` : ''}</div>
      <ol class="steps">${list.map((s, k) => `<li class="${k < at ? 'done' : k === at ? 'cur' : ''}"><b>${k + 1}</b>${STEP_NAME[s]}</li>`).join('')}</ol>`;
    return e;
  }
  const tcol = t => (t.base === '#121417' ? t.accent : t.base);
  // a team colour that reads on the carbon panels: very dark liveries use their accent instead
  const lum = hex => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.04 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const tink = t => { const c = tcol(t); return lum(c) < 0.09 ? t.accent : c; };
  const teamVars = (e, t) => { e.style.setProperty('--tc', tcol(t)); e.style.setProperty('--tk', tink(t)); e.style.setProperty('--tc2', t.accent); e.style.setProperty('--tf', lum(tcol(t)) > 0.5 ? t.accent : tcol(t)); }; // --tf: on white

  // flags, drawn (the circuits' home countries)
  const FLAGS = {
    GB: '<svg viewBox="0 0 60 30" preserveAspectRatio="none"><clipPath id="fgb"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath><path d="M0 0v30h60V0z" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/><path d="M0 0l60 30m0-30L0 30" clip-path="url(#fgb)" stroke="#c8102e" stroke-width="4"/><path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#c8102e" stroke-width="6"/></svg>',
    IT: '<svg viewBox="0 0 3 2" preserveAspectRatio="none"><path fill="#009246" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#ce2b37" d="M2 0h1v2H2z"/></svg>',
    MC: '<svg viewBox="0 0 3 2" preserveAspectRatio="none"><path fill="#ce1126" d="M0 0h3v1H0z"/><path fill="#fff" d="M0 1h3v1H0z"/></svg>',
    JP: '<svg viewBox="0 0 3 2" preserveAspectRatio="none"><path fill="#fff" d="M0 0h3v2H0z"/><circle cx="1.5" cy="1" r=".6" fill="#bc002d"/></svg>',
    AE: '<svg viewBox="0 0 12 6" preserveAspectRatio="none"><path fill="#00732f" d="M3 0h9v2H3z"/><path fill="#fff" d="M3 2h9v2H3z"/><path fill="#000" d="M3 4h9v2H3z"/><path fill="#ff0000" d="M0 0h3v6H0z"/></svg>',
    CA: '<svg viewBox="0 0 40 20" preserveAspectRatio="none"><path fill="#d52b1e" d="M0 0h10v20H0zM30 0h10v20H30z"/><path fill="#fff" d="M10 0h20v20H10z"/><path fill="#d52b1e" d="M20 3l1.6 3.2 1.8-.9-.6 4.4 2.6-2.4.5 1.6 2.3-.4-.8 2.6 1.1.6-4.7 3.6.5 1.7-4.1-.6V19h-.4v-2.6l-4.1.6.5-1.7-4.7-3.6 1.1-.6-.8-2.6 2.3.4.5-1.6 2.6 2.4-.6-4.4 1.8.9z"/></svg>',
    ES: '<svg viewBox="0 0 3 2" preserveAspectRatio="none"><path fill="#aa151b" d="M0 0h3v2H0z"/><path fill="#f1bf00" d="M0 .5h3v1H0z"/></svg>',
    BR: '<svg viewBox="0 0 20 14" preserveAspectRatio="none"><path fill="#009c3b" d="M0 0h20v14H0z"/><path fill="#ffdf00" d="M10 1.7L18.3 7 10 12.3 1.7 7z"/><circle cx="10" cy="7" r="3.1" fill="#002776"/><path d="M7 6.3c2-.6 4.3-.4 6 .7" stroke="#fff" stroke-width=".5" fill="none"/></svg>',
    DE: '<svg viewBox="0 0 5 3" preserveAspectRatio="none"><path d="M0 0h5v1H0z"/><path fill="#dd0000" d="M0 1h5v1H0z"/><path fill="#ffce00" d="M0 2h5v1H0z"/></svg>',
    US: `<svg viewBox="0 0 38 20" preserveAspectRatio="none"><path fill="#b22234" d="M0 0h38v20H0z"/><path stroke="#fff" stroke-width="1.54" d="M0 2.3h38M0 5.4h38M0 8.5h38M0 11.5h38M0 14.6h38M0 17.7h38"/><path fill="#3c3b6e" d="M0 0h15.2v10.8H0z"/><g fill="#fff">${[2, 5, 8, 11].map(y => [2, 5, 8, 11, 13.5].map(x => `<circle cx="${x + (y % 2 ? 0 : 1.2) - 0.5}" cy="${y * 0.82 + 0.8}" r=".6"/>`).join('')).join('')}</g></svg>`,
  };
  const flag = code => `<span class="flg">${FLAGS[code] || `<em>${code}</em>`}</span>`;
  const statCells = (tr, best) => `<div><b>${(tr.L / 1000).toFixed(3)}<small>KM</small></b><span>Circuit length</span></div><div><b>${tr.apexes.length}</b><span>Corners</span></div><div><b>${tr.drs.length}</b><span>Overtake zones</span></div><div><b>${best ? U.fmtTime(best) : '--:--.---'}</b><span>Your best</span></div>`;

  S.mode = () => {
    const el = h('div', 'wk');
    const flow = F1.Game.flow;
    el.appendChild(header('mode'));
    const wrap = h('div', 'wk-body stage');
    wrap.innerHTML = `<h1 class="pg-t">Choose your drive</h1>`;
    const cards = h('div', 'cards');
    const a = h('div', 'card', `<h3>Arcade</h3><div class="tag">Pick up and play</div>
      <div class="keys-big"><span>W</span><span>A</span><span>S</span><span>D</span></div>
      <p>Everything you need is on four keys. The car shifts itself, catches slides and forgives the odd mistake.</p>
      <ul><li>Automatic gears, traction and stability help</li><li>Extra grip, no tyre wear</li><li>Full racing line with braking cues</li><li>No pit stops or penalties</li></ul>`);
    const b = h('div', 'card', `<h3>Simulation</h3><div class="tag">For the purist</div>
      <div class="keys-big"><span>W</span><span>A</span><span>S</span><span>D</span><span class="wide">SPACE</span><span>P</span></div>
      <p>The full model: suspension and ground-effect aero, slip-based tyres with temperature, pressure and wear, the 2026 hybrid power unit, Overtake mode, fuel load, soft-body damage, track limits and pit strategy.</p>
      <ul><li>Optional manual gears, ABS and traction control</li><li>Soft, medium and hard compounds</li><li>Strikes and time penalties</li><li>Pit stops with the box autopilot</li></ul>`);
    cards.appendChild(a); cards.appendChild(b);
    wrap.appendChild(cards);
    el.appendChild(wrap);
    el.appendChild(foot([['&#8592;&#8594;', 'Select'], ['ENTER', 'Confirm'], ['ESC', 'Back']]));
    const pick = m => () => { F1.Game.flow.mode = m; go(flow.kind === 'champ' ? 'team' : 'track'); };
    return { el, nav: 'h', items: [{ el: a, activate: pick('arcade') }, { el: b, activate: pick('sim') }], focus: flow.mode === 'sim' ? 1 : 0, back: () => go('main') };
  };

  // Circuit select: the circuit in focus fills the screen (the live background moves there),
  // its card reads over it on the left, its map on the right, and the calendar runs along the
  // bottom as a strip of round cards.
  S.track = () => {
    const el = h('div', 'wk');
    const flow = F1.Game.flow;
    el.appendChild(header('track'));
    const wrap = h('div', 'wk-body trk stage');
    wrap.innerHTML = `<div class="trk-info"><h1 class="trk-name"></h1><div class="trk-meta"></div><p class="trk-blurb"></p><div class="trk-stats"></div></div>
      <div class="trk-map"><canvas></canvas><div class="trk-legend"><span class="s1">Sector 1</span><span class="s2">Sector 2</span><span class="s3">Sector 3</span><span class="ot">Overtake</span></div></div>`;
    const cv = wrap.querySelector('.trk-map canvas');
    const rail = h('div', 'rail stage');
    const tiles = [];
    const tile = (top, name, sub, cls) => {
      const e = h('div', 'tile' + (cls ? ' ' + cls : ''), `<div class="tl-top">${top}</div><canvas></canvas><div class="tl-nm">${name}</div><div class="tl-sub">${sub}</div>`);
      rail.appendChild(e); tiles.push(e);
      return e;
    };
    const setInfo = (name, meta, blurb, stats) => {
      wrap.querySelector('.trk-name').textContent = name;
      wrap.querySelector('.trk-meta').innerHTML = meta;
      wrap.querySelector('.trk-blurb').textContent = blurb;
      wrap.querySelector('.trk-stats').innerHTML = stats;
    };
    const items = F1.Tracks.DEFS.map((d, k) => {
      const e = tile(`${flag(d.flag)}<span>ROUND ${String(k + 1).padStart(2, '0')}</span>`, d.name, d.country.toUpperCase());
      return {
        el: e,
        onFocus: () => {
          const tr = F1.Race.getTrack(d.id);
          setInfo(d.name, `${flag(d.flag)}<span>${d.country.toUpperCase()}</span><span class="dot"></span><span>ROUND ${k + 1} OF ${F1.Tracks.DEFS.length}</span>`, d.blurb, statCells(tr, F1.Game.bestLap(d.id, flow.mode)));
          F1.Game.previewTrack(d.id);
          requestAnimationFrame(() => drawTrackMap(cv, tr, { corners: true, w: 6, pad: 30 }));
        },
        activate: () => { flow.track = d.id; go(flow.kind === 'spectate' ? 'setup' : 'team'); },
      };
    });
    // procedural circuits: a new layout from any seed
    {
      const e = tile('<span class="flg gen"><em>GEN</em></span><span>ANY SEED</span>', 'Procedural Circuit', 'A NEW LAYOUT', 'gen');
      items.push({
        el: e,
        onFocus: () => {
          setInfo('Procedural Circuit', '<span>CIRCUIT GENERATOR</span><span class="dot"></span><span>ANY SEED, A NEW LAYOUT</span>',
            'Roll a brand-new Grand Prix layout from a seed: parkland, street or modern venues, each checked for room, run-off, a real start straight and a mix of slow and fast corners. The same seed always builds the same circuit, so seeds can be shared.', '');
          const tr = F1.Race.getTrack('gen-' + (flow.genSeed || 1));
          requestAnimationFrame(() => drawTrackMap(cv, tr, { mono: true, w: 5, pad: 30 }));
        },
        activate: () => go('gen'),
      });
    }
    // the small maps on the cards, one per frame so opening the screen does not stall
    F1.Tracks.DEFS.forEach((d, k) => setTimeout(() => {
      const c = tiles[k].querySelector('canvas');
      if (c.isConnected) drawTrackMap(c, F1.Race.getTrack(d.id), { mono: true, w: 2.4, pad: 8, bare: true });
    }, 60 + k * 50));
    setTimeout(() => { const c = tiles[tiles.length - 1].querySelector('canvas'); if (c.isConnected) drawTrackMap(c, F1.Race.getTrack('gen-' + (flow.genSeed || 1)), { mono: true, w: 2.4, pad: 8, bare: true }); }, 400);
    el.appendChild(wrap);
    el.appendChild(rail);
    el.appendChild(foot([['&#8592;&#8594;', 'Circuit'], ['ENTER', 'Confirm'], ['ESC', 'Back']]));
    const gi = /^gen-/.test(flow.track || '') ? items.length - 1 : -1;
    const idx = gi >= 0 ? gi : Math.max(0, F1.Tracks.DEFS.findIndex(d => d.id === flow.track));
    const onKey = c => {
      if (c === 'ArrowUp' || c === 'KeyW') { setFocus(UI.focus - 1); return true; }
      if (c === 'ArrowDown' || c === 'KeyS') { setFocus(UI.focus + 1); return true; }
      return false;
    };
    return { el, items, nav: 'h', onKey, focus: idx, back: () => go('mode') };
  };

  // ---------- circuit generator ----------
  S.gen = () => {
    const el = h('div', 'wk');
    const wrap = h('div', 'wk-body stage');
    const flow = F1.Game.flow;
    if (!flow.genSeed) flow.genSeed = F1.TrackGen.randomSeed();
    el.appendChild(header('track'));
    wrap.innerHTML = `<h1 class="pg-t">Circuit generator</h1>`;
    const split = h('div', 'split');
    const list = h('div', 'list');
    const det = h('div', 'detail');
    det.innerHTML = `<div><div class="country"></div><h2></h2><div class="blurb"></div><div class="gen-ai"><i></i><span></span></div></div><canvas></canvas><div class="stats"></div>`;
    const cv = det.querySelector('canvas');
    const aiEl = det.querySelector('.gen-ai');
    const race = h('div', 'li', `<span class="flag">GO</span><span><div class="nm">Race This Circuit</div><div class="sub">CHOOSE A TEAM NEXT</div></span><span class="sub"></span>`);
    const roll = h('div', 'li', `<span class="flag">NEW</span><span><div class="nm">New Circuit</div><div class="sub">RANDOM SEED</div></span><span class="sub">R</span>`);
    const seedRow = h('div', 'li gen-seed', `<span class="flag">#</span><span><div class="nm"></div><div class="sub">TYPE A SEED, OR &#9664; &#9654; TO STEP</div></span><span class="sub"></span>`);
    [race, roll, seedRow].forEach(x => list.appendChild(x));
    let typed = 0; // time of the last digit typed (digits within a moment build one number)
    let settle = null;
    // the AI learns a circuit once (its racing line and limits), in the background
    const aiStatus = () => {
      const st = F1.LearnJob.status('gen-' + flow.genSeed);
      aiEl.className = 'gen-ai ' + st.state;
      aiEl.style.setProperty('--p', st.p || 0);
      aiEl.querySelector('span').textContent =
        st.state === 'done' ? 'AI DRIVERS KNOW THIS CIRCUIT'
          : st.state === 'running' ? `AI DRIVERS LEARNING THE CIRCUIT  ${Math.round(st.p * 100)}%  (${st.stage === 'line' ? 'RACING LINE' : 'LIMITS'})`
            : st.state === 'failed' ? 'AI LEARNING FAILED: THEY WILL DRIVE IT CAUTIOUSLY'
              : 'AI DRIVERS WILL LEARN THIS CIRCUIT';
    };
    const offAI = F1.LearnJob.onChange(() => { if (UI.cur && UI.cur.el === el) aiStatus(); });
    const show = () => {
      const def = F1.Tracks.byId('gen-' + flow.genSeed);
      F1.LearnJob.restore(def.id);
      const tr = F1.Race.getTrack(def.id);
      aiStatus();
      clearTimeout(settle);
      // start learning once the player stops flicking through seeds
      settle = setTimeout(() => { if (UI.cur && UI.cur.el === el) F1.LearnJob.start(def.id); }, 700);
      flow.track = def.id;
      seedRow.querySelector('.nm').textContent = String(flow.genSeed);
      det.querySelector('.country').textContent = `${def.country.toUpperCase()}  /  ${def.style.toUpperCase()}`;
      det.querySelector('h2').textContent = def.name;
      det.querySelector('.blurb').textContent = def.blurb;
      const best = F1.Game.bestLap(def.id, flow.mode);
      det.querySelector('.stats').innerHTML = `<div><b>${(tr.L / 1000).toFixed(3)} km</b><span>LENGTH</span></div><div><b>${tr.apexes.length}</b><span>CORNERS</span></div><div><b>${tr.drs.length}</b><span>OVERTAKE ZONES</span></div><div><b>${best ? U.fmtTime(best) : '--:--.---'}</b><span>YOUR BEST</span></div>`;
      requestAnimationFrame(() => drawTrackMap(cv, tr, { corners: true }));
    };
    const setSeed = v => { flow.genSeed = U.clamp(Math.floor(v) || 1, 1, 999999); show(); };
    split.appendChild(list); split.appendChild(det);
    wrap.appendChild(split);
    el.appendChild(wrap);
    el.appendChild(foot([['&#8593;&#8595;', 'Select'], ['0-9', 'Seed'], ['R', 'New circuit'], ['ENTER', 'Confirm'], ['ESC', 'Back']]));
    show();
    const onKey = code => {
      const m = /^(?:Digit|Numpad)(\d)$/.exec(code);
      if (m) {
        const now = performance.now(), d = +m[1];
        setSeed(now - typed < 1500 && flow.genSeed < 100000 ? flow.genSeed * 10 + d : d || 1);
        typed = now; Audio.ui.tick();
        return true;
      }
      if (code === 'Backspace' && performance.now() - typed < 1500) { setSeed(Math.floor(flow.genSeed / 10) || 1); typed = performance.now(); return true; }
      if (code === 'KeyR') { setSeed(F1.TrackGen.randomSeed()); Audio.ui.tick(); return true; }
      return false;
    };
    const items = [
      { el: race, activate: () => go(F1.Game.flow.kind === 'spectate' ? 'setup' : 'team') },
      { el: roll, activate: () => setSeed(F1.TrackGen.randomSeed()) },
      { el: seedRow, left: () => setSeed(flow.genSeed - 1), right: () => setSeed(flow.genSeed + 1) },
    ];
    return { el, items, onKey, focus: 0, back: () => { offAI(); clearTimeout(settle); go('track'); } };
  };

  // team performance as segmented meters, scaled across the grid (the slowest still shows some)
  function meters(t) {
    const T = Data.TEAMS, span = k => { const v = T.map(x => x[k]); return [Math.min(...v), Math.max(...v)]; };
    const norm = (k, x) => { const [a, b] = span(k); return 0.3 + 0.7 * (x - a) / Math.max(1e-6, b - a); };
    const bar = (lbl, f) => { const n = Math.round(f * 10); return `<div class="mtr"><span>${lbl}</span><i>${Array.from({ length: 10 }, (_, k) => `<u class="${k < n ? 'on' : ''}"></u>`).join('')}</i></div>`; };
    return bar('Power unit', norm('power', t.power)) + bar('Aerodynamics', norm('aero', t.aero)) + bar('Overall', norm('rating', t.rating));
  }
  // the team card: name, power unit, meters and the two drivers
  function teamCard(t, sel) {
    const e = h('div', 'tm-card stage');
    teamVars(e, t);
    e.innerHTML = `<div class="tc-name">${t.name}</div><div class="tc-pu"><span>Power unit</span><b>${t.engine}</b><span>Rating</span><b>${t.rating}</b></div>
      <div class="tc-mtr">${meters(t)}</div>
      <div class="tc-drv">${t.drivers.map((d, i) => `<div class="dc${sel === i ? ' sel' : ''}"><span class="no">${d[3]}</span><span class="dn"><small>${d[0]}</small>${d[1].toUpperCase()}</span><span class="cd">${d[2]}</span></div>`).join('')}</div>`;
    if (!document.body.classList.contains('three')) { const ic = F1.Sprites.carIcon(t, 300); ic.className = 'tc-icon'; e.insertBefore(ic, e.firstChild); }
    return e;
  }

  // Team select: the grid as a list on the left; the camera rides alongside the team in focus
  // (the live race behind the menus), with its card at the lower right.
  S.team = () => {
    const el = h('div', 'wk tm');
    const flow = F1.Game.flow;
    el.appendChild(header('team'));
    const wrap = h('div', 'wk-body stage');
    wrap.innerHTML = `<h1 class="pg-t">Choose your team</h1>`;
    const list = h('div', 'tm-list');
    let card = null;
    const items = Data.TEAMS.map((t, k) => {
      const e = h('div', 'tr-row');
      e.style.setProperty('--tc', tcol(t));
      e.innerHTML = `<i class="sw"></i><span class="nm">${t.name}</span><span class="pu">${t.engine.toUpperCase()}</span><span class="rt">${t.rating}</span>`;
      list.appendChild(e);
      return {
        el: e,
        onFocus: () => {
          flow.teamFocus = k;
          teamVars(el, t);
          const n = teamCard(t);
          if (card) card.replaceWith(n); else el.appendChild(n);
          card = n;
          requestAnimationFrame(() => n.classList.add('in'));
          F1.Game.showcase(k, 0);
        },
        activate: () => { if (flow.team !== k) flow.driver = 0; flow.team = k; go('driver'); },
      };
    });
    wrap.appendChild(list);
    el.appendChild(wrap);
    el.appendChild(foot([['&#8593;&#8595;', 'Team'], ['ENTER', 'Confirm'], ['ESC', 'Back']]));
    return { el, items, focus: flow.team || 0, back: () => go(flow.kind === 'champ' ? 'mode' : /^gen-/.test(flow.track || '') ? 'gen' : 'track') };
  };

  // Driver select: the two race numbers, large, in the team's colour
  S.driver = () => {
    const el = h('div', 'wk tm');
    const flow = F1.Game.flow;
    const t = Data.TEAMS[flow.team];
    teamVars(el, t);
    el.appendChild(header('driver'));
    const wrap = h('div', 'wk-body stage');
    wrap.innerHTML = `<h1 class="pg-t">Choose your driver</h1>`;
    const row = h('div', 'dr-list');
    const items = t.drivers.map((d, i) => {
      const e = h('div', 'dr-card', `<span class="no">${d[3]}</span><span class="dn"><small>${d[0]}</small>${d[1].toUpperCase()}</span><span class="meta"><b>${d[2]}</b>${t.name.toUpperCase()}</span>`);
      row.appendChild(e);
      return { el: e, onFocus: () => F1.Game.showcase(flow.team, i), activate: () => { flow.driver = i; go('setup'); } };
    });
    wrap.appendChild(row);
    el.appendChild(wrap);
    el.appendChild(teamCard(t));
    requestAnimationFrame(() => el.querySelector('.tm-card').classList.add('in'));
    el.appendChild(foot([['&#8593;&#8595;', 'Driver'], ['ENTER', 'Confirm'], ['ESC', 'Back']]));
    return { el, items, focus: flow.driver || 0, back: () => go('team') };
  };

  const FMT = { race: 'RACE ONLY', quali: 'QUALIFYING + RACE', full: 'PRACTICE + QUALIFYING + RACE' };
  S.setup = () => {
    const el = h('div', 'wk');
    const flow = F1.Game.flow;
    const sim = flow.mode === 'sim';
    const R = F1.Game.raceDefaults;
    const kind = flow.kind;
    el.appendChild(header('setup'));
    const wrap = h('div', 'wk-body stage');
    wrap.innerHTML = `<h1 class="pg-t">${kind === 'tt' ? 'Session setup' : 'Race setup'}</h1>`;
    const two = h('div', 'two');
    const opts = h('div', 'opts');
    const items = [];
    const add = (o, sec) => { if (sec) { opts.appendChild(h('div', 'opt sec', sec)); } opts.appendChild(o.el); items.push(o); return o; };
    if (kind !== 'tt') {
      add(optRow('Race distance', '', [2, 3, 5, 8, 12, 20], () => R.laps, v => { R.laps = v; updSummary(); }, v => v + ' LAPS'), 'Race');
      add(optRow('AI difficulty', 'Legend drives at the limit the AI learned for each circuit', [0, 1, 2, 3, 4], () => R.difficulty, v => { R.difficulty = v; updSummary(); }, v => Data.DIFFICULTY[v].name));
      if (kind !== 'champ' && kind !== 'weekend' && kind !== 'spectate') add(optRow('Grid position', '', ['pole', 5, 10, 'back', 'random'], () => R.grid, v => { R.grid = v; updSummary(); }, v => v === 'pole' ? 'POLE' : v === 'back' ? 'BACK OF GRID' : v === 'random' ? 'RANDOM' : 'P' + v));
      add(optRow('Field size', '', [10, 16, 20], () => R.field, v => { R.field = v; updSummary(); }, v => v + ' CARS'));
      if (kind === 'weekend') add(optRow('Weekend format', 'Practice is a longer solo session before qualifying', ['full', 'quali'], () => R.wkFmt || 'full', v => { R.wkFmt = v; updSummary(); }, v => FMT[v]));
      if (kind === 'champ') add(optRow('Round format', 'Each round as a race only, or with qualifying for the grid', ['race', 'quali', 'full'], () => R.chFmt || 'race', v => { R.chFmt = v; updSummary(); }, v => FMT[v]));
    }
    if (sim) {
      add(optRow('Starting tyre', '', ['S', 'M', 'H'], () => R.compound, v => { R.compound = v; updSummary(); }, v => F1.Car.COMPOUNDS[v].name), 'Car');
      if (kind !== 'tt') add(optRow('Weather', 'Dry, light or heavy rain, or a changeable day', ['dry', 'light', 'heavy', 'mixed'], () => R.weather || 'dry', v => { R.weather = v; updSummary(); }, v => v.toUpperCase()), 'Conditions');
      if (kind !== 'tt') add(optRow('Safety car', 'A crash can bring it out', ['on', 'off', 'always'], () => R.safetyCar || 'on', v => { R.safetyCar = v; }, v => v.toUpperCase()));
      if (kind !== 'tt') add(optRow('Mandatory pit stop', 'Use two compounds in races of 5 laps or more', [true, false], () => R.mandatory !== false, v => { R.mandatory = v; }, v => (v ? 'ON' : 'OFF')));
      if (kind !== 'spectate') add(optRow('ABS', 'Prevents wheel lock under braking', [true, false], () => R.abs, v => { R.abs = v; }, v => (v ? 'ON' : 'OFF')), 'Assists');
      if (kind !== 'spectate') add(optRow('Traction control', '', [0, 1, 2], () => R.tc, v => { R.tc = v; }, v => ['OFF', 'MEDIUM', 'FULL'][v]));
      if (kind !== 'spectate') add(optRow('Gearbox', '', [true, false], () => R.autoGear, v => { R.autoGear = v; }, v => (v ? 'AUTOMATIC' : 'MANUAL  E / Q')));
      if (kind !== 'spectate') add(optRow('Steering assist', 'Limits lock to the grip available', [true, false], () => R.steerAssist, v => { R.steerAssist = v; }, v => (v ? 'ON' : 'OFF')));
    }
    add(optRow('Damage', 'Full: soft-body crashes, parts break off, punctures, engine and gearbox failures', sim ? ['full', 'limited', 'off'] : ['full', 'off'], () => (R.damage === true ? 'limited' : R.damage === false ? 'off' : R.damage || 'full'), v => { R.damage = v; }, v => ({ full: 'FULL', limited: 'FRONT WING ONLY', off: 'OFF' })[v]), sim ? '' : 'Assists');
    if (kind !== 'spectate') add(optRow('Racing line', 'Red bar: brake. Yellow: turn in. Blue: apex. Green: track out.', ['full', 'brake', 'off'], () => (sim ? R.lineSim : R.lineArcade), v => { if (sim) R.lineSim = v; else R.lineArcade = v; }, v => ({ full: 'FULL', brake: 'BRAKING ONLY', off: 'OFF' })[v]));
    const btn = h('div', 'btn go', `<span>${kind === 'tt' ? 'Start session' : kind === 'champ' ? 'Start championship' : kind === 'weekend' ? 'Start weekend' : kind === 'spectate' ? 'Start watching' : 'Start race'}</span><span class="arrow"><svg viewBox="0 0 24 24"><path d="M4 12h15M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/></svg></span>`);
    const sum = h('div', 'weekend');
    two.appendChild(opts); two.appendChild(sum);
    wrap.appendChild(two);
    el.appendChild(wrap);
    sum.appendChild(btn);
    items.push({ el: btn, activate: () => F1.Game.startFromFlow() });
    el.appendChild(foot([['&#8593;&#8595;', 'Select'], ['&#8592;&#8594;', 'Change'], ['ENTER', 'Confirm'], ['ESC', 'Back']]));
    const info = h('div', 'wk-info');
    sum.insertBefore(info, btn);
    function updSummary() {
      const t = Data.TEAMS[flow.team || 0], d = t.drivers[flow.driver || 0];
      const def = kind === 'champ' ? null : F1.Tracks.byId(flow.track) || F1.Tracks.DEFS[0];
      teamVars(sum, t);
      const wx = { dry: 'Dry', light: 'Light rain', heavy: 'Heavy rain', mixed: 'Changeable' }[R.weather || 'dry'];
      info.innerHTML = `${def ? `<div class="wk-trk"><div><div class="wk-nm">${def.name}</div><div class="wk-ct">${def.flag && FLAGS[def.flag] ? flag(def.flag) : ''}<span>${def.country.toUpperCase()}</span></div></div><canvas></canvas></div>`
          : `<div class="wk-trk"><div><div class="wk-nm">${F1.Tracks.DEFS.length} rounds</div><div class="wk-ct"><span>${F1.Tracks.DEFS.map(x => x.name).join('  /  ').toUpperCase()}</span></div></div></div>`}
        ${kind === 'spectate' ? '<div class="wk-drv"><span class="dn"><small>From the stands</small>SPECTATING<em>Every car, every camera</em></span></div>' : `<div class="wk-drv"><span class="no">${d[3]}</span><span class="dn"><small>${d[0]}</small>${d[1].toUpperCase()}<em>${t.name}</em></span></div>`}
        <div class="wk-grid">
          <div><span>Handling</span><b>${sim ? 'Simulation' : 'Arcade'}</b></div>
          ${kind === 'weekend' || kind === 'champ' ? `<div><span>Format</span><b>${{ race: 'Race only', quali: 'Qualifying, race', full: 'Practice, qualifying, race' }[kind === 'champ' ? R.chFmt || 'race' : R.wkFmt || 'full']}</b></div>` : ''}
          ${kind !== 'tt' ? `<div><span>Distance</span><b>${R.laps} laps</b></div><div><span>${kind === 'spectate' ? 'Field' : 'Opponents'}</span><b>${kind === 'spectate' ? R.field : R.field - 1}, ${Data.DIFFICULTY[R.difficulty].name.toLowerCase()}</b></div>` : ''}
          ${sim ? `<div><span>Tyre</span><b class="c-${R.compound}">${F1.Car.COMPOUNDS[R.compound].name.toLowerCase()}</b></div>` : ''}
          ${sim && kind !== 'tt' ? `<div><span>Weather</span><b>${wx}</b></div>` : ''}
        </div>`;
      const cv = info.querySelector('canvas');
      if (cv) requestAnimationFrame(() => drawTrackMap(cv, F1.Race.getTrack(flow.track), { mono: true, w: 3.5, pad: 10, bare: true }));
    }
    updSummary();
    return { el, items, back: () => go(kind === 'spectate' ? 'track' : 'driver'), focus: items.length - 1, pickable: false,
      primary: { label: kind === 'tt' ? 'START SESSION' : kind === 'champ' ? 'START CHAMPIONSHIP' : kind === 'weekend' ? 'START WEEKEND' : kind === 'spectate' ? 'START WATCHING' : 'START RACE', fn: () => F1.Game.startFromFlow() } };
  };

  // ---------- settings draft and APPLY ----------
  // The settings screens edit a copy of the settings; nothing changes until APPLY (graphics
  // changes can rebuild shaders, or restart the game for potato and rock, so they go in one
  // batch). The advanced graphics screen edits the same copy. Leaving with changes not yet
  // applied asks once, then discards them.
  let SD = null;
  const draftOf = () => JSON.parse(JSON.stringify(F1.Game.settings));
  const draftDirty = () => !!SD && JSON.stringify(SD) !== JSON.stringify(F1.Game.settings);
  function applyDraft() {
    const G = F1.Game, gx = SD.gfx;
    if (gx.boot == null) gx.boot = F1.R3 && F1.R3.bootTier ? F1.R3.bootTier() : '';
    Object.assign(G.settings.gfx, gx);
    const { gfx, ...rest } = SD; void gfx;
    Object.assign(G.settings, rest);
    G.applySettings();
    SD = draftOf();
    if (F1.R3 && F1.R3.bootTier && F1.R3.bootTier() !== (gx.boot || '')) { G.saveSettings(); setTimeout(() => location.reload(), 200); return true; }
    return false;
  }
  // the APPLY button: dimmed with nothing to apply, says what applying will do
  function applyButton(parent, items, after) {
    const b = h('div', 'btn apply', '<span>APPLY</span><span class="arrow">&#10003;</span>');
    parent.appendChild(b);
    let warned = false;
    const label = b.querySelector('span');
    const update = () => {
      const d = draftDirty();
      b.classList.toggle('dim', !d);
      const restart = d && F1.R3 && F1.R3.bootTier && F1.R3.bootTier() !== (SD.gfx.boot != null ? SD.gfx.boot : F1.R3.bootTier());
      label.textContent = warned && d ? 'APPLY CHANGES?  ESC AGAIN DISCARDS' : d ? (restart ? 'APPLY AND RESTART' : 'APPLY') : 'APPLIED';
    };
    items.push({ el: b, activate: () => { if (!draftDirty()) return; warned = false; if (!applyDraft()) { after(); update(); } else label.textContent = 'RESTARTING'; } });
    update();
    return { update, leave: () => { if (draftDirty() && !warned) { warned = true; update(); return false; } SD = null; return true; } };
  }
  // the scenery level is a shorthand for four values
  const SCENERY = {
    full: { trees: 1, treeDist: 0, boards: true, backdrop: true },
    reduced: { trees: 0.6, treeDist: 0, boards: true, backdrop: true },
    sparse: { trees: 0.33, treeDist: 0, boards: false, backdrop: true },
    minimal: { trees: 0.12, treeDist: 700, boards: false, backdrop: false },
  };
  const sceneryOf = gx => Object.keys(SCENERY).find(k => Object.entries(SCENERY[k]).every(([a, v]) => gx[a] === v)) || 'custom';

  S.settings = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    if (!o.keep || !SD) SD = draftOf();
    const st = SD;
    wrap.innerHTML = `<div class="crumbs">OPTIONS</div><div class="h1">SETTINGS</div>`;
    const opts = h('div', 'opts');
    const items = [];
    const vols = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    const pct = v => Math.round(v * 100) + '%';
    const opts2 = h('div', 'opts');
    let col = opts;
    const add = (o, sec) => { if (sec) col.appendChild(h('div', 'opt sec', sec)); col.appendChild(o.el); items.push(o); };
    add(optRow('Master volume', '', vols, () => st.master, v => { st.master = v; touched(); }, pct), 'AUDIO');
    add(optRow('Effects volume', '', vols, () => st.sfx, v => { st.sfx = v; touched(); }, pct));
    add(optRow('Music volume', 'Menus only', vols, () => st.music, v => { st.music = v; touched(); }, pct));
    add(optRow('Camera', '', F1.Game.CAMS, () => st.camera, v => { st.camera = v; touched(); }, v => F1.Game.CAM_NAMES[v] || v), 'DISPLAY');
    add(optRow('Camera zoom', '', [0.8, 0.9, 1, 1.1, 1.25], () => st.zoom, v => { st.zoom = v; touched(); }, v => Math.round(v * 100) + '%'));
    add(optRow('Mobile mode', 'Touch controls in the race. Auto turns them on with a touch screen', ['auto', 'on', 'off'], () => st.mobile || 'auto', v => { st.mobile = v; touched(); }, v => v.toUpperCase()));
    add(optRow('Touch steering', 'Pad: slide a thumb. Tilt: turn the phone like a wheel', ['pad', 'tilt'], () => st.touchSteer || 'pad', v => { st.touchSteer = v; touched(); }, v => v.toUpperCase()));
    add(optRow('Pad sensitivity', 'How far the thumb slides for full lock', [0.5, 0.75, 1, 1.25, 1.5, 2], () => st.tSens || 1, v => { st.tSens = v; touched(); }, v => Math.round(v * 100) + '%'));
    add(optRow('Tilt sensitivity', 'Full lock at 35 degrees of tilt at 100%', [0.5, 0.75, 1, 1.25, 1.5, 2], () => st.tiltSens || 1, v => { st.tiltSens = v; touched(); }, v => Math.round(v * 100) + '%'));
    add(optRow('Cockpit head motion', 'The view reacts to braking, cornering and kerbs', [true, false], () => st.headMotion !== false, v => { st.headMotion = v; touched(); }, v => (v ? 'ON' : 'OFF')));
    add(optRow('Speed units', '', ['kmh', 'mph'], () => st.units, v => { st.units = v; touched(); }, v => (v === 'kmh' ? 'KM/H' : 'MPH')));
    add(optRow('Timing tower gaps', '', ['interval', 'leader'], () => st.gapMode, v => { st.gapMode = v; touched(); }, v => (v === 'interval' ? 'TO CAR AHEAD' : 'TO LEADER')));
    add(optRow('Name tags', 'Driver codes above nearby cars', [true, false], () => st.tags, v => { st.tags = v; touched(); }, v => (v ? 'ON' : 'OFF')));
    add(optRow('Sensitivity', 'Right click in a race to switch mouse steering on', [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3], () => st.mSens, v => { st.mSens = v; touched(); }, v => v.toFixed(2) + 'x'), 'MOUSE STEERING');
    add(optRow('Deadzone', 'Movement ignored around the centre', [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15], () => st.mDead, v => { st.mDead = v; touched(); }, v => Math.round(v * 100) + '%'));
    add(optRow('Steering curve', 'Progressive is gentle near the centre', ['linear', 'progressive', 'aggressive'], () => st.mCurve, v => { st.mCurve = v; touched(); }, v => v.toUpperCase()));
    add(optRow('Self-centring', 'Pulls the wheel back when the mouse is still', [0, 0.6, 1.5, 3], () => st.mCentre, v => { st.mCentre = v; touched(); }, v => ({ 0: 'OFF', 0.6: 'LOW', 1.5: 'MEDIUM', 3: 'HIGH' })[v]));
    add(optRow('Smoothing', '', [0, 0.04, 0.1], () => st.mSmooth, v => { st.mSmooth = v; touched(); }, v => ({ 0: 'OFF', 0.04: 'LOW', 0.1: 'HIGH' })[v]));
    add(optRow('Invert', '', [false, true], () => st.mInvert, v => { st.mInvert = v; touched(); }, v => (v ? 'ON' : 'OFF')));
    // graphics: a preset sets everything below it; touching any single option makes it CUSTOM
    if (F1.R3 && document.body.classList.contains('three')) {
      col = opts2;
      const gx = st.gfx, P = F1.Game.GFX_PRESETS;
      const onOff = v => (v ? 'ON' : 'OFF');
      const setG = (k, v) => { gx[k] = v; gx.preset = 'custom'; touched(); };
      add(optRow('Quality preset', 'Rock and Potato are for phones and integrated graphics, and restart the game', ['rock', 'potato', 'low', 'medium', 'high', 'ultra', 'custom'], () => gx.preset, v => {
        if (v === 'custom') { gx.preset = 'custom'; touched(); return; }
        // potato and rock change how the WebGL context is made: applying one restarts the game
        Object.assign(gx, P[v], { preset: v, boot: v === 'rock' || v === 'potato' ? v : '' }); touched();
      }, v => v.toUpperCase()), 'GRAPHICS');
      add(optRow('Post-processing', 'HDR pipeline. Off is fastest', [true, false], () => gx.post, v => setG('post', v), onOff));
      add(optRow('Scenery', 'Tree density, trackside boards and distant hills', ['full', 'reduced', 'sparse', 'minimal'], () => sceneryOf(gx), v => { Object.assign(gx, SCENERY[v], { scenery: v }); gx.preset = 'custom'; touched(); }, v => v.toUpperCase()));
      add(optRow('Render scale', 'Above 100% supersamples', [0.4, 0.5, 0.7, 0.75, 1, 1.25, 1.5], () => gx.scale, v => setG('scale', v), v => Math.round(v * 100) + '%'));
      add(optRow('Anti-aliasing', '', [0, 2, 4, 8], () => gx.msaa, v => setG('msaa', v), v => (v ? 'MSAA ' + v + 'X' : 'OFF')));
      add(optRow('Shadows', '', ['off', 'low', 'medium', 'high', 'ultra'], () => gx.shadows, v => setG('shadows', v), v => v.toUpperCase()));
      add(optRow('Ambient occlusion', 'Contact shadowing in creases', [true, false], () => gx.ssao, v => setG('ssao', v), onOff));
      add(optRow('Bloom', 'Glow from bright highlights', [true, false], () => gx.bloom, v => setG('bloom', v), onOff));
      add(optRow('Sun shafts', '', [true, false], () => gx.shafts, v => setG('shafts', v), onOff));
      add(optRow('Motion blur', 'Camera motion only', [true, false], () => gx.motion, v => setG('motion', v), onOff));
      add(optRow('Lens effects', 'Vignette, chromatic aberration, grain', [true, false], () => gx.lens, v => setG('lens', v), onOff));
      add(optRow('Tone mapping', 'AgX keeps bright colours natural', ['agx', 'aces'], () => gx.tone, v => setG('tone', v), v => (v === 'agx' ? 'AGX' : 'ACES FILMIC')));
      add(optRow('Exposure', '', [-1, -0.5, 0, 0.5, 1], () => gx.ev, v => { gx.ev = v; touched(); }, v => (v > 0 ? '+' : '') + v.toFixed(1) + ' EV'));
      const adv = h('div', 'btn', '<span>ADVANCED GRAPHICS</span><span class="arrow">&#8594;</span>');
      adv.style.marginTop = '14px';
      opts2.appendChild(adv);
      items.push({ el: adv, activate: () => go('gfxadv', { back: o.back }) });
    }
    const ap = applyButton(opts, items, () => refresh());
    const back = h('div', 'btn', '<span>BACK</span><span class="arrow">&#8592;</span>');
    opts.appendChild(back);
    items.push({ el: back, activate: () => doBack() });
    function touched() { items.forEach(i => i.render && i.render()); ap.update(); }
    function refresh() { items.forEach(i => i.render && i.render()); ap.update(); }
    const two = h('div', 'two');
    opts.style.maxWidth = opts2.style.maxWidth = '';
    two.appendChild(opts); two.appendChild(opts2);
    wrap.appendChild(two);
    el.appendChild(wrap);
    el.appendChild(foot([['&#8593;&#8595;', 'select'], ['&#8592;&#8594;', 'change'], ['ESC', 'back']]));
    const doBack = () => { if (!ap.leave()) return; if (o.back === 'pause') F1.Game.showPause(); else go(o.back || 'main'); };
    return { el, items, back: doBack };
  };

  // ---------- advanced graphics ----------
  // Every setting that trades speed for looks, grouped. Each edits the settings draft (see
  // APPLY above) and turns the preset to CUSTOM.
  const pctF = v => Math.round(v * 100) + '%', onOffF = v => (v ? 'ON' : 'OFF'), mF = v => v + ' M', allM = v => (v ? v + ' M' : 'ALL');
  const ADV_ROWS = [
    ['RESOLUTION AND FRAME RATE'],
    ['scale', 'Render scale', 'Resolution the 3D scene is drawn at', [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.9, 1, 1.25, 1.5, 2], pctF],
    ['dprCap', 'Pixel density cap', 'Phones have 2 to 3 pixels per point. 1x is far faster', [1, 1.5, 2, 3], v => v + 'X'],
    ['fpsCap', 'Frame rate limit', 'A lower limit saves battery and heat', [0, 30, 45, 60, 90, 120], v => (v ? v + ' FPS' : 'OFF')],
    ['msaa', 'Anti-aliasing', 'Needs post-processing', [0, 2, 4, 8], v => (v ? 'MSAA ' + v + 'X' : 'OFF')],
    ['aniso', 'Texture filtering', 'Road and kerb sharpness at a glancing angle', [1, 2, 4, 8, 16], v => (v === 1 ? 'BILINEAR' : v + 'X ANISOTROPIC')],
    ['LIGHTING AND SHADOWS'],
    ['shadows', 'Shadows', 'Number and size of the sun shadow slices', ['off', 'low', 'medium', 'high', 'ultra'], v => v.toUpperCase()],
    ['shadowRes', 'Shadow resolution', 'Sharpness of shadow edges', [0.5, 0.75, 1, 1.5, 2], pctF],
    ['shadowDist', 'Shadow distance', 'How far from the camera shadows reach', [0.5, 0.75, 1, 1.5, 2], pctF],
    ['shadowSoft', 'Shadow softness', '', [0.5, 1, 1.5, 2, 3], pctF],
    ['ssao', 'Ambient occlusion', 'Contact shadow in creases. Needs post-processing', [true, false], onOffF],
    ['aoSamples', 'Occlusion quality', 'Samples per pixel', [6, 8, 10, 16, 24], v => v + ' SAMPLES'],
    ['aoStrength', 'Occlusion strength', '', [0.5, 0.7, 0.85, 1, 1.2], pctF],
    ['POST-PROCESSING'],
    ['post', 'Post-processing', 'HDR pipeline. Off is fastest and turns off everything below', [true, false], onOffF],
    ['bloom', 'Bloom', 'Glow from bright highlights', [true, false], onOffF],
    ['bloomK', 'Bloom strength', '', [0.03, 0.06, 0.1, 0.15], v => Math.round(v / 0.06 * 100) + '%'],
    ['shafts', 'Sun shafts', '', [true, false], onOffF],
    ['shaftK', 'Sun shaft strength', '', [0.2, 0.45, 0.7, 1], v => Math.round(v / 0.45 * 100) + '%'],
    ['motion', 'Motion blur', 'Camera motion and moving cars', [true, false], onOffF],
    ['shutter', 'Motion blur amount', 'Shutter angle. 360 blurs the most', [90, 180, 270, 360], v => v + ' DEG'],
    ['lens', 'Lens effects', 'Vignette, chromatic aberration', [true, false], onOffF],
    ['grain', 'Film grain', 'Needs lens effects', [true, false], onOffF],
    ['tone', 'Tone mapping', 'AgX keeps bright colours natural', ['agx', 'aces'], v => (v === 'agx' ? 'AGX' : 'ACES FILMIC')],
    ['ev', 'Exposure', '', [-1, -0.5, 0, 0.5, 1], v => (v > 0 ? '+' : '') + v.toFixed(1) + ' EV', true],
    ['WORLD'],
    ['viewDist', 'View distance', 'The fog closes in to meet it. Potato and Rock stop at 3 km', [1600, 2400, 3000, 5000, 8000, 14000], v => (v / 1000).toFixed(1) + ' KM'],
    ['trees', 'Tree density', 'Share of the trees drawn', [0, 0.12, 0.33, 0.6, 1], pctF],
    ['treeDist', 'Tree draw distance', '', [400, 700, 1200, 2000, 0], allM],
    ['grass', '3D grass', 'Blades around the camera on parkland circuits', [true, false], onOffF],
    ['grassDensity', 'Grass density', 'Share of the 28 blades in each clump', [0.3, 0.45, 0.6, 0.75, 0.85, 1], pctF],
    ['grassLod', 'Grass detail distance', 'How far every blade is modelled; cards beyond', [6, 9, 13, 17, 22], mF],
    ['grassDist', 'Grass draw distance', 'How far 3D grass reaches at all (wider cards past 45 m)', [25, 40, 56, 70, 90, 120, 150, 180, 220], mF],
    ['boards', 'Trackside boards', 'Marker boards before the corners', [true, false], onOffF],
    ['backdrop', 'Distant hills', 'Needs a long view distance', [true, false], onOffF],
    ['CARS'],
    ['carNear', 'Full detail up to', 'Distance a car keeps its full model', [2.5, 6, 12, 22, 50, 100], mF],
    ['carFar', 'Simple model beyond', 'One draw call per car, no livery detail', [9, 20, 40, 90, 300, 1000], mF],
    ['carDraw', 'Car draw distance', 'Further cars are not drawn', [150, 250, 350, 600, 0], allM],
    ['dispHz', 'Wheel display refresh', 'The screen on the steering wheel in the cockpit', [0, 4, 6, 8, 12, 20, 30], v => (v ? v + ' HZ' : 'FROZEN')],
    ['EFFECTS'],
    ['particles', 'Smoke and sparks', 'Particles alive at once', [0, 150, 300, 500, 900, 1500], v => (v ? String(v) : 'OFF')],
    ['skids', 'Skid marks', 'Marks kept on the track', [0, 1500, 3000, 4500, 9000], v => (v ? String(v) : 'OFF')],
    ['debris', 'Crash debris', 'Loose parts kept on the track', [0, 10, 20, 40, 80], v => (v ? String(v) : 'OFF')],
    ['rainK', 'Rain density', 'Drops drawn in wet weather', [0.25, 0.4, 0.6, 1], pctF],
    ['SIMULATION'],
    ['physLod', 'Distant AI physics', 'Half rate past the distance below. Close racing is untouched', [false, true], v => (v ? 'HALF RATE' : 'FULL')],
    ['physLodDist', 'Half rate beyond', '', [100, 150, 250, 400], mF],
    ['catchup', 'Slow motion below', 'When the device falls behind: slow the game instead of stuttering', [40, 12, 8], v => ({ 40: 'OFF', 12: '20 FPS', 8: '30 FPS' })[v] || v],
  ];
  S.gfxadv = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    if (!SD) SD = draftOf();
    const gx = SD.gfx;
    wrap.innerHTML = `<div class="crumbs">OPTIONS  /  SETTINGS</div><div class="h1">ADVANCED GRAPHICS</div>`;
    const c1 = h('div', 'opts'), c2 = h('div', 'opts'), items = [];
    let col = c1, sec = null;
    ADV_ROWS.forEach(r => {
      if (r.length === 1) { sec = r[0]; if (sec === 'WORLD') col = c2; return; }
      const [k, label, sub2, values, fmt, keepPreset] = r;
      const row = optRow(label, sub2, values, () => gx[k], v => { gx[k] = v; if (!keepPreset) gx.preset = 'custom'; touched(); }, fmt);
      if (sec) { col.appendChild(h('div', 'opt sec', sec)); sec = null; }
      col.appendChild(row.el); items.push(row);
    });
    const pre = h('div', 'opt sec', 'PRESET  ' + '<b class="adv-pre"></b>');
    c1.insertBefore(pre, c1.firstChild);
    const ap = applyButton(c2, items, () => touched());
    const back = h('div', 'btn', '<span>BACK</span><span class="arrow">&#8592;</span>');
    c2.appendChild(back);
    items.push({ el: back, activate: () => doBack() });
    function touched() { items.forEach(i => i.render && i.render()); pre.querySelector('.adv-pre').textContent = gx.preset.toUpperCase(); ap.update(); }
    touched();
    const two = h('div', 'two adv');
    c1.style.maxWidth = c2.style.maxWidth = '';
    two.appendChild(c1); two.appendChild(c2);
    wrap.appendChild(two);
    el.appendChild(wrap);
    el.appendChild(foot([['&#8593;&#8595;', 'select'], ['&#8592;&#8594;', 'change'], ['ESC', 'back']]));
    // back to the settings screen with the draft kept
    const doBack = () => go('settings', { back: o.back, keep: true });
    return { el, items, back: doBack };
  };

  S.controls = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    wrap.innerHTML = `<div class="crumbs">OPTIONS</div><div class="h1">CONTROLS</div>`;
    const k = s => s.split(' ').map(x => `<span class="key">${x}</span>`).join('');
    const rows = (arr) => arr.map(([a, b]) => `<div class="ctl"><span>${a}</span><span class="k">${k(b)}</span></div>`).join('');
    const g = h('div', 'ctl-grid');
    g.innerHTML = `<div><div class="crumbs" style="margin-top:6px">DRIVING</div>${rows([['Throttle', 'W &#8593;'], ['Brake / reverse', 'S &#8595;'], ['Steer', 'A D'], ['Overtake mode (simulation)', 'SPACE'], ['Shift up / down (manual)', 'E Q'], ['Pit strategy (simulation)', 'P'], ['Reset car (arcade)', 'R']])}</div>
      <div><div class="crumbs" style="margin-top:6px">GENERAL</div>${rows([['Pause', 'ESC'], ['Camera mode', 'C'], ['Zoom near / standard / far', 'Z'], ['Mouse steering on / off', 'RMB'], ['Mute', 'M'], ['Hide HUD', 'H'], ['Menu select', 'ENTER'], ['Back', 'ESC']])}
      <div class="crumbs" style="margin-top:22px">GAMEPAD</div>${rows([['Steer', 'LS'], ['Throttle / brake', 'RT LT'], ['Overtake / pit', 'A Y'], ['Gears', 'RB LB'], ['Pause', 'START']])}</div>`;
    wrap.appendChild(g);
    const back = h('div', 'btn', '<span>BACK</span><span class="arrow">&#8592;</span>');
    back.style.maxWidth = '420px';
    wrap.appendChild(back);
    el.appendChild(wrap);
    const doBack = () => { if (o.back === 'pause') F1.Game.showPause(); else go(o.back || 'main'); };
    return { el, items: [{ el: back, activate: doBack }], back: doBack };
  };

  S.loading = o => {
    const el = h('div');
    const def = o.def, tr = o.tr;
    const num = o.round ? String(o.round).padStart(2, '0') : def.gen ? 'GEN' : String(F1.Tracks.DEFS.indexOf(def) + 1).padStart(2, '0');
    const rnd = o.round ? `ROUND ${o.round}  /  ` : '';
    const session = o.quali != null ? rnd + 'QUALIFYING  ' + ['Q1', 'Q2', 'Q3'][o.quali] : o.practice ? rnd + 'FREE PRACTICE' : o.mode === 'tt' ? 'TIME TRIAL' : o.round ? `ROUND ${o.round} OF ${o.total}` : 'GRAND PRIX';
    const handling = o.mode === 'sim' || (o.mode === 'tt' && o.ttHandling === 'sim') ? 'SIMULATION' : 'ARCADE';
    const tc = o.team.base === '#121417' ? o.team.accent : o.team.base;
    el.innerHTML = `
      <div class="ld-num">${num}</div>
      <div class="stage ld-left">
        <div class="ld-session"><span>${session}</span><span>${handling}</span></div>
        <div class="ld-country"><span class="flag">${def.flag}</span>${def.country.toUpperCase()}</div>
        <div class="ld-track">${def.name}</div>
        <div class="ld-blurb">${def.blurb}</div>
        <div class="ld-learn"></div>
        <div class="ld-stats">
          <div><b>${(tr.L / 1000).toFixed(3)}</b><span>KM</span></div>
          <div><b>${tr.apexes.length}</b><span>CORNERS</span></div>
          <div><b>${tr.drs.length}</b><span>OVERTAKE ZONES</span></div>
          ${o.laps ? `<div><b>${o.laps}</b><span>LAPS</span></div>` : ''}
          <div><b>${o.best ? U.fmtTime(o.best) : '--:--.---'}</b><span>YOUR BEST</span></div>
        </div>
        <div class="ld-driver" style="--tc:${tc}"><i></i><span><b>${o.driver[0]} ${o.driver[1].toUpperCase()}</b><small>${o.team.name.toUpperCase()}  /  #${o.driver[3]}</small></span></div>
      </div>
      <div class="ld-map"><canvas></canvas><div class="ld-legend"><span class="s1">S1</span><span class="s2">S2</span><span class="s3">S3</span><span class="drs">DRS</span></div></div>
      <div class="ld-foot">
        <div class="ld-tip"><span class="lbl">TIP</span>${TIPS[Math.floor(Math.random() * TIPS.length)]}</div>
        <div class="ld-prog"><div class="ld-bar"><i></i></div><div class="ld-state">LOADING CIRCUIT</div></div>
      </div>`;
    requestAnimationFrame(() => drawTrackMap(el.querySelector('.ld-map canvas'), tr, { corners: true, w: 5, pad: 26 }));
    const scr = { el, items: [] };
    scr.ready = () => {
      el.classList.add('ready');
      el.querySelector('.ld-state').innerHTML = '<span class="key">ENTER</span> START';
    };
    return scr;
  };

  S.pause = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    wrap.innerHTML = `<div class="crumbs">${o.race.track.name.toUpperCase()}</div><div class="h1">PAUSED</div>`;
    const menu = h('div', 'menu');
    const entries = [['RESUME', () => F1.Game.resume()], ...(F1.Game.canReplay() ? [['REPLAY', () => F1.Game.watchReplay(() => F1.Game.backToPause())]] : []), ['RESTART', () => F1.Game.restart()], ['SETTINGS', () => go('settings', { back: 'pause' })], ['CONTROLS', () => go('controls', { back: 'pause' })], ...(o.race.quali != null || o.race.practice ? [['END SESSION', () => F1.Game.endQuali()], [F1.Game.flow.kind === 'champ' ? 'QUIT CHAMPIONSHIP' : 'QUIT WEEKEND', () => F1.Game.quitToMenu()]] : [[o.race.mode === 'tt' ? 'END SESSION' : 'RETIRE TO MENU', () => F1.Game.quitToMenu()]])];
    const items = entries.map(([t, fn]) => { const e = h('div', 'mi', t); menu.appendChild(e); return { el: e, activate: fn }; });
    wrap.appendChild(menu);
    el.appendChild(wrap);
    // session info on the right
    const p = o.race.player;
    const info = h('div', 'summary pause-info');
    const lapStr = o.race.mode === 'tt' ? `${Math.max(0, p.lapTimes.length)} laps` : `${U.clamp(p.lap, 1, o.race.laps)} / ${o.race.laps}`;
    info.innerHTML = `<div class="sm-t">SESSION</div>
      <div class="sm-r"><span>${o.race.mode === 'tt' ? 'Laps completed' : 'Lap'}</span><b>${lapStr}</b></div>
      ${o.race.mode !== 'tt' ? `<div class="sm-r"><span>Position</span><b>P${p.pos}</b></div>` : ''}
      <div class="sm-r"><span>Best lap</span><b>${U.fmtTime(p.bestLap)}</b></div>
      <div class="sm-r"><span>Last lap</span><b>${U.fmtTime(p.lastLap)}</b></div>
      ${o.race.sim ? `<div class="sm-r"><span>Tyres</span><b>${p.compound.name}  ${Math.round(Math.max(...p.wheels.map(w => w.wear)) * 100)}%</b></div><div class="sm-r"><span>Penalties</span><b>${p.penalty ? '+' + p.penalty + 's' : 'None'}</b></div>` : ''}`;
    el.appendChild(info);
    return { el, items, back: () => F1.Game.resume() };
  };

  S.results = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    const race = o.race, res = race.result;
    const champ = F1.Game.flow && F1.Game.flow.kind === 'champ' && F1.Game.champ;
    wrap.innerHTML = `<div class="crumbs">${champ ? 'ROUND ' + (champ.round + 1) + ' OF ' + F1.Tracks.DEFS.length + '  /  ' : ''}${race.track.name.toUpperCase()}</div><div class="h1">RACE CLASSIFICATION</div>`;
    const pod = h('div', 'podium');
    [1, 0, 2].forEach(k => {
      const c = res[k];
      if (!c) return;
      const d = h('div', `pod p${k + 1}${c.isPlayer ? ' me' : ''}`);
      d.style.setProperty('--tc', c.team.base === '#121417' ? c.team.accent : c.team.base);
      d.innerHTML = `<div class="pp">P${k + 1}</div><div class="pd">${c.driver.first} ${c.driver.last}</div><div class="pt">${c.team.name.toUpperCase()}</div>`;
      pod.appendChild(d);
    });
    wrap.appendChild(pod);
    const leader = res[0];
    const rows = res.map((c, k) => {
      let time;
      if (!c.finished) time = 'DNF';
      else if (k === 0) time = U.fmtTime(c.total);
      else if (c.lapTimes.length < leader.lapTimes.length) time = '+' + (leader.lapTimes.length - c.lapTimes.length) + ' LAP';
      else time = '+' + (c.total - leader.total).toFixed(3);
      const fl = race.fastest && race.fastest.car === c;
      return `<tr class="${c.isPlayer ? 'me' : ''}"><td class="pos">${k + 1}</td><td><span class="sw" style="background:${c.team.base === '#121417' ? c.team.accent : c.team.base}"></span>${c.driver.first} ${c.driver.last.toUpperCase()}</td>
        <td>${c.team.name}</td><td>${time}${c.penalty ? ` <span style="color:var(--accent)">(+${c.penalty}s)</span>` : ''}</td><td class="${fl ? 'fl' : ''}">${U.fmtTime(c.bestLap)}</td><td>${race.sim ? c.pitStops : '-'}</td><td>${c.gridPos}</td><td class="pts">${c.points || ''}</td></tr>`;
    }).join('');
    const tbl = h('div');
    tbl.style.maxHeight = '42vh'; tbl.style.overflow = 'auto';
    tbl.innerHTML = `<table class="res"><tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>TIME</th><th>BEST LAP</th><th>STOPS</th><th>GRID</th><th style="text-align:right">PTS</th></tr>${rows}</table>`;
    wrap.appendChild(tbl);
    const acts = h('div', 'res-actions');
    const items = [];
    const mk = (t, fn) => { const b = h('div', 'btn', `<span>${t}</span><span class="arrow">&#8594;</span>`); acts.appendChild(b); items.push({ el: b, activate: fn }); };
    if (champ) mk('CONTINUE', () => F1.Game.champContinue());
    else { mk(F1.Game.flow.kind === 'spectate' ? 'WATCH ANOTHER' : 'RACE AGAIN', () => F1.Game.restart()); mk('MAIN MENU', () => F1.Game.quitToMenu()); }
    if (F1.Game.canReplay()) mk('WATCH REPLAY', () => F1.Game.watchReplay(() => F1.Game.backToResults(() => go('results', o))));
    wrap.appendChild(acts);
    el.appendChild(wrap);
    return { el, items, nav: 'h' };
  };

  S.standings = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    const ch = F1.Game.champ;
    const done = ch.round >= F1.Tracks.DEFS.length - 1 && o.final;
    wrap.innerHTML = `<div class="crumbs">CHAMPIONSHIP  /  AFTER ROUND ${ch.round + 1}</div><div class="h1">${done ? 'FINAL STANDINGS' : 'DRIVERS’ STANDINGS'}</div>`;
    const list = Object.values(ch.table).sort((a, b) => b.pts - a.pts || b.wins - a.wins);
    if (done) {
      const w = list[0];
      const banner = h('div', 'summary');
      banner.style.marginBottom = '14px';
      banner.innerHTML = `<div class="sm-t">WORLD CHAMPION</div><div style="font-size:44px;font-weight:900;font-style:italic;line-height:1">${w.name}</div><div style="color:var(--ink-3);letter-spacing:.1em;font-weight:700;margin-top:4px">${w.team.toUpperCase()}  /  ${w.pts} POINTS</div>`;
      wrap.appendChild(banner);
    }
    const tbl = h('div');
    tbl.style.maxHeight = done ? '40vh' : '52vh'; tbl.style.overflow = 'auto';
    tbl.innerHTML = `<table class="res"><tr><th>POS</th><th>DRIVER</th><th>TEAM</th>${ch.quali ? '<th>POLES</th>' : ''}<th>WINS</th><th>PODIUMS</th><th style="text-align:right">PTS</th></tr>${list.map((r, k) => `<tr class="${r.player ? 'me' : ''}"><td class="pos">${k + 1}</td><td><span class="sw" style="background:${r.color}"></span>${r.name}</td><td>${r.team}</td>${ch.quali ? `<td>${r.poles || 0}</td>` : ''}<td>${r.wins}</td><td>${r.pods}</td><td class="pts">${r.pts}</td></tr>`).join('')}</table>`;
    wrap.appendChild(tbl);
    const acts = h('div', 'res-actions');
    const items = [];
    const mk = (t, fn) => { const b = h('div', 'btn', `<span>${t}</span><span class="arrow">&#8594;</span>`); acts.appendChild(b); items.push({ el: b, activate: fn }); };
    if (done) mk('MAIN MENU', () => F1.Game.quitToMenu());
    else { mk('NEXT ROUND  ' + F1.Tracks.DEFS[ch.round + 1].name.toUpperCase(), () => F1.Game.champNext()); mk('QUIT TO MENU', () => F1.Game.quitToMenu()); }
    wrap.appendChild(acts);
    el.appendChild(wrap);
    return { el, items, nav: 'h' };
  };

  // qualifying session classification, with the knockout line
  S.quali = o => {
    const el = h('div');
    const wrap = h('div', 'menu-wrap stage');
    const ev = o.round ? `ROUND ${o.round} OF ${F1.Tracks.DEFS.length}` : 'GRAND PRIX WEEKEND';
    wrap.innerHTML = `<div class="crumbs">${ev}  /  ${o.track.toUpperCase()}</div><div class="h1">${o.practice ? 'FREE PRACTICE' : 'QUALIFYING  ' + o.name}</div>`;
    const sw = c => (c.team.base === '#121417' ? c.team.accent : c.team.base);
    const rows = o.rows.map((r, k) => {
      const t = r.t == null ? 'NO TIME' : k === 0 ? (o.name === 'Q3' ? 'POLE' : 'FASTEST') : '+' + (r.t - o.pole).toFixed(3);
      const line = o.cut != null && k === o.cut ? '<tr class="cutline"><td colspan="5">ELIMINATED</td></tr>' : '';
      return `${line}<tr class="${r.me ? 'me' : ''}${r.out ? ' out' : ''}"><td class="pos">${r.pos}</td><td><span class="sw" style="background:${sw(r)}"></span>${r.name.toUpperCase()}</td><td>${r.team.name}</td><td>${r.t == null ? '-' : U.fmtTime(r.t)}</td><td>${t}</td></tr>`;
    }).join('');
    const tbl = h('div');
    tbl.style.maxHeight = '56vh'; tbl.style.overflow = 'auto';
    tbl.innerHTML = `<table class="res"><tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>BEST LAP</th><th>GAP</th></tr>${rows}</table>`;
    wrap.appendChild(tbl);
    const acts = h('div', 'res-actions');
    const items = [];
    const mk = (t, fn) => { const b = h('div', 'btn', `<span>${t}</span><span class="arrow">&#8594;</span>`); acts.appendChild(b); items.push({ el: b, activate: fn }); };
    mk(o.next.label, o.next.fn);
    if (F1.Game.canReplay()) mk('WATCH REPLAY', () => F1.Game.watchReplay(() => F1.Game.backToResults(() => go('quali', o))));
    mk(o.round ? 'QUIT CHAMPIONSHIP' : 'QUIT WEEKEND', () => F1.Game.quitToMenu());
    wrap.appendChild(acts);
    el.appendChild(wrap);
    return { el, items, nav: 'h' };
  };

  function go(id, opts) { return show(id, S[id], opts); }

  function init() {
    UI.root = document.getElementById('screens');
  }

  F1.UI = { UI, init, go, hide, key, drawTrackMap, setFocus, FLAGS };
})(typeof window !== 'undefined' ? window : globalThis);
