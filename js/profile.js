// The driver's record: career totals, best results by circuit, and trophies. Everything lives in
// localStorage as one object (slip_profile); a save from an older build gets the fields it lacks.
// Time trial and practice add their distance, only race results count as starts.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const KEY = 'slip_profile';
  const blank = () => ({ v: 1, races: 0, wins: 0, podiums: 0, poles: 0, fastest: 0, dnf: 0, laps: 0, km: 0, gained: 0, flashbacks: 0, tracks: {}, trophies: {}, log: [], daily: {}, streak: 0, streakDay: '' });
  let P = null;
  function load() {
    if (P) return P;
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* storage unavailable */ }
    P = Object.assign(blank(), s || {});
    return P;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* storage unavailable */ } }

  // id, name, what it takes
  const TROPHIES = [
    ['finish', 'Chequered', 'Finish a race'],
    ['podium', 'Champagne', 'Finish on the podium'],
    ['win', 'First Blood', 'Win a race'],
    ['charge', 'Through the Field', 'Gain ten places in a race'],
    ['clean', 'Clean Sheet', 'Finish a race of 3 laps or more without touching a wall, a car or a flashback'],
    ['slam', 'Grand Chelem', 'Pole position, the win and the fastest lap in one race, without help'],
    ['pro', 'Professional', 'Win on Pro or harder, without brake or steering help'],
    ['expert', 'Expert Hands', 'Win on Expert or harder, without brake or steering help'],
    ['legend', 'Legend Slayer', 'Win on Legend, without brake or steering help'],
    ['pure', 'Bare Hands', 'Win in Simulation with no assists on Pro or harder'],
    ['rain', 'Rain Master', 'Win on a wet track'],
    ['long', 'Long Haul', 'Finish a race of 12 laps or more'],
    ['world', 'World Tour', 'Race at every circuit on the calendar'],
    ['km100', 'Road Warrior', 'Drive 100 km'],
    ['km1000', 'Million Metres', 'Drive 1,000 km'],
    ['title', 'World Champion', 'Win the championship'],
    ['streak', 'Regular', 'Finish the daily race three days running'],
    ['top', 'Works Driver', 'Sign for one of the top three teams in Career'],
  ];

  function award(got, id) {
    const p = load();
    if (p.trophies[id]) return;
    p.trophies[id] = Date.now();
    const t = TROPHIES.find(x => x[0] === id);
    if (t) got.push({ id, name: t[1], text: t[2] });
  }

  // distance and laps from any session; returns any trophies that brings
  function addDistance(race, got) {
    const p = load(), me = race && race.player;
    if (!me || me.scored) return;
    me.scored = true;
    p.km += Math.max(0, me.dist || 0) / 1000;
    p.laps += me.lapTimes ? me.lapTimes.length : 0;
    if (p.km >= 100) award(got, 'km100');
    if (p.km >= 1000) award(got, 'km1000');
  }

  // a finished race: returns what the player should hear about it
  function addRace(race, extra) {
    const p = load(), me = race.player, got = [];
    if (!me || !race.result) return { got, best: false };
    const k = race.result.indexOf(me), pos = k + 1, finished = !!me.finished, id = race.track.id;
    const diff = race.cfg.difficulty == null ? 2 : race.cfg.difficulty;
    const rank = F1.Data.ORDER.indexOf(diff);
    const proUp = rank >= F1.Data.ORDER.indexOf(2), expertUp = rank >= F1.Data.ORDER.indexOf(3);
    addDistance(race, got);
    p.races++;
    if (!finished) p.dnf++;
    if (finished && pos === 1) p.wins++;
    if (finished && pos <= 3) p.podiums++;
    if (me.gridPos === 1) p.poles++;
    const fl = race.fastest && race.fastest.car === me;
    if (fl) p.fastest++;
    p.gained += finished ? Math.max(0, me.gridPos - pos) : 0;
    const used = (extra && extra.flashbacks) || 0;
    p.flashbacks += used;
    const t = p.tracks[id] || (p.tracks[id] = { races: 0, best: null, wins: 0 });
    t.races++;
    const best = finished && (t.best == null || pos < t.best);
    if (best) t.best = pos;
    if (finished && pos === 1) t.wins++;
    p.log.unshift({ t: Date.now(), track: id, pos, field: race.cars.length, diff, mode: race.mode, dnf: !finished });
    if (p.log.length > 30) p.log.length = 30;
    if (finished) {
      award(got, 'finish');
      if (pos <= 3) award(got, 'podium');
      if (pos === 1) {
        award(got, 'win');
        const a = me.assist, unaided = !a.brakeHelp && !a.steerHelp && !race.adapt;
        if (proUp && unaided) award(got, 'pro');
        if (expertUp && unaided) award(got, 'expert');
        if (diff === 4 && unaided) award(got, 'legend');
        if (race.wetRace) award(got, 'rain');
        if (me.gridPos === 1 && fl && unaided) award(got, 'slam');
        if (race.sim && proUp && !a.abs && !a.tc && a.autoGear === false && !a.steerAssist && !a.brakeHelp && !a.steerHelp) award(got, 'pure');
      }
      if (me.gridPos - pos >= 10) award(got, 'charge');
      if (race.laps >= 12) award(got, 'long');
      if (race.laps >= 3 && extra && !extra.walls && !extra.hits && !used) award(got, 'clean');
    }
    if (F1.Tracks.DEFS.every(d => p.tracks[d.id])) award(got, 'world');
    let daily = null;
    if (extra && extra.daily) {
      const key = extra.daily, had = p.daily[key];
      if (finished && (had == null || pos < had)) p.daily[key] = pos;
      if (finished && p.streakDay !== key) {
        const y = new Date(new Date(key + 'T12:00:00').getTime() - 864e5), prev = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
        p.streak = p.streakDay === prev ? p.streak + 1 : 1;
        p.streakDay = key;
      }
      if (p.streak >= 3) award(got, 'streak');
      daily = { best: p.daily[key], streak: p.streak };
    }
    save();
    return { got, best, daily };
  }
  // the end of a session that is not a race (time trial, practice), or a race left early
  function addSession(race) { const got = []; addDistance(race, got); save(); return got; }
  function champion() { const got = []; load(); award(got, 'title'); save(); return got; }
  function signed(team) { const got = []; load(); if (team <= 2) award(got, 'top'); save(); return got; }
  function reset() { P = blank(); save(); }

  F1.Profile = { get: load, TROPHIES, addRace, addSession, champion, signed, reset };
})(typeof window !== 'undefined' ? window : globalThis);
