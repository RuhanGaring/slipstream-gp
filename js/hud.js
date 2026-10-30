// In-race HUD: timing tower, dashboard, lap timing, messages, start lights.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;
  const $ = id => document.getElementById(id);

  const H = { rows: [], towerT: 0, msgQ: [], lastLight: 0 };

  function init() {
    const revs = $('revs');
    revs.innerHTML = '';
    for (let k = 0; k < 15; k++) {
      const i = document.createElement('i');
      i.className = k < 5 ? 'g' : k < 10 ? 'r' : 'b';
      revs.appendChild(i);
    }
    H.revs = Array.from(revs.children);
    H.el = {
      pos: $('pos'), posOf: $('pos-of'), lap: $('lap'), lapOf: $('lap-of'), tower: $('tower'),
      cur: $('t-cur'), delta: $('t-delta'), last: $('t-last'), best: $('t-best'),
      sec: [$('sec0'), $('sec1'), $('sec2')], gear: $('gear'), speed: $('speed'), unit: $('unit'),
      thr: $('ped-thr'), brk: $('ped-brk'), drs: $('f-drs'), xm: $('f-xm'), ers: $('ers-bar'), ersPct: $('ers-pct'), ersBox: $('ers'), lim: $('f-lim'), box: $('f-box'), man: $('f-man'),
      tyres: $('tyres'), tyreEls: Array.from(document.querySelectorAll('.tyre-grid i')), comp: $('tyre-comp'), wear: $('tyre-wear'), wing: $('wing'),
      msgs: $('msgs'), lights: $('lights'), lightEls: Array.from(document.querySelectorAll('#lights i')), big: $('center-big'),
      pit: $('pitpanel'), mini: $('minimap'), miniName: $('mini-name'), keyhint: $('keyhint'),
    };
  }

  function setup(race, settings) {
    const e = H.el;
    e.tower.innerHTML = '';
    H.rows = [];
    const n = race.mode === 'tt' ? 0 : race.cars.length;
    e.tower.style.display = n ? '' : 'none';
    for (let k = 0; k < n; k++) {
      const r = document.createElement('div');
      r.className = 'tw-row';
      r.innerHTML = '<span class="p"></span><span class="c"></span><span class="n"></span><span class="g"></span><span class="t"></span>';
      e.tower.appendChild(r);
      H.rows.push({ el: r, p: r.children[0], c: r.children[1], n: r.children[2], g: r.children[3], t: r.children[4], key: '' });
    }
    e.posOf.textContent = '/' + race.cars.length;
    $('hud-pos').style.display = race.mode === 'tt' ? 'none' : '';
    e.lapOf.textContent = race.mode === 'tt' ? '' : '/' + race.laps;
    e.tyres.classList.toggle('show', race.sim);
    e.unit.textContent = settings.units === 'mph' ? 'MPH' : 'KM/H';
    e.man.classList.toggle('show', race.sim && race.player.assist.autoGear === false);
    e.drs.classList.add('show');
    e.miniName.textContent = race.track.name.toUpperCase();
    e.msgs.innerHTML = '';
    e.lights.className = '';
    e.lightEls.forEach(l => l.classList.remove('on'));
    e.sec.forEach(s => (s.className = ''));
    e.pit.classList.remove('show');
    const kh = [];
    if (race.mode === 'arcade') kh.push(['W A S D', 'drive'], ['R', 'reset car'], ['C', 'camera'], ['Z', 'zoom'], ['RMB', 'mouse steering'], ['ESC', 'pause']);
    else kh.push(['SPACE', 'overtake'], ['P', 'pit strategy'], ['C', 'camera'], ['Z', 'zoom'], ['RMB', 'mouse steering'], ['ESC', 'pause']);
    if (race.sim && race.player.assist.autoGear === false) kh.unshift(['E / Q', 'shift up / down']);
    e.keyhint.innerHTML = kh.map(([k, t]) => `<div><span class="key">${k}</span>${t}</div>`).join('');
    H.keyhintT = 12;
    e.keyhint.style.opacity = 1;
    H.msgQ = [];
    H.lastLight = 0;
  }

  function message(text, cls = '', sub = '', dur = 2.6) {
    const e = H.el;
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
    e.msgs.appendChild(d);
    while (e.msgs.children.length > 3) e.msgs.removeChild(e.msgs.firstChild);
    setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 400); }, dur * 1000);
  }

  function big(text, color) {
    const b = H.el.big;
    b.textContent = text; b.style.color = color || '#fff';
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  const tyreColor = (temp, wear, opt) => {
    // blue cold, green in window, red hot; darkened as the tyre wears
    const d = temp - opt;
    let c;
    if (d < -22) c = [60, 130, 255]; else if (d < -8) c = [70, 200, 220]; else if (d < 12) c = [40, 214, 107]; else if (d < 25) c = [255, 190, 30]; else c = [255, 60, 48];
    const k = 1 - wear * 0.55;
    return `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
  };

  function update(race, p, dt, settings, extra) {
    const e = H.el;
    const tr = race.track;
    // dashboard
    const v = p.speed * (settings.units === 'mph' ? 2.23694 : 3.6);
    e.speed.textContent = Math.round(v);
    e.gear.textContent = p.gear < 0 ? 'R' : (p.speed < 0.5 && p.ctl.throttle < 0.05 && race.green ? 'N' : p.gear);
    const rpm = p.rpm, lo = 8600, hi = p.spec.rpmLimit - 150;
    const lit = U.clamp(Math.floor((rpm - lo) / (hi - lo) * 15), 0, 15);
    const flash = rpm > hi && p.gear > 0 && p.gear < 8;
    e.revsEl = e.revsEl || $('revs');
    e.revsEl.classList.toggle('flash', flash && Math.floor(performance.now() / 70) % 2 === 0);
    for (let k = 0; k < 15; k++) { const on = k < lit; if (H.revs[k]._on !== on) { H.revs[k].classList.toggle('on', on); H.revs[k]._on = on; } }
    e.thr.style.setProperty('--v', p.throttleOut != null ? p.throttleOut.toFixed(2) : p.ctl.throttle.toFixed(2));
    e.brk.style.setProperty('--v', p.ctl.brake.toFixed(2));
    e.drs.classList.toggle('show', race.green && (p.drsAvail || p.drsOpen));
    e.drs.classList.toggle('on', p.drsOpen);
    // 2026 power unit: straight-line aero mode and battery state
    e.xm.classList.toggle('show', !!p.aeroX); e.xm.classList.toggle('on', !!p.aeroX);
    if (p.soc != null) {
      e.ers.style.setProperty('--v', p.soc.toFixed(3));
      e.ersBox.classList.toggle('dep', p.deploy > 0.05);
      e.ersBox.classList.toggle('harv', !!p.harvest && !(p.deploy > 0.05));
      const pct = Math.round(p.soc * 100);
      if (e.ersPct._v !== pct) { e.ersPct.textContent = pct + '%'; e.ersPct._v = pct; }
    }
    e.lim.classList.toggle('show', !!p.limiter); e.lim.classList.toggle('on', !!p.limiter);
    const boxing = p.brain && p.brain.pit;
    e.box.classList.toggle('show', !!boxing); e.box.classList.toggle('on', !!boxing);
    if (race.sim) {
      p.wheels.forEach((w, k) => { e.tyreEls[k].style.background = tyreColor(w.temp, w.wear, p.compound.topt); });
      e.comp.textContent = p.compound.name;
      e.comp.className = 'c-' + p.compound.id;
      const wr = Math.max(...p.wheels.map(w => w.wear));
      e.wear.textContent = `WEAR ${Math.round(wr * 100)}%  ${Math.round(p.wheels.reduce((a, w) => a + w.temp, 0) / 4)}°C`;
      if (p.dm) {
        // the full model: the worst-hit parts, a hot engine, punctures and failures
        const dm = p.dm, N = { fwL: 'FRONT WING L', fwR: 'FRONT WING R', nose: 'NOSE', sFL: 'SUSP FL', sFR: 'SUSP FR', sRL: 'SUSP RL', sRR: 'SUSP RR', podL: 'SIDEPOD L', podR: 'SIDEPOD R', floor: 'FLOOR', rw: 'REAR WING', gbox: 'GEARBOX' };
        const bad = Object.keys(dm.p).filter(k => dm.p[k] > 0.1 || dm.off[k]).sort((a, b) => dm.p[b] - dm.p[a]).slice(0, 2)
          .map(k => N[k] + (dm.off[k] ? ' LOST' : ' ' + Math.round(dm.p[k] * 100) + '%'));
        if (dm.puncture.some(v => v)) bad.unshift('PUNCTURE');
        if (dm.wheelOff.some(v => v)) bad.unshift('WHEEL LOST');
        if (dm.failed) bad.unshift(dm.failed + ' FAILURE');
        else if (dm.engT > 126) bad.push('ENGINE HOT ' + Math.round(dm.engT) + '°C');
        e.wing.textContent = bad.length ? bad.slice(0, 2).join('  /  ') : 'NO DAMAGE';
        e.wing.classList.toggle('bad', bad.length > 0);
      } else {
        e.wing.textContent = p.wingDmg > 0.1 ? `FRONT WING ${Math.round(p.wingDmg * 100)}%` : 'FRONT WING OK';
        e.wing.classList.toggle('bad', p.wingDmg > 0.1);
      }
    }
    // position & lap
    e.pos.textContent = p.pos;
    const lap = race.mode === 'tt' ? Math.max(1, p.lap) : U.clamp(p.lap, 1, race.laps);
    e.lap.textContent = lap;
    // timing
    const curT = race.green ? race.time - p.lapStart : 0;
    e.cur.textContent = U.fmtTime(curT);
    e.last.textContent = U.fmtTime(p.lastLap);
    e.best.textContent = U.fmtTime(p.bestLap);
    if (extra && extra.delta != null && isFinite(extra.delta)) {
      e.delta.textContent = U.fmtGap(extra.delta);
      e.delta.className = 'delta ' + (extra.delta > 0 ? 'up' : 'down');
    } else e.delta.textContent = '';
    // live sector
    const sIdx = p.dist < 0 ? 0 : (p.loc.s < tr.sectors[1] ? 0 : p.loc.s < tr.sectors[2] ? 1 : 2);
    for (let k = 0; k < 3; k++) {
      const cls = k < sIdx ? (p.secCls ? p.secCls[k] : '') : k === sIdx ? 'live' : '';
      if (e.sec[k]._c !== cls) { e.sec[k].className = cls; e.sec[k]._c = cls; }
    }
    // start lights
    if (race.phase === 'lights' || race.phase === 'grid') {
      e.lights.className = 'show';
      e.lightEls.forEach((l, k) => l.classList.toggle('on', k < race.lightsOn));
    } else if (race.green && race.time - race.startTime < 1.2) {
      e.lights.className = 'show go';
    } else e.lights.className = '';

    // tower (4 Hz)
    H.towerT -= dt;
    if (H.towerT <= 0 && H.rows.length) {
      H.towerT = 0.25;
      const order = race.order;
      // on a phone the tower is short: the top five, then the player and the cars either side
      const short = document.body.classList.contains('mobile'), me = order.indexOf(p);
      order.forEach((c, k) => {
        const r = H.rows[k];
        if (!r) return;
        r.el.style.display = !short || k < 5 || Math.abs(k - me) <= 1 ? '' : 'none';
        let gap;
        if (k === 0) gap = race.chequered && c.finished ? 'FINISH' : 'LEADER';
        else if (c.inPit) gap = 'PIT';
        else if (c.lapsDown >= 1) gap = '+' + c.lapsDown + ' LAP';
        else gap = race.green ? '+' + Math.max(0, settings.gapMode === 'leader' ? c.gapLeader : c.interval).toFixed(1) : '';
        if (c.finished && k > 0 && race.chequered) gap = c.lapsDown >= 1 ? '+' + c.lapsDown + ' LAP' : '+' + (c.finishTime - race.order[0].finishTime || 0).toFixed(1);
        const key = c.id + gap + (c === p) + (race.fastest && race.fastest.car === c) + c.compound.id;
        if (r.key === key) return;
        r.key = key;
        r.p.textContent = k + 1;
        r.c.style.background = c.team.base === '#121417' ? c.team.accent : c.team.base;
        r.n.textContent = c.driver.code;
        r.g.textContent = gap;
        r.t.textContent = race.sim ? c.compound.id : '';
        r.t.className = 't c-' + c.compound.id;
        r.el.className = 'tw-row' + (c === p ? ' me' : '') + (c.inPit ? ' pit' : '') + (race.fastest && race.fastest.car === c ? ' fl' : '');
      });
    }
    if (H.keyhintT > 0) { H.keyhintT -= dt; if (H.keyhintT <= 0) e.keyhint.style.opacity = 0; }
  }

  F1.HUD = { H, init, setup, update, message, big };
})(typeof window !== 'undefined' ? window : globalThis);
