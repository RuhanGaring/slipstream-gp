// Tyre shader tuning panel. F7 shows or hides it. Every value of the tyre's shader (js/r3-tyre.js
// SCHEMA), grouped, each with a slider and a number box (colours with a picker); changes show at once
// on every car. Double-click a value's name to put it back to its default; a dot marks values that
// differ from the defaults. Preview: pin the tyres' wear, show a compound, freeze the game.
// Save writes tyre-shader.json (all values) to the downloads folder, to be sent back and made the
// defaults; Load reads such a file back in. The values also stay in this browser between visits,
// until the defaults change.
(function (G) {
  'use strict';
  const F1 = G.F1, KEY = 'slip_tyretune';
  let panel = null;
  const T = () => F1.R3Tyre;
  // The scene's own values (not the tyres'): the ambient (shade) light every lit surface takes, a
  // multiplier on the sky and bounce light, and a lift added by a share of the surface's colour.
  const SC_SCHEMA = [
    // the tunnel's reflections, as multipliers of the level they stand at now (1 = as it is): the car's paint and the tyres, by day
    // and by night (the two blend with the time of day). The tyres' value is their own brightness, whatever the car's is.
    { group: 'Tunnel reflections (x current)', key: 'tunCarDay', label: 'Car, by day', type: 'f', min: 0, max: 4, step: 0.01, def: 1 },
    { group: 'Tunnel reflections (x current)', key: 'tunWheelDay', label: 'Wheels, by day', type: 'f', min: 0, max: 4, step: 0.01, def: 1 },
    { group: 'Tunnel reflections (x current)', key: 'tunCarNight', label: 'Car, at night', type: 'f', min: 0, max: 4, step: 0.01, def: 1 },
    { group: 'Tunnel reflections (x current)', key: 'tunWheelNight', label: 'Wheels, at night', type: 'f', min: 0, max: 4, step: 0.01, def: 1 },
    { group: 'Scene lighting', key: 'ambK', label: 'Ambient (shade) light', type: 'f', min: 0, max: 4, step: 0.01, def: 0.53, u: 'uAmbK' },
    { group: 'Scene lighting', key: 'ambAdd', label: 'Ambient lift (x colour)', type: 'f', min: 0, max: 1, step: 0.005, def: 0, u: 'uAmbAdd' },
    // the darks: what shades a car and the road round it
    { group: 'Shade and darks', key: 'carShadeAmt', label: 'Shadow under the car (strength)', type: 'f', min: 0, max: 1, step: 0.01, def: 1, post: 'a' },
    { group: 'Shade and darks', key: 'carShadeFloor', label: 'Shadow under the car (lightest it gets to black)', type: 'f', min: 0, max: 0.6, step: 0.005, def: 0.03, post: 'f' },
    { group: 'Shade and darks', key: 'carSelf', label: 'Car self-shade (its own sky cover)', type: 'f', min: 0, max: 1, step: 0.01, def: 0.7, u: 'uCarSelfK' },
    { group: 'Shade and darks', key: 'carAO', label: 'Car ground occlusion (darkening low on the car)', type: 'f', min: 0, max: 1.5, step: 0.01, def: 0.7, u: 'uCarAOK' },
    // auto exposure: the picture's brightness measured and eased toward a target, no part left too dark or bright
    { group: 'Auto exposure', key: 'autoExp', label: 'Strength (0 off)', type: 'f', min: 0, max: 1, step: 0.01, def: 0.1, q: 'autoExp' },
    { group: 'Auto exposure', key: 'aeKey', label: 'Target brightness', type: 'f', min: 0.05, max: 0.6, step: 0.005, def: 0.2, q: 'aeKey' },
    { group: 'Auto exposure', key: 'aeMin', label: 'Darkest it may go (x)', type: 'f', min: 0.2, max: 1, step: 0.01, def: 0.6, q: 'aeMin' },
    { group: 'Auto exposure', key: 'aeMax', label: 'Brightest it may go (x)', type: 'f', min: 1, max: 4, step: 0.01, def: 2.2, q: 'aeMax' },
    { group: 'Auto exposure', key: 'aeSpeed', label: 'Adapt speed', type: 'f', min: 0.1, max: 6, step: 0.05, def: 1.2, q: 'aeSpeed' },
    { group: 'Auto exposure', key: 'aeCenter', label: 'Weight to the middle of the picture', type: 'f', min: 0, max: 1, step: 0.01, def: 0.6, q: 'aeCenter' },
    { group: 'Shade and darks', key: 'blackLift', label: 'Shadow lift (the darkest values come up)', type: 'f', min: 0, max: 0.12, step: 0.001, def: 0.04, post: 'bl' },
    { group: 'Picture', key: 'contrast', label: 'Contrast', type: 'f', min: 0.7, max: 1.6, step: 0.01, def: 1.12, post: 'ct' },
    { group: 'Picture', key: 'pivot', label: 'Contrast pivot (what stays put)', type: 'f', min: 0.05, max: 0.8, step: 0.01, def: 0.43, post: 'pv' },
    // luminance-saturation curve: colour fades as brightness falls (and a little at the very top)
    { group: 'Lum-sat curve', key: 'lsDark', label: 'Saturation lost at black', type: 'f', min: 0, max: 1, step: 0.01, def: 0.45, post: 'ls' },
    { group: 'Lum-sat curve', key: 'lsKnee', label: 'Full colour from (brightness)', type: 'f', min: 0.05, max: 0.9, step: 0.01, def: 0.42, post: 'ls' },
    { group: 'Lum-sat curve', key: 'lsHigh', label: 'Saturation lost at white', type: 'f', min: 0, max: 1, step: 0.01, def: 0.15, post: 'ls' },
    { group: 'Lum-sat curve', key: 'lsHiStart', label: 'Highlight roll-off starts at', type: 'f', min: 0.4, max: 0.99, step: 0.01, def: 0.8, post: 'ls' },
    { group: 'Shade and darks', key: 'ckAlb', label: 'Cockpit interior brightness', type: 'f', min: 0.005, max: 0.2, step: 0.001, def: 0.014, u: 'uCkAlb' },
    { group: 'Shade and darks', key: 'ckAO', label: 'Cockpit well darkness', type: 'f', min: 0, max: 1, step: 0.01, def: 0.72, u: 'uCkAO' },
    { group: 'Shade and darks', key: 'ssao', label: 'Screen-space occlusion (corners, crevices)', type: 'f', min: 0, max: 1.5, step: 0.01, def: 0.6, post: 'ao' },
    // the grass (ground and blades alike, js/r3-shaders.js LAWN): its colour, then the patterns that vary it.
    // (defaults: a less saturated, slightly warm green; the old one read as a painted lawn)
    { group: 'Grass colour', key: 'gHue', label: 'Hue turn (- yellower, + bluer)', type: 'f', min: -40, max: 40, step: 0.5, def: -26.5, u: 'uGHue', c: 0 },
    { group: 'Grass colour', key: 'gSat', label: 'Saturation', type: 'f', min: 0, max: 2, step: 0.01, def: 0.77, u: 'uGHue', c: 1 },
    { group: 'Grass colour', key: 'gBright', label: 'Brightness', type: 'f', min: 0.3, max: 2, step: 0.01, def: 0.95, u: 'uGHue', c: 2 },
    { group: 'Grass colour', key: 'gWarm', label: 'Warmth (dry, sun-bleached)', type: 'f', min: -1, max: 1.5, step: 0.01, def: 0.67, u: 'uGHue', c: 3 },
    { group: 'Grass colour', key: 'gTint', label: 'Tint (multiplies)', type: 'c', def: '#ffffff', u: 'uGTint' },
    { group: 'Grass patterns', key: 'gPoa', label: 'Meadow grass clumps (paler, yellower)', type: 'f', min: 0, max: 3, step: 0.01, def: 1, u: 'uGAlgA', c: 0 },
    { group: 'Grass patterns', key: 'gFescue', label: 'Fescue clumps (finer, blue-green)', type: 'f', min: 0, max: 3, step: 0.01, def: 1, u: 'uGAlgA', c: 1 },
    { group: 'Grass patterns', key: 'gClover', label: 'Clover and weed spots', type: 'f', min: 0, max: 3, step: 0.01, def: 1, u: 'uGAlgA', c: 2 },
    { group: 'Grass patterns', key: 'gYellow', label: 'Yellow dry patches', type: 'f', min: 0, max: 1.1, step: 0.01, def: 1, u: 'uGAlgA', c: 3 },
    { group: 'Grass patterns', key: 'gDrought', label: 'Drought stress (crests, slopes go straw)', type: 'f', min: 0, max: 3, step: 0.01, def: 1, u: 'uGAlgB', c: 0 },
    { group: 'Grass patterns', key: 'gWear', label: 'Wear beside the track (toward soil)', type: 'f', min: 0, max: 2.2, step: 0.01, def: 1, u: 'uGAlgB', c: 1 },
    { group: 'Grass patterns', key: 'gEdge', label: 'Worn strip at the tarmac edge', type: 'f', min: 0, max: 1.33, step: 0.01, def: 1, u: 'uGAlgB', c: 2 },
    { group: 'Grass patterns', key: 'gField', label: 'Field patchwork (big uneven patches)', type: 'f', min: 0, max: 2, step: 0.01, def: 1, u: 'uGAlgB', c: 3 },
    { group: 'Grass patterns', key: 'gClump', label: 'Clump size (x)', type: 'f', min: 0.2, max: 5, step: 0.05, def: 1, u: 'uGAlgC', c: 0 },
    { group: 'Grass patterns', key: 'gYSize', label: 'Yellow patch size (x)', type: 'f', min: 0.2, max: 5, step: 0.05, def: 1, u: 'uGAlgC', c: 1 },
    { group: 'Grass patterns', key: 'gStripes', label: 'Mowing stripes', type: 'f', min: 0, max: 4, step: 0.01, def: 1, u: 'uGAlgC', c: 2 },
    { group: 'Grass patterns', key: 'gVar', label: 'All variation (x)', type: 'f', min: 0, max: 2, step: 0.01, def: 1, u: 'uGAlgC', c: 3 },
    { group: 'Grass from afar', key: 'gTuft', label: 'Tuft light and dark', type: 'f', min: 0, max: 3, step: 0.01, def: 1, u: 'uGFar', c: 0 },
    { group: 'Grass from afar', key: 'gGust', label: 'Wind gust bands', type: 'f', min: 0, max: 5, step: 0.01, def: 1, u: 'uGFar', c: 1 },
    { group: 'Grass from afar', key: 'gSheen', label: 'Low-sun sheen', type: 'f', min: 0, max: 5, step: 0.01, def: 1, u: 'uGFar', c: 2 },
    { group: 'Grass from afar', key: 'gMoist', label: 'Wet and dry ground swing', type: 'f', min: 0, max: 3, step: 0.01, def: 1, u: 'uGFar', c: 3 },
  ];
  const SC = { SCHEMA: SC_SCHEMA, DEFAULTS: Object.fromEntries(SC_SCHEMA.map(d => [d.key, d.def])), values: Object.fromEntries(SC_SCHEMA.map(d => [d.key, d.def])),
    set(o) { const U = F1.R3S && F1.R3S.U; for (const d of SC_SCHEMA) { if (!o || o[d.key] == null) continue; this.values[d.key] = d.type === 'c' ? String(o[d.key]) : +o[d.key];
        const uu = U && d.u && U[d.u]; if (!uu) continue;
        if (d.type === 'c') uu.value.set(this.values[d.key]); else if (d.c != null) uu.value.setComponent(d.c, this.values[d.key]); else uu.value = this.values[d.key]; }
      const P = F1.R3Post; if (P && P.Q) for (const d of SC_SCHEMA) if (d.q) P.Q[d.q] = this.values[d.key];
      if (P) { P.setCarShade(this.values.carShadeAmt, this.values.carShadeFloor); if (P.setBlackLift) P.setBlackLift(this.values.blackLift); if (P.setContrast) P.setContrast(this.values.contrast, this.values.pivot); if (P.setLumSat) P.setLumSat(this.values.lsDark, this.values.lsKnee, this.values.lsHigh, this.values.lsHiStart); if (P.Q) P.Q.aoK = this.values.ssao; } } };
  const baseOf = () => JSON.stringify([T().DEFAULTS, Object.fromEntries(Object.entries(SC.DEFAULTS).filter(([k]) => !/^tun(Car|Wheel)/.test(k)))]);
  const store = () => { try { localStorage.setItem(KEY, JSON.stringify({ base: baseOf(), values: T().values, scene: SC.values })); } catch (e) {} };
  // the values kept from last time, unless the defaults have changed since
  function restore() {
    if (!T()) return;
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && o.base === baseOf() && o.values) { T().set(o.values); SC.set(o.scene); }
    } catch (e) {}
  }

  const CSS = `
  #tytune { position: fixed; top: 10px; right: 10px; width: 360px; max-height: calc(100vh - 20px); overflow: auto; z-index: 99999;
    background: rgba(12,14,18,0.95); color: #e6e8eb; font: 12px/1.35 system-ui, "Segoe UI", sans-serif; border: 1px solid #2c323a;
    border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
  #tytune header { position: sticky; top: 0; background: #12161c; padding: 10px 12px 8px; border-bottom: 1px solid #2c323a; z-index: 1; }
  #tytune h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; letter-spacing: 0.02em; display: flex; justify-content: space-between; align-items: center; }
  #tytune h3 small { font-weight: 400; color: #8a939e; }
  #tytune .tt-bar { display: flex; flex-wrap: wrap; gap: 6px; }
  #tytune button { background: #232a33; color: #e6e8eb; border: 1px solid #3a434e; border-radius: 5px; padding: 4px 9px; font: inherit; cursor: pointer; }
  #tytune button:hover { background: #2d3641; }
  #tytune button.tt-main { background: #1f6feb; border-color: #1f6feb; }
  #tytune button.tt-on { background: #3a434e; border-color: #8a939e; }
  #tytune details { border-bottom: 1px solid #222830; }
  #tytune summary { padding: 8px 12px; cursor: pointer; font-weight: 600; color: #c9d1d9; user-select: none; }
  #tytune .tt-rows { padding: 2px 12px 10px; }
  #tytune .tt-row { display: grid; grid-template-columns: 1fr 96px 62px; gap: 6px; align-items: center; margin: 4px 0; }
  #tytune .tt-row.tt-c { grid-template-columns: 1fr 40px 118px; }
  #tytune .tt-row label { color: #aeb6bf; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #tytune .tt-row label.tt-chg::before { content: '\\25CF  '; color: #f0b429; }
  #tytune input[type=range] { width: 96px; }
  #tytune input[type=number], #tytune input[type=text] { width: 100%; box-sizing: border-box; background: #0b0d10; color: #e6e8eb; border: 1px solid #333b45; border-radius: 4px; padding: 2px 4px; font: inherit; }
  #tytune input[type=color] { width: 40px; height: 22px; padding: 0; border: 1px solid #333b45; background: none; }
  #tytune .tt-note { color: #8a939e; padding: 6px 12px 10px; }
  #tytune .tt-msg { color: #7ee787; min-height: 1em; margin-top: 6px; }`;

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    panel = document.createElement('div'); panel.id = 'tytune';
    // (typing in the panel must not drive the car)
    for (const ev of ['keydown', 'keyup', 'keypress']) panel.addEventListener(ev, e => { if (e.code !== 'F7') e.stopPropagation(); });
    panel.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    const head = document.createElement('header');
    head.innerHTML = '<h3>Tyre shader <small>F7 hides</small></h3><div class="tt-bar"></div><div class="tt-msg"></div>';
    const bar = head.querySelector('.tt-bar'), msg = head.querySelector('.tt-msg');
    const say = t => { msg.textContent = t; clearTimeout(say.t); say.t = setTimeout(() => { msg.textContent = ''; }, 4000); };
    const btn = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; bar.appendChild(b); return b; };
    const file = () => JSON.stringify({ kind: 'slipstream-shader-tuning', version: 2, saved: new Date().toISOString(), values: T().values, scene: SC.values }, null, 2);
    btn('Save file', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([file()], { type: 'application/json' }));
      a.download = 'tyre-shader.json'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      say('Saved tyre-shader.json to your downloads.');
    }, 'tt-main');
    const pick = document.createElement('input'); pick.type = 'file'; pick.accept = '.json,application/json'; pick.style.display = 'none';
    pick.onchange = () => {
      const f = pick.files && pick.files[0]; if (!f) return;
      f.text().then(t => { const o = JSON.parse(t); T().set(o.values || o); if (o.scene) SC.set(o.scene); store(); refresh(); say('Loaded ' + f.name + '.'); }).catch(() => say('That file could not be read.'));
      pick.value = '';
    };
    head.appendChild(pick);
    btn('Load file', () => pick.click());
    btn('Copy', () => { navigator.clipboard.writeText(file()).then(() => say('Copied the values.'), () => say('Copy was blocked; use Save file.')); });
    btn('Reset all', () => { T().set(T().DEFAULTS); SC.set(SC.DEFAULTS); store(); refresh(); say('Back to the defaults.'); });
    panel.appendChild(head);

    // preview: wear, compound, freeze
    const pv = document.createElement('details'); pv.open = true;
    pv.innerHTML = '<summary>Preview (not saved)</summary><div class="tt-rows"></div>';
    const pr = pv.querySelector('.tt-rows');
    {
      const row = document.createElement('div'); row.className = 'tt-row';
      row.innerHTML = '<label>Wear (0 new, 1 spent)</label><input type="range" min="0" max="1" step="0.01"><label style="display:flex;gap:4px;align-items:center"><input type="checkbox"> live</label>';
      const [rg, cb] = row.querySelectorAll('input');
      const sync = () => { G.__tyWear = cb.checked ? null : +rg.value; };
      cb.checked = G.__tyWear == null; rg.value = G.__tyWear != null ? G.__tyWear : 0;
      rg.oninput = () => { cb.checked = false; sync(); }; cb.onchange = sync;
      pr.appendChild(row);
    }
    {
      const row = document.createElement('div'); row.className = 'tt-bar'; row.style.margin = '6px 0';
      const lab = document.createElement('span'); lab.textContent = 'Compound:'; lab.style.cssText = 'color:#aeb6bf;align-self:center;margin-right:4px'; row.appendChild(lab);
      for (const [id, name] of [['S', 'Soft'], ['M', 'Medium'], ['H', 'Hard']]) {
        const b = document.createElement('button'); b.textContent = name;
        b.onclick = () => { for (const m of (F1.R3 && F1.R3.carModels ? F1.R3.carModels.values() : [])) { const u = m.userData.body && m.userData.body.userData; if (u && u.tyComp) u.tyComp.value.copy(T().compColor(id)); } say(name + ' markings on every car (until a pit stop changes them).'); };
        row.appendChild(b);
      }
      const fz = document.createElement('button'); fz.textContent = 'Freeze game';
      fz.onclick = () => { const g = G.__game && G.__game.Game; if (!g) return; g.paused = !g.paused; fz.classList.toggle('tt-on', g.paused); };
      row.appendChild(fz);
      pr.appendChild(row);
    }
    panel.appendChild(pv);

    // the values, by group
    const inputs = [];
    const groups = new Map();
    for (const [A, d] of SC_SCHEMA.map(x => [SC, x]).concat(T().SCHEMA.map(x => [T(), x]))) {
      if (!groups.has(d.group)) {
        const g = document.createElement('details'); g.open = groups.size < 2;
        g.innerHTML = `<summary>${d.group}</summary><div class="tt-rows"></div>`;
        panel.appendChild(g); groups.set(d.group, g.querySelector('.tt-rows'));
      }
      const row = document.createElement('div'); row.className = 'tt-row' + (d.type === 'c' ? ' tt-c' : '');
      const lab = document.createElement('label'); lab.textContent = d.label; lab.title = d.key + ' (double-click: default ' + d.def + ')';
      row.appendChild(lab);
      const put = v => { A.set({ [d.key]: v }); store(); show(); };
      let show;
      if (d.type === 'c') {
        const col = document.createElement('input'); col.type = 'color';
        const hex = document.createElement('input'); hex.type = 'text'; hex.spellcheck = false;
        col.oninput = () => put(col.value);
        hex.onchange = () => { const v = hex.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) put(v[0] === '#' ? v : '#' + v); else show(); };
        show = () => { const v = A.values[d.key]; col.value = v; hex.value = v; lab.classList.toggle('tt-chg', v.toLowerCase() !== String(d.def).toLowerCase()); };
        row.append(col, hex);
      } else {
        const rg = document.createElement('input'); rg.type = 'range'; rg.min = d.min; rg.max = d.max; rg.step = d.step;
        const nb = document.createElement('input'); nb.type = 'number'; nb.step = d.step;
        rg.oninput = () => put(+rg.value);
        nb.onchange = () => { if (nb.value !== '' && isFinite(+nb.value)) put(+nb.value); else show(); };
        show = () => { const v = A.values[d.key]; rg.value = v; nb.value = +(+v).toFixed(5); lab.classList.toggle('tt-chg', Math.abs(v - d.def) > 1e-9); };
        row.append(rg, nb);
      }
      lab.ondblclick = () => put(d.def);
      inputs.push(show); show();
      groups.get(d.group).appendChild(row);
    }
    const note = document.createElement('div'); note.className = 'tt-note';
    note.textContent = 'Save file, then send tyre-shader.json back to have these made the defaults.';
    panel.appendChild(note);
    panel.refresh = () => inputs.forEach(f => f());
    document.body.appendChild(panel);
  }
  function refresh() { if (panel) panel.refresh(); }
  function toggle() {
    if (!T()) return;
    if (!panel) build(); else panel.style.display = panel.style.display === 'none' ? '' : 'none';
    refresh();
  }

  G.addEventListener('keydown', e => { if (e.code === 'F7' && !e.repeat) { e.preventDefault(); toggle(); } });
  // (the post stack's occlusion strength is also set from the game's own Occlusion strength setting
  // each time the quality is applied: the panel's value is applied after that, so it stands)
  { const P = F1.R3Post; if (P && P.setQuality) { const sq = P.setQuality; P.setQuality = function () { const r = sq.apply(this, arguments); if (P.Q) P.Q.aoK = SC.values.ssao; return r; }; } }
  SC.set(SC.DEFAULTS); // (defaults applied: the post stack's and the shade's values live outside this file)
  restore();
  F1.TyreTune = { toggle, restore, sc: SC.values };
})(window);
