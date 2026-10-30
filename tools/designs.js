// New circuits for tools/trackdesign.js. Either a surveyor's turtle
// ([straight before the corner (m), turn (deg, + right), radius (m)], two flex straights solved
// to close the loop) or a corner map v ([x, y, radius], y down) with startAt, as in js/tracks.js.
module.exports = [
  {
    // island circuit: a long thin lap of straights, chicanes and one hairpin, walls everywhere
    id: 'ileverte', name: 'Circuit Île Verte', country: 'Canada', flag: 'CA', width: 12, style: 'street', seed: 61,
    pit: { side: 1, entry: -320, exit: 220, offset: 17, lane: 10 },
    turtle: [[380, -50, 22], [70, 70, 24], [260, 20, 220], [280, -35, 60], [170, 60, 35], [110, 100, 15], [330, 15, 140],
      [400, -35, 22], [45, 35, 22], [900, 30, 60], [200, 60, 40], [300, 90, 25], [260, -40, 18], [45, 40, 18]], flex: [9, 11],
  },
  {
    // mountain circuit: climbing esses, a crest sweeper, a hairpin at the far end, a long plunge back
    id: 'sierra', name: 'Sierra Alta', country: 'Spain', flag: 'ES', width: 14, style: 'park', seed: 67,
    pit: { side: 1, entry: -400, exit: 240, offset: 22, lane: 12 },
    v: [[900, 0, 25], [940, 190, 60], [1090, 310, 70], [1110, 480, 80], [1420, 720, 250], [1480, 1080, 16], [1080, 780, 60],
      [880, 960, 45], [480, 1120, 150], [100, 1000, 90], [-160, 700, 40], [-230, 330, 200], [-80, 0, 60]], startAt: 0.45,
  },
  {
    // anticlockwise bowl: a plunging left-right at the start, a long sweep up the far side, an
    // infield knot, then a flat-out curving climb back to the line
    id: 'bahia', name: 'Autódromo Bahia Dourada', country: 'Brazil', flag: 'BR', width: 14, style: 'park', seed: 71,
    pit: { side: -1, entry: -380, exit: 230, offset: 22, lane: 12 },
    v: [[700, 0, 35], [830, -110, 40], [1100, -200, 220], [1180, -560, 300], [1100, -900, 45], [760, -960, 60], [520, -780, 22],
      [640, -520, 25], [380, -420, 30], [160, -640, 35], [-200, -560, 160], [-320, -220, 250], [-340, 0, 150]], startAt: 0.45,
  },
  {
    // forest speed circuit: a long run out through the trees, a chicane, the long far curve, the
    // run back with another chicane, then a tight stadium section in front of the stands
    id: 'nordwald', name: 'Nordwald Ring', country: 'Germany', flag: 'DE', width: 15, style: 'park', seed: 73,
    pit: { side: 1, entry: -330, exit: 240, offset: 22, lane: 12 },
    v: [[560,0,60], [1300,360,600], [1656,562,18], [1699,547,18], [2088,756,150], [2124,1008,150], [1584,900,600], [1080,756,18], [1037,778,18], [648,648,250], [288,590,22], [144,432,20], [-72,446,18], [-180,288,40], [-216,108,90], [-252,0,70]], startAt: 0.5,
  },
  {
    // modern anticlockwise venue: uphill first-corner hairpin, fast esses, a kilometre back
    // straight into a hairpin, a stadium section and a long left onto the straight
    id: 'lonestar', name: 'Lone Star Motor Course', country: 'United States', flag: 'US', width: 15, style: 'modern', seed: 79,
    pit: { side: -1, entry: -420, exit: 260, offset: 24, lane: 12 },
    v: [[780, 0, 22], [580, -160, 70], [540, -320, 80], [420, -420, 80], [380, -580, 70], [200, -700, 40], [-900, -760, 18],
      [-650, -560, 40], [-560, -380, 30], [-720, -300, 25], [-640, -150, 30], [-420, -120, 120], [-380, 0, 80]], startAt: 0.45,
  },
];
