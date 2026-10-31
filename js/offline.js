// Offline play: every file the game needs (listed with its size and content hash in
// assets/manifest.json, written by tools/stamp.py) is downloaded once into the browser's
// Cache Storage, with the progress shown in megabytes on the boot screen. A service worker
// (sw.js) then answers every request for those files from the cache, so after the first
// visit the game starts and runs with no network at all, on any device.
// On later visits only files whose hash changed are fetched again; if any of the page's own
// code changed, the page reloads once to run the new version.
(function (G) {
  'use strict';
  const F1 = G.F1 = G.F1 || {};
  const CACHE = 'sgp-assets-v1';
  const ok = typeof caches !== 'undefined' && location.protocol !== 'file:';
  let cacheP = null;
  const cache = () => cacheP || (cacheP = caches.open(CACHE));
  const abs = p => new URL(p, document.baseURI).href;

  function registerWorker() {
    if (!('serviceWorker' in navigator) || !G.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  async function manifest() {
    try {
      const r = await fetch('assets/manifest.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) { const m = await r.json(); (await cache()).put(abs('assets/manifest.json'), new Response(JSON.stringify(m), { headers: { 'content-type': 'application/json' } })); return m; }
    } catch (e) { /* offline */ }
    const hit = await (await cache()).match(abs('assets/manifest.json'));
    return hit ? hit.json() : null;
  }

  // download one file, reporting bytes as they arrive
  async function fetchInto(c, f, onBytes) {
    const r = await fetch(f.p + '?h=' + f.h, { cache: 'no-store' });
    if (!r.ok) throw new Error(f.p + ': ' + r.status);
    const type = r.headers.get('content-type') || '';
    let blob;
    if (r.body && r.body.getReader) {
      const rd = r.body.getReader(), parts = [];
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); onBytes(value.length);
      }
      blob = new Blob(parts, { type });
    } else { blob = await r.blob(); onBytes(blob.size); }
    await c.put(abs(f.p), new Response(blob, { headers: { 'content-type': type, 'x-h': f.h } }));
  }

  // Bring the cache up to date. onProgress(doneBytes, totalBytes, filesLeft)
  async function sync(onProgress) {
    if (!ok) return { cached: false };
    registerWorker();
    const m = await manifest();
    if (!m) return { cached: false };
    const c = await cache();
    const total = m.files.reduce((s, f) => s + f.s, 0);
    let done = 0;
    const todo = [], stale = [];
    await Promise.all(m.files.map(async f => {
      const hit = await c.match(abs(f.p));
      if (hit && hit.headers.get('x-h') === f.h) done += f.s;
      else { todo.push(f); if (hit) stale.push(f.p); }
    }));
    onProgress(done, total, todo.length);
    // biggest first, four at a time
    todo.sort((a, b) => b.s - a.s);
    let left = todo.length, failed = 0;
    const worker = async () => {
      for (let f; (f = todo.shift());) {
        let got = 0;
        try { await fetchInto(c, f, n => { got += n; done += n; onProgress(done, total, left); }); }
        catch (e) { failed++; done -= got; }
        left--; onProgress(done, total, left);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // drop files the game no longer uses
    const keep = new Set(m.files.map(f => abs(f.p)).concat([abs('assets/manifest.json')]));
    for (const req of await c.keys()) if (!keep.has(req.url)) c.delete(req);
    const code = stale.filter(p => /\.(html|js|css)$/.test(p));
    return { cached: true, failed, total, codeChanged: code.length > 0 };
  }

  // a file's bytes, from the cache when it is there
  async function buffer(p) {
    if (ok) { const hit = await (await cache()).match(abs(p)); if (hit) return hit.arrayBuffer(); }
    const r = await fetch(p);
    if (!r.ok) throw new Error(p + ': ' + r.status);
    return r.arrayBuffer();
  }
  async function blob(p) {
    if (ok) { const hit = await (await cache()).match(abs(p)); if (hit) return hit.blob(); }
    const r = await fetch(p);
    if (!r.ok) throw new Error(p + ': ' + r.status);
    return r.blob();
  }

  F1.Offline = { sync, buffer, blob };
})(typeof window !== 'undefined' ? window : globalThis);
