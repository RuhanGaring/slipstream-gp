// In-race HUD: timing tower, dashboard, lap timing, messages, start lights.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;
  const $ = id => document.getElementById(id);

  const H = { rows: [], towerT: 0, msgQ: [], lastLight: 0 };

  // ---------- the cluster and the car (desktop) ----------
  // The low cluster F1 games use, bottom centre: gear in the middle under a row of rev lights, the
  // battery on a dial to its left, speed and revs on a dial to its right. The body is drawn once
  // and kept; only the lit parts are stroked over it, at 30 Hz.
  const A = { w: 440, h: 128, lx: 70, rx: 370, cy: 66, r: 47, a0: Math.PI * 0.75, a1: Math.PI * 2.25, max: 13000 };
  function sharp(cv, w, h) {
    const d = Math.min(2, G.devicePixelRatio || 1);
    cv.width = w * d; cv.height = h * d; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    return g;
  }
  function hudExtras() {
    const dash = $('dash'), hud = $('hud');
    const arc = document.createElement('canvas'); arc.id = 'h-arc'; dash.insertBefore(arc, dash.firstChild);
    const car = document.createElement('canvas'); car.id = 'h-car'; $('tyres').insertBefore(car, $('tyres').firstChild);
    H.ag = sharp(arc, A.w, A.h); H.cg = sharp(car, 72, 118);
    const rpm = document.createElement('span'); rpm.id = 'h-rpm'; $('speed-wrap').appendChild(rpm); H.rpmEl = rpm;
    const ersL = document.querySelector('#ers .lbl'); if (ersL) ersL.textContent = 'BATTERY';
    const flag = document.createElement('div'); flag.id = 'h-flag'; hud.appendChild(flag); H.flagEl = flag;
    H.spotL = $('spot-l'); H.spotR = $('spot-r');
    const pit = document.createElement('div'); pit.id = 'h-pit'; pit.innerHTML = '<b>PIT WINDOW OPEN</b><span></span>'; hud.appendChild(pit); H.pitEl = pit;
    const d = Math.min(2, G.devicePixelRatio || 1), body = document.createElement('canvas'), g = body.getContext('2d');
    body.width = A.w * d; body.height = A.h * d; g.scale(d, d);
    const { lx, rx, cy, r, a0, a1 } = A;
    g.fillStyle = '#07080c';
    g.beginPath(); g.arc(lx, cy, 60, 0, 7); g.arc(rx, cy, 60, 0, 7); g.fill();
    g.beginPath(); g.roundRect(lx, 14, rx - lx, 112, 22); g.fill();
    for (const x of [lx, rx]) { g.lineWidth = 5; g.strokeStyle = '#3a3b40'; g.beginPath(); g.arc(x, cy, r, a0, a1); g.stroke(); }
    g.strokeStyle = '#a32a24'; g.beginPath(); g.arc(rx, cy, r, a0 + (a1 - a0) * 11500 / A.max, a1); g.stroke();
    H.body = body;
  }
  function drawArc(p, lit, hi, overtake) {
    const g = H.ag, { w, h, lx, rx, cy, r, a0, a1, max } = A, rpm = Math.min(max, p.rpm || 0), s = a1 - a0;
    g.clearRect(0, 0, w, h);
    g.globalAlpha = 0.86; g.drawImage(H.body, 0, 0, w, h); g.globalAlpha = 1;
    g.lineCap = 'butt'; g.lineWidth = 5;
    const soc = p.soc == null ? 0 : p.soc;
    if (soc > 0.005) { g.strokeStyle = overtake ? '#35e6ff' : p.deploy > 0.05 ? '#2f9dff' : p.harvest ? '#2bd66b' : '#ffd400'; g.beginPath(); g.arc(lx, cy, r, a0, a0 + s * soc); g.stroke(); }
    g.strokeStyle = rpm > hi ? '#3d8bff' : rpm > 11500 ? '#ff3b30' : '#fff';
    g.beginPath(); g.arc(rx, cy, r, a0, a0 + s * rpm / max); g.stroke();
    // rev lights over the gear
    const shift = rpm > hi && p.gear > 0 && p.gear < 8 && Math.floor(performance.now() / 70) % 2 === 0;
    for (let k = 0; k < 15; k++) {
      g.fillStyle = shift ? '#3d8bff' : k >= lit ? 'rgba(255,255,255,.12)' : k < 5 ? '#22e06b' : k < 10 ? '#ff2d2d' : '#3d8bff';
      g.beginPath(); g.arc(w / 2 + (k - 7) * 12, 28, 3.6, 0, 7); g.fill();
    }
    // brake to the left of centre, throttle to the right, under the gear
    const thr = p.throttleOut != null ? p.throttleOut : p.ctl.throttle, bk = p.ctl.brake, bw = 74, by = 113;
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(w / 2 - bw - 2, by, bw, 4); g.fillRect(w / 2 + 2, by, bw, 4);
    g.fillStyle = '#ff3b30'; g.fillRect(w / 2 - 2 - bw * bk, by, bw * bk, 4);
    g.fillStyle = '#2bd66b'; g.fillRect(w / 2 + 2, by, bw * thr, 4);
  }
  // the car from above: tyres by temperature, a tyre drains as it wears, broken parts go red
  function drawCar(p, tyre) {
    const g = H.cg, W = 72, H2 = 118, c = W / 2;
    g.clearRect(0, 0, W, H2);
    const dm = p.dm, part = (k, f) => { const v = dm ? (dm.off[k] ? 1 : dm.p[k] || 0) : f; return v > 0.08 ? `rgb(${Math.round(120 + 135 * v)},${Math.round(90 - 60 * v)},${Math.round(90 - 60 * v)})` : 'rgba(255,255,255,.28)'; };
    g.fillStyle = 'rgba(255,255,255,.2)';
    g.beginPath(); g.moveTo(c - 4, 12); g.lineTo(c + 4, 12); g.lineTo(c + 7, 42); g.lineTo(c + 15, 60); g.lineTo(c + 12, 96); g.lineTo(c - 12, 96); g.lineTo(c - 15, 60); g.lineTo(c - 7, 42); g.closePath(); g.fill();
    g.fillStyle = part('fwL', p.wingDmg || 0); g.fillRect(c - 26, 6, 25, 6);
    g.fillStyle = part('fwR', p.wingDmg || 0); g.fillRect(c + 1, 6, 25, 6);
    g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(c - 20, 106, 40, 6);
    const pos = [[6, 20], [52, 20], [4, 74], [50, 74]];
    p.wheels.forEach((w, k) => {
      const [x, y] = pos[k], tw = k < 2 ? 14 : 18, th = 28, hw = th * U.clamp(w.wear, 0, 1);
      g.fillStyle = tyre(w.temp, 0, p.compound.topt); g.fillRect(x, y, tw, th);
      if (hw > 0.5) { g.fillStyle = 'rgba(8,8,12,.72)'; g.fillRect(x, y, tw, hw); }
      if (dm && dm.puncture[k]) { g.strokeStyle = '#ff3b30'; g.lineWidth = 2; g.strokeRect(x - 1, y - 1, tw + 2, th + 2); }
    });
  }

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
    hudExtras();
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
    // (what each key really does here: the session and the handling both change it)
    const inRace = race.mode !== 'tt', simCar = race.sim;
    const K = (a, d) => (F1.Game.hintKey ? F1.Game.hintKey(a) : d), padOn = !!F1.Game.usingPad;
    kh.push([padOn ? 'LS RT LT' : [K('thr', 'W'), K('left', 'A'), K('brk', 'S'), K('right', 'D')].join(' '), 'drive']);
    if (F1.Game.fbCan && F1.Game.fbCan()) kh.push([K('flash', 'BACKSPACE'), 'flashback']);
    if (!simCar || !inRace) kh.push([K('reset', 'R'), 'reset car']);
    if (inRace && simCar) kh.push([K('drs', 'SPACE'), 'overtake'], [K('pit', 'P'), 'pit strategy']);
    if (inRace && !padOn) kh.push(['T', 'full order']);
    kh.push([K('cam', 'C'), 'camera']);
    if (padOn) kh.push(['START', 'pause']); else kh.push(['Z', 'zoom'], ['RMB', 'mouse steering'], ['ESC', 'pause']);
    if (race.sim && race.player.assist.autoGear === false) kh.unshift([K('up', 'E') + ' / ' + K('down', 'Q'), 'shift up / down']);
    e.keyhint.innerHTML = kh.map(([k, t]) => `<div><span class="key">${k}</span>${t}</div>`).join('');
    H.keyhintT = 12;
    e.keyhint.style.opacity = 1;
    H.msgQ = [];
    H.lastLight = 0;
    H.full = false; H.openT = 10; H.lapSeen = 0; H.arcT = 0; H.planLap = 0; H.nextTyre = null;
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

  // Yellow: a car stopped on the road ahead. Blue: a leader is about to lap you, let it by.
  function flagFor(race, p) {
    if (race.mode === 'tt' || !race.green || p.finished || race.time - race.startTime < 12) return '';
    const L = race.track.L, hw = race.track.hw;
    let stop = Infinity, blue = false;
    for (const c of race.cars) {
      if (c === p || c.hidden || c.inPit) continue;
      const ahead = ((c.loc.s - p.loc.s) % L + L) % L, behind = L - ahead;
      if (c.speed < 12 && !c.finished && ahead < 400 && Math.abs(c.loc.d) < hw + 2.5) stop = Math.min(stop, ahead);
      if (!c.retired && !c.finished && behind < 90 && c.dist - p.dist > L * 0.5) blue = true;
    }
    if (stop < 400) return 'YELLOW FLAG  ' + Math.round(stop / 10) * 10 + ' M';
    return blue ? 'BLUE FLAG  LET THE LEADER BY' : '';
  }
  // The spotter: a bar at the edge of the screen on the side a car is alongside. From the cockpit
  // and the T-cam that car cannot be seen at all, and it is the one that takes a wing off.
  function spotter(race, p, settings) {
    const on = settings.spotter !== false && race.green && race.mode !== 'tt' && !p.inPit;
    let l = 0, r = 0;
    if (on) {
      const ch = Math.cos(p.h), sh = Math.sin(p.h);
      for (const c of race.cars) {
        if (c === p || c.retired || c.hidden || c.inPit) continue;
        const dx = c.x - p.x, dy = c.y - p.y;
        if (dx * dx + dy * dy > 90) continue;
        const fwd = dx * ch + dy * sh, lat = -dx * sh + dy * ch;
        if (Math.abs(fwd) > 6.4 || Math.abs(lat) < 0.6) continue;
        const k = U.clamp(1.25 - (Math.abs(fwd) / 6.4) * 0.45 - (Math.abs(lat) - 1.8) / 3.4, 0, 1);
        if (lat > 0) r = Math.max(r, k); else l = Math.max(l, k);
      }
    }
    if (H.spotL._v !== l) { H.spotL.style.opacity = l.toFixed(2); H.spotL.classList.toggle('near', l > 0.75); H.spotL._v = l; }
    if (H.spotR._v !== r) { H.spotR.style.opacity = r.toFixed(2); H.spotR.classList.toggle('near', r > 0.75); H.spotR._v = r; }
  }

  function update(race, p, dt, settings, extra) {
    const e = H.el;
    H.spotT = (H.spotT || 0) - dt;
    if (H.spotT <= 0) { H.spotT = 1 / 15; spotter(race, p, settings); }
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
    // the cluster, on the desktop (a phone keeps its own compact dash)
    const wide = !document.body.classList.contains('mobile');
    if (wide) {
      H.arcT -= dt;
      if (H.arcT <= 0) { H.arcT = 1 / 30; drawArc(p, lit, hi, !!p.drsOpen); }
    }
    for (let k = 0; k < 15; k++) { const on = k < lit; if (H.revs[k]._on !== on) { H.revs[k].classList.toggle('on', on); H.revs[k]._on = on; } }
    e.thr.style.setProperty('--v', p.throttleOut != null ? p.throttleOut.toFixed(2) : p.ctl.throttle.toFixed(2));
    e.brk.style.setProperty('--v', p.ctl.brake.toFixed(2));
    e.drs.classList.toggle('show', race.green && (p.drsAvail || p.drsOpen));
    e.drs.classList.toggle('on', p.drsOpen);
    if (document.body.classList.contains('mobile')) {
      const t = H.tDrs || (H.tDrs = document.querySelector('#touch .t-drs'));
      if (t) t.classList.toggle('ready', race.green && !!(p.drsAvail || p.drsOpen));
    }
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
    H.slowT = (H.slowT || 0) - dt;
    if (H.slowT <= 0) {
      const rt = Math.round(p.rpm / 10) * 10;
      if (H.rpmEl._v !== rt) { H.rpmEl.textContent = rt + ' RPM'; H.rpmEl._v = rt; }
      const sc = race.sc && race.sc.state !== 'none' && race.sc.state !== 'pending', fl = sc ? 'SAFETY CAR  HOLD POSITION' : flagFor(race, p);
      if (H.flagEl._v !== fl) {
        H.flagEl.textContent = fl; H.flagEl.classList.toggle('on', !!fl);
        H.flagEl.classList.toggle('blue', fl.startsWith('BLUE')); H.flagEl._v = fl;
      }
      // the pit window: the next stop is due at the end of this lap
      if (race.sim && race.mode !== 'tt' && p.lap !== H.planLap) {
        H.planLap = p.lap;
        const left = race.laps - Math.max(1, p.lap) + 1;
        H.nextTyre = null;
        if (left > 1) { const pl = F1.Race.planFor(race, p, left); if (pl && pl.stops.length && pl.stops[0] <= 1) H.nextTyre = pl.seq[1]; }
        if (H.nextTyre) H.pitEl.lastChild.textContent = 'FIT ' + F1.Car.COMPOUNDS[H.nextTyre].name;
      }
      H.pitEl.classList.toggle('on', !!H.nextTyre && !(p.brain && p.brain.pit) && !p.inPit);
    }
    if (race.sim && H.slowT <= 0) {
      H.slowT = 0.25;
      p.wheels.forEach((w, k) => { e.tyreEls[k].style.background = tyreColor(w.temp, w.wear, p.compound.topt); });
      if (!document.body.classList.contains('mobile')) drawCar(p, tyreColor);
      if (document.body.classList.contains('mobile')) {
        const mi = $('m-info'), worst = Math.round(Math.max(...p.wheels.map(w => w.wear)) * 100), hurt = p.dm ? Object.keys(p.dm.p).filter(k => p.dm.p[k] > 0.25 || p.dm.off[k]).length : p.wingDmg > 0.1 ? 1 : 0;
        const txt = `${p.compound.id} ${worst}%${hurt ? '  DAMAGE' : ''}`;
        if (mi._v !== txt) { mi.textContent = txt; mi.classList.toggle('bad', hurt > 0 || worst > 70); mi._v = txt; }
      }
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
      // on the desktop too, except for a few seconds each lap or when asked for (T)
      H.openT -= 0.25;
      if (p.lap !== H.lapSeen) { H.lapSeen = p.lap; H.openT = 7; }
      const short = document.body.classList.contains('mobile') || (!H.full && H.openT <= 0), me = order.indexOf(p);
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
    // (the clock starts at the lights: the grid is no time to read it and then lose it)
    if (H.keyhintT > 0 && race.green) { H.keyhintT -= dt; if (H.keyhintT <= 0) e.keyhint.style.opacity = 0; }
  }

  F1.HUD = { H, init, setup, update, message, big, toggleTower: () => { H.full = !H.full; H.openT = 0; H.towerT = 0; } };
})(typeof window !== 'undefined' ? window : globalThis);
