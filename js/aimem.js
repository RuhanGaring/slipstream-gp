// The AI's learned pace factor and line shift per 10 m of a circuit (js/race.js THINK), which a field
// can start from. Empty on purpose: memory taught alone on fresh tyres and light fuel (tools/aimem.js)
// raced slower than learning from scratch (20-car Legend A/B, best lap +1.5 s, three times the
// recoveries), so each race learns its own. Kept as the place a better-taught memory would go.
(function (G) {
  G.F1 = G.F1 || {};
  G.F1.AIMem = {};
})(typeof self !== 'undefined' ? self : this);
