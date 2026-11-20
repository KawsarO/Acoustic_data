require('./load.js'); const M = globalThis.Modem;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
// synthetic test picture: gradient + circle + bars
function picture(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, inC = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (w / 4) ** 2;
    d[i] = inC ? 230 : x * 255 / w; d[i + 1] = inC ? 60 : y * 255 / h; d[i + 2] = (x >> 3) % 2 ? 200 : 40; d[i + 3] = 255;
  }
  return d;
}
// unit: pack/unpack roundtrip for every raw format and odd sizes
for (const fmt of [0, 1, 2, 3]) for (const [w, h] of [[64, 64], [37, 23], [128, 96]]) {
  const idx = M.quantizeImage(picture(w, h), w, h, fmt, true);
  const s = M.packImage(idx, w, h, fmt), u = M.unpackImage(s, new Uint8Array(s.length).fill(1), w, h, fmt);
  ok(s.length === M.imgRawSize(w, h, fmt) && u.pix.join() === idx.join(), `pack roundtrip fmt${fmt} ${w}x${h}`);
}
// end-to-end: packets -> audio with gaps -> channel -> receiver -> assembler
function transmit(packets, p, dropIdx = -1) {
  const gap = new Float32Array(Math.round(M.IMG.gap * p.fs)), parts = [];
  for (const pk of packets) { const s = M.synthesize(p, pk.frame, 0.6); if (pk.index === dropIdx) s.fill(0); parts.push(s, gap); }
  const sig = new Float32Array(parts.reduce((a, b) => a + b.length, 0)); let o = 0; for (const s of parts) { sig.set(s, o); o += s.length; }
  return sig;
}
function receive(sig, p, asmIn) {
  let asm = asmIn || null, cur = null;
  const R = new M.Receiver(p, { onEvent: e => {
    if (e.type === 'header' && e.ptype === M.TYPE.IMAGE) { cur = M.imageMeta(e.meta); if (!asm) asm = new M.ImageAssembler(cur.fmt, cur.w, cur.h, cur.imgId); }
    if (e.type === 'block' && cur && e.ok) asm.addBlock(cur.pkt, e.off, e.data);
  } });
  for (let i = 0; i < sig.length; i += 1024) R.push(sig.subarray(i, i + 1024));
  R.push(new Float32Array(p.fs));
  return asm;
}
const W = 64, H = 64;
for (const fmt of [0, 1, 3]) {
  const p = M.makeParams('ultra', 'fast', 48000);
  const idx = M.quantizeImage(picture(W, H), W, H, fmt, true), stream = M.packImage(idx, W, H, fmt);
  const pk = M.imagePackets(stream, fmt, W, H, 5);
  const air = M.airtime(p, 96) * pk.length + M.IMG.gap * pk.length;
  const rx = M.simulateChannel(transmit(pk, p), 48000, { snrDb: -6, ppm: 120, seed: 30 + fmt });
  const asm = receive(rx, p);
  const u = M.unpackImage(asm.buf, asm.known, W, H, fmt);
  ok(asm.complete() && u.pix.join() === idx.join(), `e2e fmt${fmt}`);
  console.log(`${M.IMG.names[fmt].padEnd(32)} ${stream.length} B -> ${pk.length} packets, ~${air.toFixed(0)} s at Fast: ${asm.complete() && u.pix.join() === idx.join() ? 'bit-exact' : 'MISMATCH'} (coverage ${(asm.coverage() * 100).toFixed(0)}%)`);
}
// lost packet + resend
{
  const p = M.makeParams('ultra', 'fast', 48000), fmt = 0;
  const idx = M.quantizeImage(picture(W, H), W, H, fmt, true), stream = M.packImage(idx, W, H, fmt), pk = M.imagePackets(stream, fmt, W, H, 9);
  const asm = receive(M.simulateChannel(transmit(pk, p, 2), 48000, { snrDb: -6, ppm: 80, seed: 77 }), p);
  const miss = asm.missing();
  console.log('drop packet 2 -> missing list', miss, `coverage ${(asm.coverage() * 100).toFixed(0)}%`);
  ok(miss.join() === '2', 'missing list');
  const filled = M.fillMissing(...Object.values(M.unpackImage(asm.buf, asm.known, W, H, fmt)), W, H);
  let diff = 0; for (let i = 0; i < idx.length; i++) diff += filled[i] !== idx[i]; console.log(`  row-fill estimate: ${(100 - diff / idx.length * 100).toFixed(0)}% of pixels already correct before resend`);
  receive(M.simulateChannel(transmit([pk[2]], p), 48000, { snrDb: -6, seed: 78 }), p, asm);
  ok(asm.complete(), 'resend completes'); console.log('  after resending packet 2: complete =', asm.complete());
}
// JPEG-style opaque byte stream with length prefix
{
  const p = M.makeParams('ultra', 'fast', 48000), body = new Uint8Array(700).map((_, i) => (i * 37 + 11) & 255);
  const stream = new Uint8Array(2 + body.length); stream[0] = body.length >> 8; stream[1] = body.length & 255; stream.set(body, 2);
  const pk = M.imagePackets(stream, M.IMG.FMT.JPEG, 64, 48, 3);
  const asm = receive(M.simulateChannel(transmit(pk, p), 48000, { snrDb: -6, seed: 5 }), p);
  const pre = asm.jpegPrefix();
  ok(pre.complete && pre.bytes.join() === body.join(), 'jpeg stream'); console.log('JPEG stream 702 B ->', pk.length, 'packets:', pre.complete ? 'bit-exact' : 'FAIL');
}
console.log(fails ? `${fails} FAILURES` : 'ALL PASS');
