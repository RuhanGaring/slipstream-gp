// Teams, drivers and liveries. All fictional.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;

  // perf: power and downforce multipliers on the base car. rating is for the menu.
  // car: the 3D car the team races (assets/cars, js/carmodels.js); hue turns its colours (degrees)
  // for a team running another team's car in its own livery. base/accent/third follow the car's livery.
  const TEAMS = [
    { id: 'vanta', name: 'Vanta Racing', short: 'VAN', base: '#121417', accent: '#f4f1e8', third: '#d8b45a', car: 'mac26', power: 1.0, aero: 1.0, rating: 96,
      engine: 'Vanta V6', drivers: [['Lukas', 'Brandt', 'BRA', 1, 0.995], ['Mateo', 'Ruiz', 'RUI', 17, 0.985]] },
    { id: 'ferro', name: 'Ferro Corsa', short: 'FER', base: '#c8102e', accent: '#f6f6f6', third: '#111111', car: 'sf26', power: 1.0, aero: 0.99, rating: 94,
      engine: 'Ferro 066', drivers: [['Enzo', 'Marchetti', 'MAR', 16, 0.99], ['Theo', 'Laurent', 'LAU', 55, 0.982]] },
    { id: 'meridian', name: 'Meridian GP', short: 'MER', base: '#0e8f86', accent: '#c9d3d6', third: '#0a2a2c', car: 'w17', power: 0.995, aero: 0.99, rating: 92,
      engine: 'Meridian EQ', drivers: [['James', 'Whitlock', 'WHI', 44, 0.988], ['Aiden', 'Shaw', 'SHA', 63, 0.98]] },
    { id: 'halcyon', name: 'Halcyon Motorsport', short: 'HAL', base: '#ff8000', accent: '#14161a', third: '#e9eef8', car: 'mcl40', power: 0.99, aero: 0.985, rating: 89,
      engine: 'Meridian EQ', drivers: [['Oskar', 'Lindqvist', 'LIN', 4, 0.984], ['Rafael', 'Costa', 'COS', 81, 0.975]] },
    { id: 'norrland', name: 'Norrland Racing', short: 'NOR', base: '#0f4d33', accent: '#e8e2c9', third: '#b49149', car: 'amr26', power: 0.99, aero: 0.975, rating: 86,
      engine: 'Vanta V6', drivers: [['Felix', 'Hart', 'HAR', 14, 0.98], ['Kenji', 'Mori', 'MOR', 22, 0.972]] },
    { id: 'solenne', name: 'Solenne F1 Team', short: 'SOL', base: '#0b2a6e', accent: '#3fb7ff', third: '#ffffff', car: 'fw48', power: 0.985, aero: 0.975, rating: 84,
      engine: 'Ferro 066', drivers: [['Pierre', 'Gasquet', 'GAS', 10, 0.976], ['Noah', 'Bennett', 'BEN', 31, 0.97]] },
    { id: 'kodiak', name: 'Kodiak Racing', short: 'KOD', base: '#1a2f8f', accent: '#e21d2a', third: '#f2c230', car: 'rb22', power: 0.985, aero: 0.97, rating: 82,
      engine: 'Halcyon H1', drivers: [['Liam', 'Doherty', 'DOH', 3, 0.975], ['Yuki', 'Tanabe', 'TAN', 12, 0.966]] },
    { id: 'tessera', name: 'Tessera', short: 'TES', base: '#3b1d70', accent: '#d86bff', third: '#ffffff', car: 'fw48', hue: 55, power: 0.98, aero: 0.97, rating: 80,
      engine: 'Halcyon H1', drivers: [['Viktor', 'Sokolov', 'SOK', 27, 0.97], ['Marco', 'Bellini', 'BEL', 2, 0.962]] },
    { id: 'brightwater', name: 'Brightwater', short: 'BRI', base: '#eef2f7', accent: '#14161a', third: '#d0021b', car: 'vf26', power: 0.98, aero: 0.96, rating: 77,
      engine: 'Ferro 066', drivers: [['Sam', 'Okafor', 'OKA', 23, 0.966], ['Hugo', 'Duval', 'DUV', 7, 0.958]] },
    { id: 'aurex', name: 'Aurex Racing', short: 'AUR', base: '#b9bdc4', accent: '#ff3d1f', third: '#121212', car: 'r26', power: 0.975, aero: 0.955, rating: 74,
      engine: 'Vanta V6', drivers: [['Daniel', 'Weber', 'WEB', 20, 0.962], ['Lucas', 'Moreau', 'MRU', 8, 0.954]] },
  ];

  // pace = fraction of the grip the AI learned each circuit allows (js/limits.js)
  const DIFFICULTY = [
    { id: 'rookie', name: 'ROOKIE', pace: 0.58, aggr: 0.25 },
    { id: 'amateur', name: 'AMATEUR', pace: 0.66, aggr: 0.45 },
    { id: 'pro', name: 'PRO', pace: 0.76, aggr: 0.7 },
    { id: 'expert', name: 'EXPERT', pace: 0.88, aggr: 0.85 },
    { id: 'legend', name: 'LEGEND', pace: 1.0, aggr: 1.0 },
  ];

  const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

  F1.Data = { TEAMS, DIFFICULTY, POINTS };
})(typeof window !== 'undefined' ? window : globalThis);
