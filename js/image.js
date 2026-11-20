/* Image codec: quantize/dither, interlaced packing, packetizer, receive-side assembler. */
(function (M) {
'use strict';
const { TYPE, buildFrame } = M;

// ---------------------------------------------------------------- images (Phase 3)
// Each image is split into packets of IMG.pktPayload bytes. Every packet is a full frame (own chirp + header),
// so timing re-syncs per packet. Header meta = [fmt<<4 | imgId, width, height, packetIndex] -> packets are
// self-describing and can be placed even if earlier packets were lost.
const IMG = {
  pktPayload: 96,          // 3 RS blocks per packet (~7 s at Fast)
  gap: 0.25,               // silence between packets (s)
  FMT: { BW1: 0, GRAY2: 1, GRAY4: 2, COLOR4: 3, JPEG: 4 },
  names: ['1-bit B/W, dithered', '2-bit gray (4 levels)', '4-bit gray (16 levels)', '4-bit color (16-color palette)', 'JPEG (full color, fragile)'],
  bits: [1, 2, 4, 4, 0],
  // DawnBringer 16 palette: fixed on both ends, so it never has to be sent
  palette: [[20,12,28],[68,36,52],[48,52,109],[78,74,78],[133,76,48],[52,101,36],[208,70,72],[117,113,97],
            [89,125,206],[210,125,44],[133,149,161],[109,170,44],[210,170,153],[109,194,202],[218,212,94],[222,238,214]],
};
function imgRowBytes(w, fmt) { return Math.ceil(w * IMG.bits[fmt] / 8); }
function imgRawSize(w, h, fmt) { return imgRowBytes(w, fmt) * h; }
/** Coarse-to-fine row order: every 8th row, then 4th, 2nd, then the rest. */
function interlaceRows(h) {
  const out = [], seen = new Uint8Array(h);
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
    for (let y = start; y < h; y += step) if (!seen[y]) { seen[y] = 1; out.push(y); }
  return out;
}
function indexColor(fmt, idx) {
  if (fmt === IMG.FMT.COLOR4) return IMG.palette[idx];
  const levels = 1 << IMG.bits[fmt], v = Math.round(idx * 255 / (levels - 1));
  return [v, v, v];
}
/** RGBA (Uint8ClampedArray) -> palette/gray indices, optional Floyd-Steinberg dithering. */
function quantizeImage(rgba, w, h, fmt, dither = true, stretch = true) {
  const n = w * h, out = new Uint8Array(n), color = fmt === IMG.FMT.COLOR4, ch = color ? 3 : 1;
  const v = new Float32Array(n * ch);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255, c = [0, 1, 2].map(k => rgba[i * 4 + k] * a + 255 * (1 - a));
    if (color) { v[i * 3] = c[0]; v[i * 3 + 1] = c[1]; v[i * 3 + 2] = c[2]; }
    else v[i] = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  }
  if (!color && stretch && n > 1) {          // auto-levels: map the 2nd..98th luminance percentile to full black..white
    const sorted = Float32Array.from(v).sort(), lo = sorted[Math.floor(n * 0.02)], hi = sorted[Math.floor(n * 0.98)];
    if (hi - lo > 8) for (let i = 0; i < n; i++) v[i] = Math.max(0, Math.min(255, (v[i] - lo) * 255 / (hi - lo)));
  }
  const levels = color ? 16 : 1 << IMG.bits[fmt];
  const spread = (x, y, err) => {
    if (!dither) return;
    const add = (dx, dy, f) => { const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= w || yy >= h) return;
      const j = (yy * w + xx) * ch; for (let k = 0; k < ch; k++) v[j + k] += err[k] * f; };
    add(1, 0, 7 / 16); add(-1, 1, 3 / 16); add(0, 1, 5 / 16); add(1, 1, 1 / 16);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (color) {
      let best = 0, bd = Infinity;
      for (let p = 0; p < 16; p++) {
        const P = IMG.palette[p], d = (v[i*3]-P[0])**2 + (v[i*3+1]-P[1])**2 + (v[i*3+2]-P[2])**2;
        if (d < bd) { bd = d; best = p; }
      }
      out[i] = best; const P = IMG.palette[best];
      spread(x, y, [v[i*3] - P[0], v[i*3+1] - P[1], v[i*3+2] - P[2]]);
    } else {
      const q = Math.max(0, Math.min(levels - 1, Math.round(v[i] / 255 * (levels - 1))));
      out[i] = q; spread(x, y, [v[i] - q * 255 / (levels - 1)]);
    }
  }
  return out;
}
/** Indices -> byte stream, rows in interlaced order, MSB-first bit packing. */
function packImage(idx, w, h, fmt) {
  const b = IMG.bits[fmt], rb = imgRowBytes(w, fmt), rows = interlaceRows(h), out = new Uint8Array(rb * h);
  rows.forEach((y, k) => {
    for (let x = 0; x < w; x++) {
      const bit = x * b, byte = k * rb + (bit >> 3), shift = 8 - b - (bit & 7);
      out[byte] |= idx[y * w + x] << shift;
    }
  });
  return out;
}
/** Byte stream + per-byte known mask -> pixel indices and per-pixel "have" mask. */
function unpackImage(stream, known, w, h, fmt) {
  const b = IMG.bits[fmt], rb = imgRowBytes(w, fmt), rows = interlaceRows(h), mask = (1 << b) - 1;
  const pix = new Uint8Array(w * h), have = new Uint8Array(w * h);
  rows.forEach((y, k) => {
    for (let x = 0; x < w; x++) {
      const bit = x * b, byte = k * rb + (bit >> 3);
      if (!known[byte]) continue;
      pix[y * w + x] = (stream[byte] >> (8 - b - (bit & 7))) & mask; have[y * w + x] = 1;
    }
  });
  return { pix, have };
}
/** Fill missing pixels from the nearest received pixel in the same column (gives the progressive look). */
function fillMissing(pix, have, w, h, fallback = 0) {
  const out = pix.slice();
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    if (have[y * w + x]) continue;
    let v = fallback;
    for (let d = 1; d < h; d++) {
      if (y - d >= 0 && have[(y - d) * w + x]) { v = pix[(y - d) * w + x]; break; }
      if (y + d < h && have[(y + d) * w + x]) { v = pix[(y + d) * w + x]; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}
/** Split an image byte stream into frames. Returns [{index, payload, frame}]. */
function imagePackets(stream, fmt, w, h, imgId) {
  const n = Math.ceil(stream.length / IMG.pktPayload);
  if (n > 255) throw new Error(`image needs ${n} packets (max 255): pick a smaller size or format`);
  if (w > 255 || h > 255) throw new Error('max image dimension is 255');
  const out = [];
  for (let i = 0; i < n; i++) {
    const payload = stream.subarray(i * IMG.pktPayload, Math.min(stream.length, (i + 1) * IMG.pktPayload));
    out.push({ index: i, payload, frame: buildFrame(TYPE.IMAGE, payload, [(fmt << 4) | (imgId & 15), w, h, i]) });
  }
  return out;
}
function imageMeta(meta) { return { fmt: meta[0] >> 4, imgId: meta[0] & 15, w: meta[1], h: meta[2], pkt: meta[3] }; }

/** Collects image bytes from (possibly partial / out-of-order / repeated) packets. */
class ImageAssembler {
  constructor(fmt, w, h, imgId) {
    this.fmt = fmt; this.w = w; this.h = h; this.imgId = imgId;
    this.cap = fmt === IMG.FMT.JPEG ? 255 * IMG.pktPayload : imgRawSize(w, h, fmt);
    this.buf = new Uint8Array(this.cap); this.known = new Uint8Array(this.cap);
    this.heard = new Set();
  }
  static key(m) { return `${m.imgId}/${m.fmt}/${m.w}x${m.h}`; }
  get key() { return ImageAssembler.key(this); }
  get total() {   // JPEG streams start with a 2-byte length
    if (this.fmt !== IMG.FMT.JPEG) return this.cap;
    return (this.known[0] && this.known[1]) ? Math.min(this.cap, 2 + ((this.buf[0] << 8) | this.buf[1])) : null;
  }
  get nPackets() { const t = this.total; return t == null ? null : Math.ceil(t / IMG.pktPayload); }
  addBlock(pkt, off, data) {
    this.heard.add(pkt);
    const base = pkt * IMG.pktPayload + off;
    for (let i = 0; i < data.length && base + i < this.cap; i++) { this.buf[base + i] = data[i]; this.known[base + i] = 1; }
  }
  packetStatus(i) {
    const t = this.total ?? (i + 1) * IMG.pktPayload, a = i * IMG.pktPayload, b = Math.min(t, a + IMG.pktPayload);
    let k = 0; for (let j = a; j < b; j++) k += this.known[j];
    return k === b - a ? 'ok' : k ? 'partial' : (this.heard.has(i) ? 'partial' : 'missing');
  }
  missing() { const n = this.nPackets; if (n == null) return null; const out = []; for (let i = 0; i < n; i++) if (this.packetStatus(i) !== 'ok') out.push(i); return out; }
  coverage() { const t = this.total; if (!t) return 0; let k = 0; for (let j = 0; j < t; j++) k += this.known[j]; return k / t; }
  complete() { const m = this.missing(); return !!m && m.length === 0; }
  /** Longest contiguous run of JPEG bytes from the start (truncated JPEGs still decode the top part). */
  jpegPrefix() {
    const t = this.total; if (t == null) return null;
    let n = 2; while (n < t && this.known[n]) n++;
    return { bytes: this.buf.slice(2, n), complete: n === t };
  }
}

Object.assign(M, { IMG, imgRowBytes, imgRawSize, interlaceRows, indexColor, quantizeImage, packImage, unpackImage, fillMissing, imagePackets, imageMeta, ImageAssembler });
})(globalThis.Modem = globalThis.Modem || {});
