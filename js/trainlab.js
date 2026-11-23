// The AI training lab: full training of the AI on a generated circuit, with everything it does shown.
// Opens from the circuit generator (Train AI) and from a saved circuit. The work itself is
// F1.LearnJob.startDeep (js/learnjob.js, js/learncore.js): a longer racing-line search, a longer grip-limits
// search, then the coach, which drives the plan stretch by stretch and keeps what is quicker and clean.
// Here: the live map (racing line, learned grip, trouble spots, coach changes, a replay of the lap just
// driven), charts (lap time per round, planned and driven speed, grip window), the four steps with
// their progress, a log, and the controls (preset or your own settings, start, stop and keep,
// train further, reset). Hover the map or a chart to read a point on the other; click the map to pin it.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const LJ = () => F1.LearnJob;
  const $ = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtT = t => (t == null || !isFinite(t) ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0'));
  const fmtClock = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const STEPS = [['line', 'Racing line', 'Kept as learned, or searched if there is none'], ['limits', 'Grip limits', 'Test cars find where each corner lets go'], ['coach', 'Coaching', 'Drives the plan, keeps what is quicker'], ['verify', 'Final check', 'A clean lap on the finished plan']];
  const PHASE_AT = { line: 0, limits: 1, coach: 2, verify: 3 };

  const CSS = `
  .tl { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; background: rgba(6,7,10,.97); color: #fff; font-family: var(--font, 'Titillium Web', sans-serif); user-select: none; }
  .tl * { box-sizing: border-box; }
  .tl-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 22px; border-bottom: 2px solid var(--f1, #e10600); background: linear-gradient(180deg, rgba(25,25,34,.95), rgba(14,14,20,.95)); }
  .tl-head h1 { margin: 0; font-size: 13px; letter-spacing: .22em; font-weight: 800; color: var(--m-ink-3, #9a9aa8); }
  .tl-head h2 { margin: 2px 0 0; font-size: 26px; font-weight: 900; font-style: italic; letter-spacing: .01em; text-transform: uppercase; overflow-wrap: anywhere; }
  .tl-head small { display: block; margin-top: 2px; font-size: 12px; letter-spacing: .12em; color: var(--m-ink-3, #9a9aa8); font-weight: 700; }
  .tl-x { all: unset; box-sizing: border-box; cursor: pointer; padding: 10px 18px; font-weight: 800; font-size: 13px; letter-spacing: .14em; background: #fff; color: #111; text-transform: uppercase; flex: none; }
  .tl-x:hover { background: var(--f1, #e10600); color: #fff; }
  .tl-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr); gap: 14px; padding: 14px 22px 18px; }
  .tl-col { min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; scrollbar-width: thin; }
  .tl-card { background: var(--carbon, rgba(18,18,26,.84)); border: 1px solid rgba(255,255,255,.08); padding: 10px 14px 12px; min-width: 0; }
  .tl-card h3 { margin: 0 0 8px; font-size: 12px; font-weight: 800; letter-spacing: .18em; color: var(--m-ink-3, #9a9aa8); text-transform: uppercase; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .tl-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .tl-chip { all: unset; box-sizing: border-box; cursor: pointer; padding: 5px 11px; font-size: 12px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; background: rgba(255,255,255,.07); color: #c9cad4; }
  .tl-chip:hover { background: rgba(255,255,255,.16); color: #fff; }
  .tl-chip.on { background: #fff; color: #111; }
  .tl-chip:focus-visible, .tl-x:focus-visible, .tl-btn:focus-visible { outline: 2px solid var(--f1, #e10600); outline-offset: 2px; }
  .tl-mapcard { flex: 1 1 auto; min-height: 280px; display: flex; flex-direction: column; }
  .tl-map { position: relative; flex: 1; min-height: 220px; background: rgba(0,0,0,.3); cursor: crosshair; }
  .tl-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .tl-tip { position: absolute; pointer-events: none; z-index: 3; min-width: 150px; padding: 7px 10px; font-size: 12px; line-height: 1.45; background: rgba(8,8,12,.94); border: 1px solid rgba(255,255,255,.25); display: none; white-space: nowrap; }
  .tl-tip b { font-weight: 800; letter-spacing: .06em; } .tl-tip span { color: var(--m-ink-3, #9a9aa8); }
  .tl-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; margin-top: 8px; font-size: 12px; color: #c9cad4; min-height: 18px; }
  .tl-legend i { display: inline-block; width: 26px; height: 8px; margin-right: 6px; vertical-align: 0; }
  .tl-chart { height: 190px; position: relative; flex: none; }
  .tl-chart canvas { width: 100%; height: 100%; display: block; background: rgba(0,0,0,.25); cursor: crosshair; }
  .tl-hint { position: absolute; inset: 0; display: grid; place-items: center; color: var(--m-ink-3, #9a9aa8); font-size: 13px; text-align: center; padding: 0 20px; pointer-events: none; }
  .tl-big { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; }
  .tl-pct { font-size: 54px; font-weight: 900; font-style: italic; line-height: .9; font-variant-numeric: tabular-nums; }
  .tl-pct small { font-size: 22px; margin-left: 2px; }
  .tl-what { font-size: 14px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; text-align: right; }
  .tl-what small { display: block; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: var(--m-ink-3, #9a9aa8); text-transform: none; }
  .tl-bar { height: 8px; background: rgba(255,255,255,.1); margin: 10px 0 8px; overflow: hidden; }
  .tl-bar i { display: block; height: 100%; width: 100%; background: var(--f1, #e10600); transform: scaleX(0); transform-origin: left; transition: transform .25s; }
  .tl-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .tl-stats div { background: rgba(255,255,255,.05); padding: 6px 8px; min-width: 0; }
  .tl-stats b { display: block; font-size: 18px; font-weight: 900; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tl-stats span { font-size: 10px; letter-spacing: .12em; color: var(--m-ink-3, #9a9aa8); font-weight: 700; text-transform: uppercase; }
  .tl-step { display: grid; grid-template-columns: 26px 1fr auto; gap: 4px 10px; align-items: center; padding: 7px 0; border-top: 1px solid rgba(255,255,255,.07); }
  .tl-step:first-of-type { border-top: 0; }
  .tl-step u { grid-row: span 2; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 900; text-decoration: none; background: rgba(255,255,255,.1); color: #c9cad4; }
  .tl-step.act u { background: var(--f1, #e10600); color: #fff; box-shadow: 0 0 0 4px rgba(225,6,0,.25); animation: tl-pulse 1.4s infinite; }
  .tl-step.done u { background: #2bd66b; color: #06210f; }
  .tl-step b { font-size: 14px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
  .tl-step small { grid-column: 2 / 4; font-size: 12px; color: var(--m-ink-3, #9a9aa8); }
  .tl-step em { font-style: normal; font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; color: #c9cad4; }
  .tl-step .tl-sbar { grid-column: 2 / 4; height: 3px; background: rgba(255,255,255,.1); } .tl-sbar i { display: block; height: 100%; width: 100%; background: #fff; transform: scaleX(0); transform-origin: left; transition: transform .25s; }
  .tl-step.done .tl-sbar i { background: #2bd66b; }
  @keyframes tl-pulse { 50% { box-shadow: 0 0 0 7px rgba(225,6,0,.05); } }
  .tl-set { display: grid; grid-template-columns: 1fr 52px; gap: 4px 10px; align-items: center; margin-top: 8px; font-size: 13px; }
  .tl-set label { color: #c9cad4; } .tl-set output { text-align: right; font-weight: 800; font-variant-numeric: tabular-nums; }
  .tl-set input[type=range] { grid-column: 1 / 3; width: 100%; accent-color: var(--f1, #e10600); margin: 0 0 4px; }
  .tl-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .tl-btn { all: unset; box-sizing: border-box; cursor: pointer; flex: 1 1 auto; text-align: center; padding: 11px 16px; font-weight: 900; font-size: 14px; letter-spacing: .12em; text-transform: uppercase; background: #fff; color: #111; }
  .tl-btn:hover { background: #e9e9ef; } .tl-btn.go { background: var(--f1, #e10600); color: #fff; } .tl-btn.go:hover { background: #ff2a22; }
  .tl-btn.alt { background: rgba(255,255,255,.1); color: #fff; } .tl-btn.alt:hover { background: rgba(255,255,255,.2); }
  .tl-btn[hidden], .tl-set[hidden], .tl-chips[hidden] { display: none; }
  .tl-res { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; text-align: center; }
  .tl-res b { display: block; font-size: 26px; font-weight: 900; font-style: italic; font-variant-numeric: tabular-nums; } .tl-res span { font-size: 11px; letter-spacing: .12em; color: var(--m-ink-3, #9a9aa8); font-weight: 700; text-transform: uppercase; }
  .tl-res .arrow { font-size: 22px; color: var(--m-ink-3, #9a9aa8); } .tl-res .good b { color: #2bd66b; }
  .tl-note { margin-top: 8px; font-size: 12px; color: var(--m-ink-3, #9a9aa8); line-height: 1.4; }
  .tl-log { flex: 1 1 140px; min-height: 120px; overflow-y: auto; scrollbar-width: thin; font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums; }
  .tl-log div { padding: 1px 0; color: #c9cad4; } .tl-log div i { font-style: normal; color: var(--m-ink-3, #9a9aa8); margin-right: 8px; }
  .tl-log .ok { color: #7ee79b; } .tl-log .warn { color: #ffcc1f; } .tl-log .bad { color: #ff6a5f; }
  @media (max-width: 900px) { .tl-body { grid-template-columns: 1fr; overflow-y: auto; } .tl-col { overflow: visible; } .tl-mapcard { min-height: 300px; } .tl-pct { font-size: 42px; } .tl-head h2 { font-size: 20px; } .tl-stats { grid-template-columns: repeat(2, 1fr); } }
  `;

  // ---------- helpers ----------
  const expand = (L, N, st) => { const o = new Float64Array(N); for (let i = 0; i < N; i++) { const f = i / st, k = Math.floor(f) % L.length, t = f - Math.floor(f); o[i] = L[k] + (L[(k + 1) % L.length] - L[k]) * t; } return o; };
  const gripCol = v => `hsl(${Math.round(120 * clamp((v - 0.85) / 0.5, 0, 1))},85%,52%)`;
  const coachCol = f => { const d = clamp((f - 1) / 0.12, -1, 1); return d >= 0 ? `hsl(${Math.round(55 + 65 * d)},80%,${50 - 4 * d}%)` : `hsl(${Math.round(30 + 30 * d)},90%,${55 + 6 * d}%)`; };

  let styled = false, current = null;

  class Lab {
    constructor(id, opts) {
      this.id = id; this.opts = opts || {};
      this.tr = F1.Race.getTrack(id);
      this.N = this.tr.N;
      this.view = null; // null: follows the step the training is on
      this.tab = null;
      this.hover = null; this.pin = null;
      this.replay = { speed: 4, on: true, t: 0, last: 0 };
      this.dirty = { base: true, panel: true, chart: true };
      this.planCache = null;
      this.preset = 'standard';
      this.custom = Object.assign({}, LJ().PRESETS.standard);
      this.build();
      this.offDeep = LJ().onDeep(() => { this.dirty.base = this.dirty.panel = this.dirty.chart = true; });
      this.keyFn = e => {
        if (e.code === 'Escape' && e.type === 'keydown') this.close();
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'range') return; // (arrows move a slider)
        e.stopImmediatePropagation(); if (e.code !== 'F5' && e.code !== 'F12') e.preventDefault();
      };
      G.addEventListener('keydown', this.keyFn, true); G.addEventListener('keyup', this.keyFn, true);
      this.resize = () => { this.dirty.base = this.dirty.chart = true; };
      G.addEventListener('resize', this.resize);
      this.raf = requestAnimationFrame(t => this.frame(t));
    }
    close() {
      if (current !== this) return;
      current = null;
      cancelAnimationFrame(this.raf);
      this.offDeep();
      G.removeEventListener('keydown', this.keyFn, true); G.removeEventListener('keyup', this.keyFn, true);
      G.removeEventListener('resize', this.resize);
      this.el.remove();
      if (this.opts.onClose) this.opts.onClose();
    }

    // ---------- layout ----------
    build() {
      if (!styled) { const st = $('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
      const def = F1.Tracks.byId ? F1.Tracks.byId(this.id) : null;
      const name = (F1.MapNames && F1.MapNames[this.id]) || (def && def.name) || this.id;
      const el = this.el = $('div', 'tl');
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'AI training lab');
      el.innerHTML = `<div class="tl-head"><div><h1>AI TRAINING LAB</h1><h2></h2><small></small></div><button class="tl-x">Close (Esc)</button></div>
        <div class="tl-body">
          <div class="tl-col">
            <div class="tl-card tl-mapcard">
              <h3><span>Track map</span><span class="tl-chips" data-k="views"></span></h3>
              <div class="tl-map"><canvas class="b"></canvas><canvas class="o"></canvas><div class="tl-tip"></div></div>
              <div class="tl-legend"></div>
            </div>
            <div class="tl-card">
              <h3><span>Telemetry</span><span class="tl-chips" data-k="tabs"></span></h3>
              <div class="tl-chart"><canvas></canvas><div class="tl-hint"></div></div>
            </div>
          </div>
          <div class="tl-col">
            <div class="tl-card" data-k="status">
              <div class="tl-big"><div class="tl-pct"><span data-k="pct">0</span><small>%</small></div><div class="tl-what"><span data-k="what"></span><small data-k="sub"></small></div></div>
              <div class="tl-bar"><i></i></div>
              <div class="tl-stats"><div><b data-k="elapsed">0:00</b><span>Elapsed</span></div><div><b data-k="eta">--</b><span>Left</span></div><div><b data-k="threads">0</b><span>Threads</span></div><div><b data-k="laps">0</b><span>Test laps</span></div></div>
            </div>
            <div class="tl-card" data-k="steps"><h3>Steps</h3></div>
            <div class="tl-card" data-k="result" hidden><h3>What the AI gained</h3><div class="tl-res"></div><div class="tl-note"></div></div>
            <div class="tl-card" data-k="ctl">
              <h3>Training</h3>
              <div class="tl-chips" data-k="presets"></div>
              <div class="tl-set" data-k="set"></div>
              <div class="tl-note" data-k="est"></div>
              <div class="tl-btns"><button class="tl-btn go" data-k="start"></button><button class="tl-btn alt" data-k="more" hidden>Train further</button><button class="tl-btn alt" data-k="stop" hidden>Stop and keep best</button><button class="tl-btn alt" data-k="reset" hidden>Reset training</button></div>
            </div>
            <div class="tl-card" style="display:flex;flex-direction:column;min-height:150px"><h3>What the AI is doing</h3><div class="tl-log" data-k="log"></div></div>
          </div>
        </div>`;
      const q = k => el.querySelector(`[data-k="${k}"]`);
      this.q = q;
      el.querySelector('h2').textContent = name;
      el.querySelector('small').textContent = `${(this.tr.L / 1000).toFixed(2)} KM  /  ${this.tr.apexes ? this.tr.apexes.length : '?'} CORNERS`;
      el.querySelector('.tl-x').onclick = () => this.close();
      document.body.appendChild(el);
      // map layers
      this.viewDefs = [['line', 'Racing line'], ['grip', 'Grip'], ['trouble', 'Trouble'], ['coach', 'Coach'], ['live', 'Lap']];
      const vc = q('views');
      this.viewBtns = this.viewDefs.map(([k, label]) => { const b = $('button', 'tl-chip', label); b.onclick = () => { this.view = this.view === k ? null : k; this.dirty.base = true; }; vc.appendChild(b); return b; });
      this.rp = $('button', 'tl-chip', 'Replay x4'); this.rp.title = 'Click: speed. The car shown is the last lap the coach drove.';
      this.rp.onclick = () => { const s = [1, 4, 12, 0][([1, 4, 12, 0].indexOf(this.replay.speed) + 1) % 4]; this.replay.speed = s; this.replay.on = s > 0; this.dirty.panel = true; };
      vc.appendChild(this.rp);
      // chart tabs
      this.tabDefs = [['lap', 'Lap time'], ['speed', 'Speed'], ['grip', 'Grip window'], ['line', 'Line search']];
      const tc = q('tabs');
      this.tabBtns = this.tabDefs.map(([k, label]) => { const b = $('button', 'tl-chip', label); b.onclick = () => { this.tab = this.tab === k ? null : k; this.dirty.chart = true; }; tc.appendChild(b); return b; });
      // steps
      const stepsEl = q('steps');
      this.stepEls = STEPS.map(([k, t, d], n) => {
        const e = $('div', 'tl-step', `<u>${n + 1}</u><b>${t}</b><em></em><small>${d}</small><div class="tl-sbar"><i></i></div>`);
        stepsEl.appendChild(e); return e;
      });
      // presets and own settings
      const pc = q('presets');
      this.presetBtns = Object.entries(LJ().PRESETS).map(([k, P]) => { const b = $('button', 'tl-chip', P.label); b.onclick = () => { this.preset = k; this.custom = Object.assign({}, P); this.syncSet(); }; pc.appendChild(b); return [k, b]; });
      const set = q('set');
      this.sets = [['gens', 'Grip search generations', 3, 9], ['checks', 'Grip check laps', 3, 10], ['coachRounds', 'Coach rounds', 4, 48]].map(([k, label, a, b]) => {
        const l = $('label', null, label), o = $('output'), r = $('input'); r.type = 'range'; r.min = a; r.max = b; r.step = 1; r.setAttribute('aria-label', label);
        r.oninput = () => { this.custom[k] = +r.value; this.preset = null; this.syncSet(); };
        set.append(l, o, r); return { k, r, o };
      });
      q('start').onclick = () => this.start(false);
      q('more').onclick = () => this.start(true);
      q('stop').onclick = () => LJ().stopDeep();
      q('reset').onclick = () => { if (!this.confirmReset) { this.confirmReset = true; q('reset').textContent = 'Click again to reset'; setTimeout(() => { this.confirmReset = false; this.dirty.panel = true; }, 3000); return; } this.confirmReset = false; LJ().resetDeep(this.id); this.dirty.base = this.dirty.panel = this.dirty.chart = true; };
      // map interaction
      const map = el.querySelector('.tl-map');
      this.mapEl = map; this.cb = map.querySelector('.b'); this.co = map.querySelector('.o'); this.tip = map.querySelector('.tl-tip');
      const at = e => { const r = map.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      map.addEventListener('mousemove', e => { const [x, y] = at(e); this.hover = this.nearest(x, y); this.moveTip(x, y); });
      map.addEventListener('mouseleave', () => { this.hover = null; this.tip.style.display = 'none'; });
      map.addEventListener('click', e => { const [x, y] = at(e); const i = this.nearest(x, y); this.pin = this.pin != null && Math.abs(this.pin - i) < 12 ? null : i; });
      map.addEventListener('touchstart', e => { const t = e.touches[0], r = map.getBoundingClientRect(); this.pin = this.nearest(t.clientX - r.left, t.clientY - r.top); }, { passive: true });
      // chart interaction
      this.cc = el.querySelector('.tl-chart canvas'); this.hint = el.querySelector('.tl-hint');
      this.cc.addEventListener('mousemove', e => { const r = this.cc.getBoundingClientRect(), f = (e.clientX - r.left - this.plotL) / (r.width - this.plotL - this.plotR); this.chartHover = clamp(f, 0, 1); if (this.chartDist) this.hover = Math.round(this.chartHover * (this.N - 1)); });
      this.cc.addEventListener('mouseleave', () => { this.chartHover = null; this.hover = null; });
      this.plotL = 44; this.plotR = 10;
      this.syncSet();
    }
    syncSet() {
      for (const { k, r, o } of this.sets) { r.value = this.custom[k]; o.textContent = this.custom[k]; }
      for (const [k, b] of this.presetBtns) b.classList.toggle('on', this.preset === k);
      this.dirty.panel = true;
    }
    start(resume) {
      const cfg = Object.assign({}, this.custom, { resume });
      this.view = null; this.tab = null; this.pin = null;
      LJ().startDeep(this.id, cfg);
    }

    // ---------- data ----------
    data() {
      const id = this.id, N = this.N, j = LJ().deepOf(id), D = { j };
      const Lm = F1.Limits && F1.Limits[id], Ln = F1.Lines && F1.Lines[id];
      D.info = LJ().deepInfo(id);
      D.off = j && j.off ? Float64Array.from(j.off) : Ln ? expand(Ln, N, 2) : null;
      D.lo = j && j.gens && j.gens.sim ? Float64Array.from(j.gens.sim.lo) : null;
      D.hi = j && j.gens && j.gens.sim ? Float64Array.from(j.gens.sim.hi) : null;
      D.bad = null;
      if (j && j.gens) { const a = j.gens.sim, b = j.gens.arcade; if (a || b) { D.bad = new Uint8Array(N); for (const g of [a, b]) if (g) for (let i = 0; i < N; i++) if (g.bad[i]) D.bad[i] = 1; } }
      const st = F1.Limits && F1.Limits.stride || 5;
      D.learned = Lm && Lm.sim ? expand(Lm.sim, N, st) : null;
      D.learnedB = null;
      const src = j && j.C ? { C: j.C, B: j.B, segEnd: j.coachInfo && j.coachInfo.segEnd } : D.info && D.info.C ? D.info : null;
      D.coach = src && src.segEnd ? src : null;
      if (D.coach && D.coach.segEnd !== this.segSrc) {
        this.segSrc = D.coach.segEnd; const se = D.coach.segEnd, n = se.length; this.segAt = new Int16Array(N);
        for (let i = 0; i < N; i++) { const s = i * this.tr.ds; let k = 0; while (k < n - 1 && s >= se[k]) k++; this.segAt[i] = k; }
      }
      D.lap = j && j.lap && j.lap.ts ? j.lap : null;
      D.plan = D.lap ? Float64Array.from(D.lap.plan) : this.idlePlan(D);
      return D;
    }
    // what the plan stands at now, from the stored limits (no lap driven this visit)
    idlePlan(D) {
      if (!D.learned) return null;
      const key = F1.Limits[this.id].sim;
      if (this.planCache && this.planCache.key === key) return this.planCache.v;
      let v = null;
      try { const tr = F1.Race.getTrack(this.id); v = F1.Raceline.speedProfile(tr, tr.line, F1.Car.SPEC, F1.Race.planOpts(tr, true, 1)); } catch (e) { v = null; }
      this.planCache = { key, v }; return v;
    }
    phase(D) {
      const j = D.j;
      if (j && j.state === 'running') return j.phase;
      if (j && (j.state === 'done' || j.state === 'stopped')) return 'done';
      return D.info ? 'done' : 'idle';
    }

    // ---------- the map ----------
    geom() {
      const cv = this.cb, W = this.mapEl.clientWidth || 600, H = this.mapEl.clientHeight || 300, tr = this.tr, N = this.N;
      let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
      for (let i = 0; i < N; i++) { mnx = Math.min(mnx, tr.x[i]); mny = Math.min(mny, tr.y[i]); mxx = Math.max(mxx, tr.x[i]); mxy = Math.max(mxy, tr.y[i]); }
      const pad = 34, k = Math.min((W - pad * 2) / Math.max(1, mxx - mnx), (H - pad * 2) / Math.max(1, mxy - mny));
      const ox = (W - (mxx - mnx) * k) / 2 - mnx * k, oy = (H - (mxy - mny) * k) / 2 - mny * k;
      this.g = { W, H, k, ox, oy, dpr: Math.min(2, G.devicePixelRatio || 1) };
      for (const c of [this.cb, this.co]) { c.width = Math.round(W * this.g.dpr); c.height = Math.round(H * this.g.dpr); }
      void cv;
      if (!this.sx || this.sx.length !== N) { this.sx = new Float32Array(N); this.sy = new Float32Array(N); }
      for (let i = 0; i < N; i++) { this.sx[i] = ox + tr.x[i] * k; this.sy[i] = oy + tr.y[i] * k; }
    }
    nearest(x, y) { let b = 0, bd = 1e18; for (let i = 0; i < this.N; i++) { const d = (this.sx[i] - x) ** 2 + (this.sy[i] - y) ** 2; if (d < bd) { bd = d; b = i; } } return b; }
    activeView(D) {
      if (this.view) return this.view;
      const p = this.phase(D);
      return p === 'line' ? 'line' : p === 'limits' ? 'trouble' : p === 'coach' || p === 'verify' ? 'coach' : D.coach ? 'coach' : D.learned ? 'grip' : 'line';
    }
    drawBase(D) {
      if (!this.g || this.g.W !== this.mapEl.clientWidth || this.g.H !== this.mapEl.clientHeight) this.geom();
      const { W, H, dpr } = this.g, g = this.cb.getContext('2d'), tr = this.tr, N = this.N, v = this.activeView(D);
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.lineJoin = 'round'; g.lineCap = 'round';
      const sx = this.sx, sy = this.sy;
      const seg = (i0, i1) => { g.beginPath(); g.moveTo(sx[i0 % N], sy[i0 % N]); for (let i = i0 + 1; i <= i1; i++) g.lineTo(sx[i % N], sy[i % N]); };
      // the road
      seg(0, N); g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 15; g.stroke();
      seg(0, N); g.strokeStyle = 'rgba(255,255,255,.13)'; g.lineWidth = 11; g.stroke();
      const paint = (col, w) => { for (let i = 0; i < N; i++) { const c = col(i); if (!c) continue; g.beginPath(); g.moveTo(sx[i], sy[i]); g.lineTo(sx[(i + 1) % N], sy[(i + 1) % N]); g.strokeStyle = c; g.lineWidth = w; g.stroke(); } };
      let legend = '';
      if (v === 'line') {
        if (D.off) {
          g.beginPath();
          for (let i = 0; i <= N; i++) { const q = i % N, x = this.g.ox + (tr.x[q] + tr.nx[q] * D.off[q]) * this.g.k, y = this.g.oy + (tr.y[q] + tr.ny[q] * D.off[q]) * this.g.k; i ? g.lineTo(x, y) : g.moveTo(x, y); }
          g.strokeStyle = '#ffe14d'; g.lineWidth = 2.6; g.stroke();
          legend = '<span><i style="background:#ffe14d"></i>Racing line the AI will drive</span><span>Hover for the offset from the road centre</span>';
        } else legend = '<span>No racing line learned yet. Start training.</span>';
      } else if (v === 'grip') {
        const a = D.lo || D.learned;
        if (a) { paint(i => gripCol(a[i]), 6); legend = '<span><i style="background:linear-gradient(90deg,hsl(0,85%,52%),hsl(60,85%,52%),hsl(120,85%,52%))"></i>Grip the AI trusts here (low to high)</span>' + (D.lo ? '<span>Live: proven clean so far</span>' : ''); }
        else legend = '<span>No grip limits learned yet.</span>';
      } else if (v === 'trouble') {
        const a = D.lo || D.learned;
        if (a) paint(i => gripCol(a[i]), 3);
        if (D.bad) { paint(i => (D.bad[i] ? '#ff3b30' : null), 7); }
        legend = '<span><i style="background:#ff3b30"></i>Where test cars slid, ran wide or hit a wall</span><span><i style="background:hsl(100,85%,52%)"></i>Fine at the grip being tried</span>';
        if (!D.bad) legend = '<span>Trouble spots show here while the grip search runs.</span>';
      } else if (v === 'coach') {
        if (D.coach && this.segAt) {
          const C = D.coach.C;
          paint(i => coachCol(C[this.segAt[i]]), 6.5);
          const se = D.coach.segEnd;
          g.fillStyle = '#fff';
          for (let s = 0; s < se.length - 1; s++) { const i = Math.round(se[s] / tr.ds) % N; g.beginPath(); g.arc(sx[i], sy[i], 3.2, 0, 6.283); g.fill(); }
          legend = '<span><i style="background:hsl(120,80%,46%)"></i>Plan raised here (quicker)</span><span><i style="background:hsl(30,90%,55%)"></i>Plan eased off</span><span>White dots: where one stretch ends and the next begins</span>';
        } else legend = '<span>The coach\'s changes to the plan show here, stretch by stretch.</span>';
      } else if (v === 'live') {
        if (D.lap) { paint(i => `hsl(${Math.round(clamp(D.lap.vs[i] / 90, 0, 1) * 130)},85%,52%)`, 6); legend = '<span><i style="background:linear-gradient(90deg,hsl(0,85%,52%),hsl(65,85%,52%),hsl(130,85%,52%))"></i>Speed on the last lap the coach drove (slow to fast)</span>'; }
        else legend = '<span>A lap is drawn here once the coach has driven one.</span>';
      }
      // corner numbers
      if (tr.apexes) {
        g.font = '700 11px Titillium Web, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,255,255,.75)';
        tr.apexes.forEach((a, n) => { const q = a.i, sd = a.k > 0 ? -1 : 1; g.fillText(n + 1, this.g.ox + (tr.x[q] + tr.nx[q] * sd * 60) * this.g.k, this.g.oy + (tr.y[q] + tr.ny[q] * sd * 60) * this.g.k); });
      }
      // start line
      g.save(); g.translate(sx[0], sy[0]); g.rotate(Math.atan2(tr.ty[0], tr.tx[0])); g.fillStyle = '#fff'; g.fillRect(-2, -11, 4, 22); g.restore();
      this.el.querySelector('.tl-legend').innerHTML = legend;
      this.viewBtns.forEach((b, n) => b.classList.toggle('on', this.viewDefs[n][0] === v));
    }
    drawOver(D, t) {
      if (!this.g) return;
      const { W, H, dpr } = this.g, g = this.co.getContext('2d'), N = this.N;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const ring = (i, col) => { g.beginPath(); g.arc(this.sx[i], this.sy[i], 7, 0, 6.283); g.strokeStyle = col; g.lineWidth = 2; g.stroke(); };
      if (this.pin != null) { ring(this.pin, '#fff'); g.beginPath(); g.arc(this.sx[this.pin], this.sy[this.pin], 2.5, 0, 6.283); g.fillStyle = '#fff'; g.fill(); }
      if (this.hover != null) ring(this.hover, '#e10600');
      // the car: the last lap the coach drove, replayed
      const lap = D.lap;
      if (lap && lap.ts && this.replay.on) {
        const T = lap.ts[N - 1] || 1;
        this.replay.t = (this.replay.t + (t - this.replay.last) / 1000 * this.replay.speed) % T;
        let a = 0, b = N - 1; while (a < b) { const m = (a + b) >> 1; if (lap.ts[m] < this.replay.t) a = m + 1; else b = m; }
        g.beginPath(); g.arc(this.sx[a], this.sy[a], 5.5, 0, 6.283); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#e10600'; g.stroke();
        this.carAt = a;
      } else this.carAt = null;
      this.replay.last = t;
    }
    corner(i) {
      const ap = this.tr.apexes || []; let best = -1, bd = 1e9;
      ap.forEach((a, n) => { let d = Math.abs(a.i - i); d = Math.min(d, this.N - d) * this.tr.ds; if (d < bd) { bd = d; best = n; } });
      return bd < 70 ? 'Corner ' + (best + 1) : null;
    }
    tipHtml(i, D) {
      const ds = this.tr.ds, rows = [], c = this.corner(i);
      rows.push(`<b>${Math.round(i * ds)} m</b>${c ? ' <span>/ ' + c + '</span>' : ''}`);
      if (D.off) rows.push(`<span>Line:</span> ${D.off[i] >= 0 ? '+' : ''}${D.off[i].toFixed(1)} m from centre`);
      if (D.lo) rows.push(`<span>Grip proven:</span> x${D.lo[i].toFixed(2)} <span>/ ceiling</span> x${D.hi[i].toFixed(2)}`);
      else if (D.learned) rows.push(`<span>Grip:</span> corners x${D.learned[i].toFixed(2)}${D.learnedB ? ' <span>/ braking</span> x' + D.learnedB[i].toFixed(2) : ''}`);
      if (D.bad && D.bad[i]) rows.push('<span style="color:#ff6a5f">Test cars got into trouble here</span>');
      if (D.plan) rows.push(`<span>Plan:</span> ${Math.round(D.plan[i] * 3.6)} km/h${D.lap ? ' <span>/ driven</span> ' + Math.round(D.lap.vs[i] * 3.6) + ' km/h' : ''}`);
      if (D.coach && this.segAt) { const s = this.segAt[i]; rows.push(`<span>Stretch ${s + 1}:</span> corner speed plan x${D.coach.C[s].toFixed(3)}`); }
      return rows.join('<br>');
    }
    moveTip(x, y) {
      const D = this.D; if (!D || this.hover == null) return;
      this.tip.innerHTML = this.tipHtml(this.hover, D); this.tip.style.display = 'block';
      const w = this.tip.offsetWidth, h = this.tip.offsetHeight, W = this.mapEl.clientWidth, H = this.mapEl.clientHeight;
      this.tip.style.left = clamp(x + 14, 4, W - w - 4) + 'px'; this.tip.style.top = clamp(y + 14, 4, H - h - 4) + 'px';
    }

    // ---------- the charts ----------
    chartDefault(D) {
      const p = this.phase(D);
      return p === 'line' ? 'line' : p === 'limits' ? 'grip' : p === 'coach' || p === 'verify' ? 'lap' : D.j && D.j.coach.length > 1 ? 'lap' : D.plan ? 'speed' : 'lap';
    }
    drawChart(D) {
      const cv = this.cc, W = cv.clientWidth || 500, H = cv.clientHeight || 190, dpr = Math.min(2, G.devicePixelRatio || 1);
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const tab = this.tab || this.chartDefault(D), j = D.j, N = this.N, ds = this.tr.ds;
      this.tabBtns.forEach((b, n) => b.classList.toggle('on', this.tabDefs[n][0] === tab));
      const L = this.plotL, R = this.plotR, T = 12, Bm = 22, pw = W - L - R, ph = H - T - Bm;
      let series = [], xs = null, ylab = '', hint = '', dist = false, marks = [], horiz = [];
      if (tab === 'lap') {
        const pts = j ? j.coach : [];
        if (pts.length > 1) {
          xs = [0, Math.max(pts.length - 1, j.coachInfo ? j.coachInfo.rounds : 1)];
          series = [{ p: pts.map(q => [q.round, q.tot]), c: 'rgba(255,255,255,.35)', pts: true }, { p: pts.map(q => [q.round, q.best]), c: '#e10600', w: 2.6, step: true }];
          horiz = [[pts[0].tot, '#9a9aa8', 'start ' + fmtT(pts[0].tot)]]; ylab = 's'; this.chartInfo = 'Round ';
        } else if (D.info && D.info.first) hint = `Last training: lap ${fmtT(D.info.first)} to ${fmtT(D.info.best)}. Start training to see each round here.`;
        else hint = 'The coach\'s lap time, round by round, shows here.';
      } else if (tab === 'line') {
        const pts = j && j.line.length ? j.line : [];
        if (pts.length) { xs = [1, Math.max(2, pts.length)]; series = [{ p: pts.map(q => [q.round, q.t]), c: '#ffe14d', w: 2.6, pts: true }]; if (j.lineFrom) horiz = [[j.lineFrom, '#9a9aa8', 'from ' + fmtT(j.lineFrom)]]; ylab = 's'; }
        else hint = 'Only a circuit with no racing line yet searches for one. A learned line is kept: a longer search ran the corners wider than the track allows.';
      } else if (tab === 'speed') {
        if (D.plan) {
          dist = true; xs = [0, N - 1];
          series = [{ p: Array.from(D.plan, (v, i) => [i, v * 3.6]), c: 'rgba(255,255,255,.75)', w: 1.8 }];
          if (D.lap) series.push({ p: Array.from(D.lap.vs, (v, i) => [i, v * 3.6]), c: '#e10600', w: 1.8 });
          ylab = 'km/h'; if (!D.lap) hint = '';
        } else hint = 'The planned speed round the lap shows here once limits are learned.';
      } else if (tab === 'grip') {
        const a = D.lo, b = D.hi;
        if (a) { dist = true; xs = [0, N - 1]; series = [{ p: Array.from(a, (v, i) => [i, v]), c: '#2bd66b', w: 1.8 }, { p: Array.from(b, (v, i) => [i, v]), c: '#ffcc1f', w: 1.4 }]; ylab = 'x grip'; }
        else if (D.learned) { dist = true; xs = [0, N - 1]; series = [{ p: Array.from(D.learned, (v, i) => [i, v]), c: '#2bd66b', w: 1.8 }]; if (D.learnedB) series.push({ p: Array.from(D.learnedB, (v, i) => [i, v]), c: '#3aa0ff', w: 1.8 }); ylab = 'x grip'; }
        else hint = 'The grip window (proven clean up to the lowest failure) closes in here as the search runs.';
      }
      this.chartDist = dist;
      this.hint.textContent = hint; this.hint.style.display = hint ? 'grid' : 'none';
      if (!series.length) return;
      let y0 = 1e18, y1 = -1e18;
      for (const s of series) for (const q of s.p) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      for (const h of horiz) { y0 = Math.min(y0, h[0]); y1 = Math.max(y1, h[0]); }
      const padY = (y1 - y0) * 0.1 || 0.5; y0 -= padY; y1 += padY;
      const X = x => L + (x - xs[0]) / Math.max(1e-9, xs[1] - xs[0]) * pw, Y = y => T + (1 - (y - y0) / (y1 - y0)) * ph;
      g.font = '11px Titillium Web, sans-serif'; g.fillStyle = '#9a9aa8'; g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let k = 0; k <= 4; k++) { const v = y0 + (y1 - y0) * k / 4, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(v.toFixed(Math.abs(y1 - y0) > 20 ? 0 : 2), L - 5, y); }
      g.textAlign = 'center'; g.textBaseline = 'top';
      for (let k = 0; k <= 4; k++) { const x = xs[0] + (xs[1] - xs[0]) * k / 4; g.fillText(dist ? Math.round(x * ds) + ' m' : String(Math.round(x)), X(x), H - Bm + 6); }
      if (dist && this.tr.apexes) { g.fillStyle = 'rgba(255,255,255,.35)'; this.tr.apexes.forEach((a, n) => g.fillRect(X(a.i) - 0.5, T + ph - 5, 1, 5)); }
      for (const h of horiz) { g.setLineDash([4, 4]); g.strokeStyle = h[1]; g.beginPath(); g.moveTo(L, Y(h[0])); g.lineTo(W - R, Y(h[0])); g.stroke(); g.setLineDash([]); g.textAlign = 'left'; g.fillStyle = h[1]; g.textBaseline = 'bottom'; g.fillText(h[2], L + 4, Y(h[0]) - 2); }
      g.lineJoin = 'round';
      for (const s of series) {
        g.beginPath(); g.strokeStyle = s.c; g.lineWidth = s.w || 1.5;
        s.p.forEach((q, n) => { const x = X(q[0]), y = Y(q[1]); if (!n) g.moveTo(x, y); else { if (s.step) g.lineTo(x, Y(s.p[n - 1][1])); g.lineTo(x, y); } });
        g.stroke();
        if (s.pts) { g.fillStyle = s.c; for (const q of s.p) { g.beginPath(); g.arc(X(q[0]), Y(q[1]), 2.6, 0, 6.283); g.fill(); } }
      }
      // the cursor: a point read off, and on the map for a distance chart
      const hv = this.chartHover;
      if (hv != null) {
        const x = L + hv * pw; g.strokeStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
        const xv = xs[0] + hv * (xs[1] - xs[0]), lines = [];
        for (const s of series) { let b = s.p[0]; for (const q of s.p) if (Math.abs(q[0] - xv) < Math.abs(b[0] - xv)) b = q; lines.push(b); }
        const b0 = lines[series.length - 1] || lines[0];
        g.fillStyle = '#fff'; g.textAlign = x > W / 2 ? 'right' : 'left'; g.textBaseline = 'top';
        const lab = dist ? Math.round(xv * ds) + ' m' : 'Round ' + Math.round(xv);
        g.fillText(lab + '   ' + lines.map(q => (ylab === 's' ? fmtT(q[1]) : q[1].toFixed(ylab === 'km/h' ? 0 : 2) + ' ' + ylab)).join('  /  '), x + (x > W / 2 ? -6 : 6), T + 2);
        void b0;
      } else if (this.hover != null && dist) {
        const x = L + (this.hover - xs[0]) / (xs[1] - xs[0]) * pw; g.strokeStyle = 'rgba(225,6,0,.8)'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      }
      // a legend for what is drawn
      g.textAlign = 'right'; g.textBaseline = 'top'; let lx = W - R - 4; g.font = '11px Titillium Web, sans-serif';
      const names = tab === 'lap' ? [['Best lap', '#e10600'], ['Each round', 'rgba(255,255,255,.55)']] : tab === 'line' ? [['Model lap', '#ffe14d']] : tab === 'speed' ? [['Driven', '#e10600'], ['Plan', 'rgba(255,255,255,.75)']] : D.lo ? [['Ceiling', '#ffcc1f'], ['Proven clean', '#2bd66b']] : [['Braking', '#3aa0ff'], ['Corners', '#2bd66b']];
      if (!(tab === 'speed' && !D.lap) && !(tab === 'grip' && !D.lo && !D.learnedB && false)) for (const [t, c] of names) { if (tab === 'speed' && !D.lap && t === 'Driven') continue; const w = g.measureText(t).width; g.fillStyle = c; g.fillText(t, lx, T + 16); g.fillRect(lx - w - 16, T + 21, 12, 3); lx -= w + 30; }
    }

    // ---------- the side panel ----------
    panel(D) {
      const q = this.q, j = D.j, ph = this.phase(D), running = j && j.state === 'running';
      const p = running ? j.p : j && j.state === 'done' ? 1 : D.info && !D.info.partial ? 1 : 0;
      q('pct').textContent = Math.round(p * 100);
      q('status').querySelector('.tl-bar i').style.transform = `scaleX(${p})`;
      const what = running ? { line: 'Searching the racing line', limits: 'Finding the grip limits', coach: 'Coaching the plan', verify: 'Checking the result' }[j.phase] : j && j.state === 'failed' ? 'Training failed' : j && j.state === 'stopped' ? 'Stopped: best plan kept' : j && j.state === 'done' ? 'Training complete' : D.info ? (D.info.partial ? 'Part-trained' : 'Trained') : 'Not trained yet';
      const sub = running ? (j.phase === 'line' ? `model lap ${fmtT(j.lineT)}` : j.phase === 'limits' ? `search and check laps` : j.phase === 'coach' ? `best lap ${fmtT(j.coach.length ? j.coach[j.coach.length - 1].best : null)}` : 'one clean lap') : j && j.state === 'failed' ? esc(j.error || '') : D.info && D.info.best ? `AI lap ${fmtT(D.info.best)}` : 'Quick learning only';
      q('what').textContent = what; q('sub').innerHTML = sub;
      const el = running ? (performance.now() - j.t0) / 1000 : j && j.ms ? j.ms / 1000 : 0;
      q('elapsed').textContent = fmtClock(el);
      q('eta').textContent = running && p > 0.03 ? '~' + fmtClock(el * (1 - p) / p) : running ? '...' : '--';
      q('threads').textContent = j ? j.threads : (navigator.hardwareConcurrency ? Math.max(2, Math.min(14, navigator.hardwareConcurrency - 2)) : '?');
      q('laps').textContent = j ? j.laps : 0;
      // steps
      const at = running ? PHASE_AT[j.phase] : j && (j.state === 'done') ? 4 : -1;
      const detail = [
        j ? (j.lineP >= 1 && j.lineTo ? (j.lineKept ? 'kept as learned' : `model lap ${fmtT(j.lineFrom)} to ${fmtT(j.lineTo)}`) : j.lineT ? 'model lap ' + fmtT(j.lineT) : '') : '',
        j ? (() => { const g = j.gens.sim, c = j.checks.sim; return g ? (c ? `check lap ${c.chk}/${c.checks}` : `search ${g.gen}/${g.gens}`) + ` / ${g.bad.reduce((a, b) => a + b, 0)} trouble spots` : ''; })() : '',
        j && j.coachInfo ? `round ${j.coach.length - 1}/${j.coachInfo.rounds} / ${j.coachInfo.n} stretches` : '',
        j && j.verify ? fmtT(j.verify.tot) + (j.verify.bad ? ', trouble' : ', clean') : '',
      ];
      const sp = [j ? j.lineP : 0, j ? j.limP : 0, j ? j.coachP : 0, j && j.verify ? 1 : 0];
      this.stepEls.forEach((e, n) => {
        const done = j && (at > n || (j.state === 'done' && n <= 3)) && !(j.state === 'stopped');
        e.classList.toggle('act', running && at === n); e.classList.toggle('done', !!done);
        e.querySelector('em').textContent = detail[n] || '';
        e.querySelector('.tl-sbar i').style.transform = `scaleX(${done ? 1 : running && at === n ? sp[n] : at > n ? 1 : 0})`;
        e.querySelector('u').textContent = done ? '✓' : n + 1;
      });
      // the result
      const res = q('result'), info = j && j.result ? j.result : D.info;
      if (info && info.first != null && info.best != null && !(running && !j.coachInfo)) {
        res.hidden = false;
        const gain = info.first - info.best, none = info.none && !(gain > 0.02);
        res.querySelector('.tl-res').innerHTML = `<div><b>${fmtT(info.first)}</b><span>Before coaching</span></div><div class="arrow">→</div><div class="${gain > 0 ? 'good' : ''}"><b>${fmtT(info.best)}</b><span>${gain > 0.005 ? 'Now, ' + gain.toFixed(2) + ' s quicker' : 'Now'}</span></div>`;
        res.querySelector('.tl-note').textContent = none ? 'The coach found nothing quicker that stayed clean, so the plan from the line and limits search stands.' : `A solo lap on fresh tyres. ${info.rounds || 0} coach rounds over ${info.n || '?'} stretches${info.partial ? ' (still running or stopped early: the best so far is in use)' : ''}. The AI drives this plan in every race on this circuit.`;
      } else res.hidden = true;
      // the controls
      q('start').hidden = running; q('stop').hidden = !running;
      const trained = !!D.info && !running;
      q('start').textContent = trained ? 'Retrain from scratch' : 'Start training';
      q('more').hidden = !(trained && D.info.C || trained && D.info.rounds);
      q('reset').hidden = !trained; if (!this.confirmReset) q('reset').textContent = 'Reset training';
      q('ctl').querySelector('.tl-set').hidden = running; q('presets').hidden = running;
      this.rp.textContent = this.replay.speed ? 'Replay x' + this.replay.speed : 'Replay off';
      const km = this.tr.L / 1000, thr = +q('threads').textContent || 6, c = this.custom;
      const est = km * ((c.gens + c.checks) * 2.4 + c.coachRounds * 2.4) * (6 / Math.max(2, thr));
      q('est').textContent = running ? '' : `Roughly ${est < 90 ? 'a minute' : Math.round(est / 60) + ' minutes'} on this machine. It uses every spare thread, so the game is best left alone meanwhile. Stop at any time: the best plan so far is kept.${trained ? ' "Train further" carries on from the plan it has.' : ''}`;
      // the log
      const log = q('log'), n = j ? j.log.length : 0;
      if (this.logN !== n || this.logJ !== j) {
        this.logN = n; this.logJ = j;
        log.innerHTML = j ? j.log.map(l => `<div class="${l.kind}"><i>${fmtClock(l.t / 1000)}</i>${esc(l.text)}</div>`).join('') : `<div><i></i>Press Start training. The AI first searches for the best racing line, then finds how much grip each corner gives, then drives the lap again and again, changing the plan where it finds time.</div>`;
        log.scrollTop = log.scrollHeight;
      }
    }

    frame(t) {
      this.raf = requestAnimationFrame(tt => this.frame(tt));
      const stale = !this.D || this.dirty.base || this.dirty.panel || this.dirty.chart || t - (this.lastData || 0) > 200;
      if (stale) { this.D = this.data(); this.lastData = t; }
      const D = this.D;
      const running = D.j && D.j.state === 'running';
      if (this.dirty.base) { this.drawBase(D); this.dirty.base = false; }
      this.drawOver(D, t);
      if (this.dirty.chart || running || this.chartHover != null || this.hover != null) { this.drawChart(D); this.dirty.chart = false; }
      if (this.dirty.panel || running) { if (!this.lastPanel || t - this.lastPanel > 250 || this.dirty.panel) { this.panel(D); this.lastPanel = t; this.dirty.panel = false; } }
      if (this.pin != null && this.hover == null) { this.tip.innerHTML = this.tipHtml(this.pin, D) + '<br><span>Pinned: click again to release</span>'; this.tip.style.display = 'block'; const w = this.tip.offsetWidth, W = this.mapEl.clientWidth; this.tip.style.left = clamp(this.sx[this.pin] + 14, 4, W - w - 4) + 'px'; this.tip.style.top = clamp(this.sy[this.pin] + 14, 4, this.mapEl.clientHeight - this.tip.offsetHeight - 4) + 'px'; }
      else if (this.hover == null) this.tip.style.display = 'none';
    }
  }

  function open(id, opts) {
    if (current) { if (current.id === id) return current; current.close(); }
    return (current = new Lab(id, opts));
  }
  F1.TrainLab = { open, close: () => current && current.close(), isOpen: id => !!current && (!id || current.id === id) };
})(window);
