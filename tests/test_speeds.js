require('./load.js'); const M = globalThis.Modem;
const text = 'Hello from the acoustic modem 👋 — Milestone 2 tuning run, three blocks of payload text here.';
function run(band, speed, ch) {
  const p = M.makeParams(band, speed, 48000), pay = new TextEncoder().encode(text);
  const rx = M.simulateChannel(M.synthesize(p, M.buildFrame(0, pay)), 48000, ch);
  let pk = null, fails = 0; const R = new M.Receiver(p, { onEvent: e => { if (e.type === 'packet') pk = e; if (e.type === 'header_fail') fails++; } });
  for (let i = 0; i < rx.length; i += 512) R.push(rx.subarray(i, i + 512));
  return pk && new TextDecoder().decode(pk.payload) === text ? `OK(${pk.snrAvg.toFixed(0)}/${pk.snrMin.toFixed(0)}dB fix${pk.corrected})` : 'x';
}
const rooms = { 'mild echo': [[0.003, 0.3], [0.009, 0.15]], 'harsh echo': undefined };
for (const speed of ['standard', 'fast', 'turbo', 'max']) {
  const p = M.makeParams('ultra', speed, 48000);
  for (const [rn, ec] of Object.entries(rooms)) {
    const row = [10, 0, -5, -10].map(snr => `${snr}dB:${run('ultra', speed, { snrDb: snr, ppm: 100, echoes: ec, seed: 3 })}`);
    console.log(`${speed.padEnd(8)} ${p.rawBps.toFixed(0).padStart(3)}bps air=${M.airtime(p, 96).toFixed(1)}s ${rn.padEnd(10)} | ${row.join('  ')}`);
  }
}
// in-band colored noise: narrowband filtered noise in 16.8–19 kHz, no signal — count false syncs
{
  const p = M.makeParams('ultra', 'standard', 48000), fs = 48000, n = fs * 60;
  let s = 7; const g = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const x = new Float32Array(n); // AR resonators around 17.5k and 18.4k + occasional clicks
  const res = [[17500, 0.995], [18400, 0.99]].map(([f, r]) => ({ a1: 2 * r * Math.cos(2 * Math.PI * f / fs), a2: -r * r, y1: 0, y2: 0 }));
  for (let i = 0; i < n; i++) { const w = g(); let v = 0; for (const q of res) { const y = w + q.a1 * q.y1 + q.a2 * q.y2; q.y2 = q.y1; q.y1 = y; v += y; } if (i % 9973 === 0) v += 8 * (g() > 0 ? 1 : -1); x[i] = v * 0.02; }
  for (const thr of [0.2, 0.35]) {
    let syncs = 0; const R = new M.Receiver(p, { threshold: thr, onEvent: e => { if (e.type === 'sync') syncs++; } });
    let maxN = 0; for (let i = 0; i < n; i += 1024) { R.push(x.subarray(i, i + 1024)); maxN = Math.max(maxN, R.lastNcc); }
    console.log(`colored noise 60 s, user thr ${thr}: false syncs ${syncs}, max noise NCC ${maxN.toFixed(3)}, learned noiseNcc ${R.noiseNcc.toFixed(3)}, effThr ${R.effThr().toFixed(2)}`);
  }
}
