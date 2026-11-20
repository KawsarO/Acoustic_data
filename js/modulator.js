/* Chirp preamble, framing and continuous-phase 16-MFSK synthesis. */
(function (M) {
'use strict';
const { FRAME, TYPE, HDR_SYMS, crc16, rsEncode } = M;

// ---------------------------------------------------------------- TX
function makeChirp(p) {
  const L = p.chirpLen, T = L / p.fs, k = (p.chirpF1 - p.chirpF0) / T, out = new Float32Array(L);
  const taper = Math.round(L * 0.05);
  for (let n = 0; n < L; n++) {
    const t = n / p.fs;
    let w = 1;
    if (n < taper) w = 0.5 - 0.5 * Math.cos(Math.PI * n / taper);
    else if (n >= L - taper) w = 0.5 - 0.5 * Math.cos(Math.PI * (L - 1 - n) / taper);
    out[n] = w * Math.sin(2 * Math.PI * (p.chirpF0 * t + 0.5 * k * t * t));
  }
  return out;
}

function blockLayout(len) {
  const blocks = [];
  let sym = HDR_SYMS;
  for (let off = 0; off < len; off += FRAME.blkData) {
    const dlen = Math.min(FRAME.blkData, len - off);
    const nbytes = dlen + 2 + FRAME.blkPar;
    blocks.push({ off, dlen, nbytes, startSym: sym, endSym: sym + nbytes * 2 });
    sym += nbytes * 2;
  }
  return { blocks, totalSyms: sym };
}

/** Build on-air bytes: header codeword followed by data block codewords. */
function buildFrame(type, payload, meta = [0, 0, 0, 0]) {
  const len = payload.length;
  const h = [(FRAME.version << 4) | type, len >> 8, len & 255, FRAME.blkData, meta[0] | 0, meta[1] | 0, meta[2] | 0, meta[3] | 0];
  const hc = crc16(h); h.push(hc >> 8, hc & 255);
  let out = rsEncode(h, FRAME.hdrPar);
  for (const b of blockLayout(len).blocks) {
    const d = Array.from(payload.subarray(b.off, b.off + b.dlen));
    const c = crc16(d); d.push(c >> 8, c & 255);
    out = out.concat(rsEncode(d, FRAME.blkPar));
  }
  return Uint8Array.from(out);
}
function bytesToSymbols(bytes) {
  const s = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) { s[2 * i] = bytes[i] >> 4; s[2 * i + 1] = bytes[i] & 15; }
  return s;
}
function synthesize(p, frameBytes, amp = 0.7) {
  const syms = bytesToSymbols(frameBytes);
  const lead = Math.round(FRAME.lead * p.fs), tail = Math.round(FRAME.tail * p.fs);
  const dataStart = lead + p.chirpLen + p.gapLen;
  const dataLen = Math.ceil(syms.length * p.slot);
  const out = new Float32Array(dataStart + dataLen + tail);
  const ch = makeChirp(p);
  for (let i = 0; i < ch.length; i++) out[lead + i] = amp * ch[i];
  const ramp = Math.round(0.004 * p.fs);
  let phase = 0;
  for (let n = 0; n < dataLen; n++) {
    const si = Math.min(syms.length - 1, Math.floor(n / p.slot));
    phase += 2 * Math.PI * p.tones[syms[si]] / p.fs;      // continuous phase: no clicks between symbols
    if (phase > 1e4) phase %= 2 * Math.PI;
    let w = 1;
    if (n < ramp) w = 0.5 - 0.5 * Math.cos(Math.PI * n / ramp);
    else if (n >= dataLen - ramp) w = 0.5 - 0.5 * Math.cos(Math.PI * (dataLen - 1 - n) / ramp);
    out[dataStart + n] = amp * w * Math.sin(phase);
  }
  return out;
}
function airtime(p, payloadLen) {
  const { totalSyms } = blockLayout(payloadLen);
  return FRAME.lead + FRAME.chirpDur + FRAME.preGap + totalSyms * (p.ts + p.tg) + FRAME.tail;
}

Object.assign(M, { makeChirp, blockLayout, buildFrame, bytesToSymbols, synthesize, airtime });
})(globalThis.Modem = globalThis.Modem || {});
