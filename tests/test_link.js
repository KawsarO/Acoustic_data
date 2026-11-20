require('./load.js');
const M = globalThis.Modem;
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } };

// --- RS unit tests
let r = 1; const rnd = () => (r = (r * 1103515245 + 12345) >>> 0) / 4294967296;
for (let trial = 0; trial < 3000; trial++) {
  const k = 1 + Math.floor(rnd() * 34), nsym = [8, 12][trial % 2];
  const msg = Array.from({ length: k }, () => Math.floor(rnd() * 256));
  const cw = M.rsEncode(msg, nsym);
  const n = cw.length, bad = cw.slice();
  const nerr = Math.floor(rnd() * (nsym / 2 + 1)); // within capacity
  const pos = new Set(); while (pos.size < nerr) pos.add(Math.floor(rnd() * n));
  for (const p of pos) bad[p] ^= 1 + Math.floor(rnd() * 255);
  let out; try { out = M.rsDecode(bad, nsym); } catch (e) { out = null; }
  ok(out && out.join() === cw.join(), `rs errors k=${k} nsym=${nsym} nerr=${nerr}`);
  // erasures: e erasures + f errors with e + 2f <= nsym
  const e = Math.floor(rnd() * (nsym + 1)), f = Math.floor((nsym - e) / 2);
  const bad2 = cw.slice(), pos2 = new Set(); while (pos2.size < Math.min(n, e + f)) pos2.add(Math.floor(rnd() * n));
  const arr = [...pos2], er = arr.slice(0, e);
  for (const p of arr) bad2[p] ^= 1 + Math.floor(rnd() * 255);
  try { out = M.rsDecode(bad2, nsym, er); } catch (ex) { out = null; }
  ok(out && out.join() === cw.join(), `rs erasures k=${k} nsym=${nsym} e=${e} f=${f}`);
}
console.log('RS unit tests done, fails =', fails);

// --- end-to-end loopback through simulated channel
function run(band, speed, text, ch, fsTx = 48000, fsRx = 48000) {
  const pt = M.makeParams(band, speed, fsTx), pr = M.makeParams(band, speed, fsRx);
  const payload = new TextEncoder().encode(text);
  let sig = M.synthesize(pt, M.buildFrame(M.TYPE.TEXT, payload), 0.7);
  if (fsTx !== fsRx) { // naive resample for cross-rate test
    const ratio = fsTx / fsRx, out = new Float32Array(Math.floor(sig.length / ratio));
    for (let i = 0; i < out.length; i++) { const t = i * ratio, k = Math.floor(t), f = t - k; out[i] = sig[k] * (1 - f) + (sig[k + 1] || 0) * f; }
    sig = out;
  }
  const rx = M.simulateChannel(sig, fsRx, ch);
  const events = [];
  const R = new M.Receiver(pr, { onEvent: e => events.push(e) });
  for (let i = 0; i < rx.length; i += 512) R.push(rx.subarray(i, i + 512));
  const pk = events.find(e => e.type === 'packet');
  const got = pk ? new TextDecoder().decode(pk.payload) : null;
  return { ok: got === text, pk, events };
}
const text = 'Hello from the acoustic modem! 0123456789 — testing UTF-8 ✓. The quick brown fox jumps over the lazy dog, repeatedly, to fill a few blocks.';
console.log('payload bytes', new TextEncoder().encode(text).length);
for (const band of ['ultra', 'upper', 'debug']) for (const speed of ['robust', 'standard', 'fast']) {
  const p = M.makeParams(band, speed, 48000);
  const rows = [];
  for (const snr of [0, -10, -15, -18, -21]) {
    const res = run(band, speed, text, { snrDb: snr, ppm: 120, seed: 7 });
    rows.push(`${snr}dB:${res.ok ? 'OK' : 'x'}${res.pk ? `(snr${res.pk.snrAvg.toFixed(0)} fix${res.pk.corrected}/er${res.pk.erasures})` : ''}`);
    if (snr >= -10) ok(res.ok, `${band}/${speed} @${snr}dB`);
  }
  console.log(`${band.padEnd(5)} ${speed.padEnd(8)} ${p.rawBps.toFixed(0)}bps air=${M.airtime(p, 139).toFixed(1)}s | ${rows.join('  ')}`);
}
// loud low-frequency room noise (hum/speech-band energy ~5x the signal amplitude)
for (const band of ['ultra', 'debug']) {
  const r2 = run(band, 'standard', text, { snrDb: -5, ppm: 80, hum: 3.5, seed: 11 });
  console.log(`${band} with loud LF noise:`, r2.ok); ok(r2.ok, 'hum ' + band);
}
// clock drift worst case and cross sample-rate
let res = run('ultra', 'standard', 'x'.repeat(255), { snrDb: -5, ppm: 300, seed: 3 });
console.log('255B @300ppm:', res.ok, res.pk && res.pk.blocksOk + '/' + res.pk.nBlocks); ok(res.ok, '300ppm');
res = run('ultra', 'standard', text, { snrDb: -5, ppm: -200, seed: 4 }, 44100, 48000);
console.log('44.1k TX -> 48k RX:', res.ok); ok(res.ok, 'cross rate');
res = run('ultra', 'standard', text, { snrDb: -5, ppm: 0, seed: 5 }, 48000, 44100);
console.log('48k TX -> 44.1k RX:', res.ok); ok(res.ok, 'cross rate 2');
// false-alarm check: 60 s of noise only
{
  const p = M.makeParams('ultra', 'standard', 48000); let n = 0;
  const R = new M.Receiver(p, { onEvent: e => { if (e.type === 'sync') n++; } });
  const z = new Float32Array(48000 * 60);
  let s = 12345; const g = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  for (let i = 0; i < z.length; i++) z[i] = 0.3 * g();
  for (let i = 0; i < z.length; i += 1024) R.push(z.subarray(i, i + 1024));
  console.log('false syncs in 60 s noise:', n); ok(n === 0, 'false alarm');
}
// two back-to-back packets
{
  const p = M.makeParams('ultra', 'standard', 48000);
  const a = M.synthesize(p, M.buildFrame(0, new TextEncoder().encode('first'))), b = M.synthesize(p, M.buildFrame(0, new TextEncoder().encode('second one')));
  const sig = new Float32Array(a.length + b.length); sig.set(a); sig.set(b, a.length);
  const rx = M.simulateChannel(sig, 48000, { snrDb: -5, seed: 2 });
  const got = []; const R = new M.Receiver(p, { onEvent: e => { if (e.type === 'packet') got.push(new TextDecoder().decode(e.payload)); } });
  for (let i = 0; i < rx.length; i += 777) R.push(rx.subarray(i, i + 777));
  console.log('back-to-back:', got); ok(got.join('|') === 'first|second one', 'b2b');
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
