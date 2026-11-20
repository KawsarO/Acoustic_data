/* Receiver: chirp search (FFT matched filter), Goertzel demod, FEC decode, events. */
(function (M) {
'use strict';
const { NTONES, FRAME, HDR_SYMS, rsDecodeSoft, crc16, fft, nextPow2, makeChirp, blockLayout } = M;

// ---------------------------------------------------------------- RX
class Receiver {
  constructor(p, opts = {}) {
    this.p = p;
    this.threshold = opts.threshold ?? 0.35;   // field logs: room-noise peaks 0.20–0.21, real chirps 0.59–0.90
    this.noiseNcc = 0;                         // slow average of per-hop max NCC when no chirp is present
    this.on = opts.onEvent || (() => {});
    this.R = 1 << 21; this.mask = this.R - 1; this.buf = new Float32Array(this.R); this.total = 0;
    this.L = p.chirpLen; this.HOP = 8192; this.N = nextPow2(this.HOP + this.L);
    const tpl = makeChirp(p);
    this.Tre = new Float64Array(this.N); this.Tim = new Float64Array(this.N);
    let e = 0; for (let i = 0; i < tpl.length; i++) { this.Tre[i] = tpl[i]; e += tpl[i] * tpl[i]; }
    this.tnorm = Math.sqrt(e);
    fft(this.Tre, this.Tim, false);
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    this.bre = new Float64Array(this.N); this.bim = new Float64Array(this.N);
    this.bp = new Float64Array(this.N);                  // soft band-pass around the chirp band
    const lo = p.chirpF0 - 250, hi = p.chirpF1 + 250, edge = 250;
    for (let k = 0; k <= this.N / 2; k++) {
      const f = k * p.fs / this.N;
      let g = 0;
      if (f >= lo && f <= hi) g = 1;
      else if (f > lo - edge && f < lo) g = 0.5 - 0.5 * Math.cos(Math.PI * (f - (lo - edge)) / edge);
      else if (f > hi && f < hi + edge) g = 0.5 + 0.5 * Math.cos(Math.PI * (f - hi) / edge);
      this.bp[k] = g; if (k > 0 && k < this.N / 2) this.bp[this.N - k] = g;
    }
    this.pre = new Float64Array(this.HOP + this.L);
    this.hann = new Float64Array(p.win);
    for (let i = 0; i < p.win; i++) this.hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (p.win - 1));
    this.coef = p.tones.map(f => 2 * Math.cos(2 * Math.PI * f / p.fs));
    this.tmp = new Float64Array(p.win);
    this.E = new Float64Array(NTONES);
    this.cursor = 0; this.state = 'search'; this.deferred = false; this.lastNcc = 0; this.pk = null;
  }
  get(i) { return this.buf[i & this.mask]; }
  /** Effective sync threshold: user floor, raised automatically in rooms with structured noise. */
  effThr() { return Math.min(0.6, Math.max(this.threshold, 2.0 * this.noiseNcc)); }
  push(chunk) {
    for (let i = 0; i < chunk.length; i++) this.buf[(this.total + i) & this.mask] = chunk[i];
    this.total += chunk.length;
    if (this.total - this.cursor > this.R - this.N) this.cursor = this.total - this.HOP - this.L; // fell behind
    for (;;) {
      if (this.state === 'search') {
        if (this.total >= this.cursor + this.HOP + this.L) this._search(); else return;
      } else if (!this._packetStep()) return;
    }
  }
  progress() {
    if (this.state !== 'packet' || !this.pk) return null;
    const need = this.pk.phase === 'header' ? HDR_SYMS : this.pk.layout.totalSyms;
    return { got: this.pk.syms.length, need, phase: this.pk.phase };
  }
  _search() {
    const { N, L, HOP, re, im, pre } = this;
    const n = HOP + L - 1;
    re.fill(0); im.fill(0);
    for (let j = 0; j < n; j++) re[j] = this.get(this.cursor + j);
    fft(re, im, false);
    // Band-pass in the frequency domain so out-of-band room noise (speech, HVAC) does not dilute the NCC.
    const { bre, bim, bp } = this;
    for (let k = 0; k < N; k++) {
      const a = re[k] * bp[k], b = im[k] * bp[k];
      bre[k] = a; bim[k] = b;
      const c = this.Tre[k], d = this.Tim[k];                // X * conj(T)
      re[k] = a * c + b * d; im[k] = b * c - a * d;
    }
    fft(bre, bim, true);
    for (let j = 0; j < n; j++) pre[j + 1] = pre[j] + bre[j] * bre[j];
    fft(re, im, true);
    let best = 0, bi = -1;
    for (let k = 0; k < HOP; k++) {
      const E = pre[k + L] - pre[k];
      if (E < 1e-10) continue;
      const v = re[k] / (this.tnorm * Math.sqrt(E));
      if (v > best) { best = v; bi = k; }
    }
    this.lastNcc = best;
    const thr = this.effThr();
    if (best < thr) this.noiseNcc = this.noiseNcc ? 0.97 * this.noiseNcc + 0.03 * best : best;
    if (best >= thr) {
      if (bi > HOP - L / 2 && !this.deferred) { this.cursor += Math.max(1, bi - (L >> 1)); this.deferred = true; return; }
      this.deferred = false;
      this._startPacket(this.cursor + bi, best);
    } else { this.cursor += HOP; this.deferred = false; }
  }
  _startPacket(a, ncc) {
    this.pk = { a, ncc, dataStart: a + this.L + this.p.gapLen, syms: [], snr: [], conf: [], phase: 'header',
                blocks: [], nextBlock: 0, t0: Date.now() };
    this.state = 'packet';
    this.on({ type: 'sync', sample: a, ncc, pk: this.pk });
  }
  _demod(i) {
    const p = this.p, start = Math.round(this.pk.dataStart + i * p.slot + p.guard);
    const x = this.tmp, E = this.E;
    for (let n = 0; n < p.win; n++) x[n] = this.get(start + n) * this.hann[n];
    let m1 = -1, m2 = -1, s = 0, sum = 0;
    for (let t = 0; t < NTONES; t++) {
      const c = this.coef[t]; let s1 = 0, s2 = 0;
      for (let n = 0; n < p.win; n++) { const s0 = x[n] + c * s1 - s2; s2 = s1; s1 = s0; }
      E[t] = s1 * s1 + s2 * s2 - c * s1 * s2; sum += E[t];
      if (m1 < 0 || E[t] > E[m1]) { m2 = m1; m1 = t; } else if (m2 < 0 || E[t] > E[m2]) m2 = t;
    }
    s = m1;
    const others = (sum - E[m1]) / (NTONES - 1) + 1e-20;
    return { sym: s, snr: 10 * Math.log10(E[m1] / others + 1e-20), conf: 10 * Math.log10(E[m1] / (E[m2] + 1e-20) + 1e-20) };
  }
  _packetStep() {
    const pk = this.pk, p = this.p, i = pk.syms.length;
    const end = Math.round(pk.dataStart + i * p.slot + p.guard) + p.win;
    if (end > this.total) return false;
    const d = this._demod(i);
    pk.syms.push(d.sym); pk.snr.push(d.snr); pk.conf.push(d.conf);
    if (pk.phase === 'header' && pk.syms.length === HDR_SYMS) this._decodeHeader();
    else if (pk.phase === 'data' && pk.syms.length === pk.layout.blocks[pk.nextBlock].endSym) this._decodeBlock();
    return true;
  }
  _bytes(s0, s1) {
    const pk = this.pk, bytes = [], conf = [];
    for (let i = s0; i < s1; i += 2) {
      bytes.push((pk.syms[i] << 4) | pk.syms[i + 1]);
      conf.push(Math.min(pk.conf[i], pk.conf[i + 1]));
    }
    return { bytes, conf };
  }
  _decodeHeader() {
    const pk = this.pk;
    const { bytes, conf } = this._bytes(0, HDR_SYMS);
    const r = rsDecodeSoft(bytes, FRAME.hdrPar, conf, (cw) =>
      crc16(cw, 0, 8) === ((cw[8] << 8) | cw[9]) && (cw[0] >> 4) === FRAME.version && (cw[0] & 15) <= 1 && cw[3] === FRAME.blkData);
    const snr = avg(pk.snr);
    if (!r) {
      this.on({ type: 'header_fail', sample: pk.a, ncc: pk.ncc, snrAvg: snr, snrMin: Math.min(...pk.snr) });
      this.state = 'search'; this.cursor = pk.a + this.L; this.pk = null; return;
    }
    const h = r.cw;
    pk.type = h[0] & 15; pk.len = (h[1] << 8) | h[2]; pk.meta = h.slice(4, 8);
    pk.hdrFix = { corrected: r.corrected, erasures: r.erasures };
    pk.layout = blockLayout(pk.len);
    pk.payload = new Uint8Array(pk.len);
    pk.phase = 'data';
    this.on({ type: 'header', ptype: pk.type, len: pk.len, meta: pk.meta, nBlocks: pk.layout.blocks.length, layout: pk.layout,
              corrected: r.corrected, erasures: r.erasures, snrAvg: snr,
              eta: pk.layout.totalSyms * (this.p.ts + this.p.tg) });
    if (pk.len === 0) this._finish();
  }
  _decodeBlock() {
    const pk = this.pk, b = pk.layout.blocks[pk.nextBlock];
    const { bytes, conf } = this._bytes(b.startSym, b.endSym);
    const r = rsDecodeSoft(bytes, FRAME.blkPar, conf, (cw) =>
      crc16(cw, 0, b.dlen) === ((cw[b.dlen] << 8) | cw[b.dlen + 1]));
    const snrs = pk.snr.slice(b.startSym, b.endSym);
    const fixed = []; if (r) for (let i = 0; i < b.dlen; i++) if (bytes[i] !== r.cw[i]) fixed.push(i);
    const info = { index: pk.nextBlock, ok: !!r, raw: bytes.slice(0, b.dlen), fixed, corrected: r ? r.corrected : null, erasures: r ? r.erasures : null,
                   snrAvg: avg(snrs), snrMin: Math.min(...snrs) };
    if (r) pk.payload.set(r.cw.slice(0, b.dlen), b.off);
    pk.blocks.push(info);
    this.on(Object.assign({ type: 'block', nBlocks: pk.layout.blocks.length, off: b.off, dlen: b.dlen,
                            data: r ? Uint8Array.from(r.cw.slice(0, b.dlen)) : null }, info));
    pk.nextBlock++;
    if (pk.nextBlock === pk.layout.blocks.length) this._finish();
  }
  _finish() {
    const pk = this.pk;
    const ok = pk.blocks.filter(b => b.ok).length;
    this.on({ type: 'packet', ptype: pk.type, len: pk.len, meta: pk.meta, payload: pk.payload,
              blocksOk: ok, nBlocks: pk.blocks.length, blocks: pk.blocks, ncc: pk.ncc, hdr: pk.hdrFix,
              snrAvg: avg(pk.snr), snrMin: Math.min(...pk.snr),
              corrected: pk.blocks.reduce((s, b) => s + (b.corrected || 0), 0),
              erasures: pk.blocks.reduce((s, b) => s + (b.erasures || 0), 0) });
    this.cursor = Math.round(pk.dataStart + pk.syms.length * this.p.slot);
    this.state = 'search'; this.pk = null;
  }
}
const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

Object.assign(M, { Receiver });
})(globalThis.Modem = globalThis.Modem || {});
