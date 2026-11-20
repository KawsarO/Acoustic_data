/* Test helpers: simulated room channel and WAV writer. */
(function (M) {
'use strict';

// ---------------------------------------------------------------- test helpers
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
/** Crude acoustic channel: delay, echoes, clock-rate offset (ppm), white noise at wideband SNR (dB). */
function simulateChannel(sig, fs, o = {}) {
  const rnd = mulberry32(o.seed ?? 1);
  const delay = Math.round((o.delay ?? 0.3) * fs);
  const echoes = o.echoes ?? [[0.007, 0.35], [0.019, 0.2], [0.041, 0.1]];
  const ratio = 1 + (o.ppm ?? 0) * 1e-6;
  const n = Math.ceil((sig.length + delay) / ratio) + Math.round(0.3 * fs);
  const y = new Float32Array(sig.length + delay + Math.round(0.1 * fs));
  for (let i = 0; i < sig.length; i++) y[i + delay] += sig[i];
  for (const [d, g] of echoes) { const k = Math.round(d * fs); for (let i = 0; i < sig.length && i + delay + k < y.length; i++) y[i + delay + k] += g * sig[i]; }
  let pw = 0, cnt = 0; for (let i = 0; i < sig.length; i++) if (sig[i] !== 0) { pw += sig[i] * sig[i]; cnt++; }
  pw /= Math.max(1, cnt);
  const sigma = Math.sqrt(pw / Math.pow(10, (o.snrDb ?? 0) / 10));
  const out = new Float32Array(n), H = 16, PH = 256;       // polyphase windowed-sinc resampler (flat to ~0.45 fs)
  if (!simulateChannel.tbl) {
    const tbl = new Float32Array((PH + 1) * 2 * H);
    for (let ph = 0; ph <= PH; ph++) for (let j = -H + 1; j <= H; j++) {
      const x = j - ph / PH, w = 0.42 + 0.5 * Math.cos(Math.PI * x / H) + 0.08 * Math.cos(2 * Math.PI * x / H);
      tbl[ph * 2 * H + j + H - 1] = (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
    }
    simulateChannel.tbl = tbl;
  }
  const tbl = simulateChannel.tbl;
  for (let i = 0; i < n; i++) {
    const t = i * ratio, k = Math.floor(t), f = t - k;
    let v = 0;
    if (ratio === 1) v = k < y.length ? y[k] : 0;
    else {
      const base = Math.round(f * PH) * 2 * H;
      for (let j = -H + 1; j <= H; j++) {
        const idx = k + j; if (idx >= 0 && idx < y.length) v += y[idx] * tbl[base + j + H - 1];
      }
    }
    const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    let lf = 0;
    if (o.hum) lf = o.hum * (Math.sin(2 * Math.PI * 120 * i / fs) + 0.6 * Math.sin(2 * Math.PI * 340 * i / fs + 1) + 0.4 * Math.sin(2 * Math.PI * 900 * i / fs));
    out[i] = v + sigma * g + lf;
  }
  return out;
}
function encodeWav(samples, fs) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return buf;
}

Object.assign(M, { simulateChannel, encodeWav });
})(globalThis.Modem = globalThis.Modem || {});
