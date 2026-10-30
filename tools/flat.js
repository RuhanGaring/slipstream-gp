// Infinite flat asphalt for the physics rigs (accel, skidpad, calib): patches the track
// queries the car uses and returns a one-sample track with every field the model reads.
module.exports = F1 => {
  F1.Tracks.surfaceAt = () => 0;
  F1.Tracks.locate = (tr, x, y, h, out) => { out = out || {}; out.i = 0; out.s = 0; out.d = 0; return out; };
  F1.Tracks.surfZ = () => 0;
  F1.Tracks.roadZ = () => 0;
  return { N: 1, ds: 2, L: 1e9, x: [0], y: [0], tx: [1], ty: [0], nx: [0], ny: [1], z: [0], dz: [0], ddz: [0], bank: [0], hw: 100, kerbW: 1, kerbL: [0], kerbR: [0] };
};
