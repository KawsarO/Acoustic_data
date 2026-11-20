/* GF(256) Reed-Solomon (errors + erasures) and CRC-16/CCITT-FALSE. */
(function (M) {
'use strict';

// ---------------------------------------------------------------- GF(256)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
const gdiv = (a, b) => { if (!b) throw new Error('div0'); return a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0; };
const gpow = (a, p) => EXP[(((LOG[a] * p) % 255) + 255) % 255];
const ginv = (a) => EXP[255 - LOG[a]];
function pScale(p, x) { return p.map(c => gmul(c, x)); }
function pAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}
function pMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= gmul(p[i], q[j]);
  return r;
}
function pEval(p, x) { let y = p[0]; for (let i = 1; i < p.length; i++) y = gmul(y, x) ^ p[i]; return y; }
function pDivRem(dividend, divisor) {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const c = out[i];
    if (c) for (let j = 1; j < divisor.length; j++) if (divisor[j]) out[i + j] ^= gmul(divisor[j], c);
  }
  return out.slice(out.length - (divisor.length - 1));
}

// ---------------------------------------------------------------- Reed-Solomon
const genCache = {};
function rsGen(nsym) {
  if (genCache[nsym]) return genCache[nsym];
  let g = [1];
  for (let i = 0; i < nsym; i++) g = pMul(g, [1, gpow(2, i)]);
  return (genCache[nsym] = g);
}
function rsEncode(msg, nsym) {
  const g = rsGen(nsym);
  const out = new Array(msg.length + nsym).fill(0);
  for (let i = 0; i < msg.length; i++) out[i] = msg[i];
  for (let i = 0; i < msg.length; i++) {
    const c = out[i];
    if (c) for (let j = 1; j < g.length; j++) out[i + j] ^= gmul(g[j], c);
  }
  for (let i = 0; i < msg.length; i++) out[i] = msg[i];
  return out;
}
function rsSyndromes(msg, nsym) {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(pEval(msg, gpow(2, i)));
  return s;
}
function rsErrataLocator(coefPos) {
  let loc = [1];
  for (const i of coefPos) loc = pMul(loc, pAdd([1], [gpow(2, i), 0]));
  return loc;
}
function rsCorrectErrata(msg, synd, errPos) {
  const coefPos = errPos.map(p => msg.length - 1 - p);
  const errLoc = rsErrataLocator(coefPos);
  const sr = synd.slice().reverse();
  const rem = pDivRem(pMul(sr, errLoc), [1].concat(new Array(errLoc.length).fill(0)));
  const errEval = rem.reverse();
  const X = coefPos.map(cp => gpow(2, cp));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const XiInv = ginv(X[i]);
    let prime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) prime = gmul(prime, 1 ^ gmul(XiInv, X[j]));
    if (prime === 0) throw new Error('forney');
    const y = gmul(X[i], pEval(errEval.slice().reverse(), XiInv));
    E[errPos[i]] = gdiv(y, prime);
  }
  return pAdd(msg, E);
}
function rsForneySyndromes(synd, pos, n) {
  const f = synd.slice(1);
  for (const p of pos) {
    const x = gpow(2, n - 1 - p);
    for (let j = 0; j < f.length - 1; j++) f[j] = gmul(f[j], x) ^ f[j + 1];
  }
  return f;
}
function rsErrorLocator(synd, nsym, eraseCount) {
  let errLoc = [1], oldLoc = [1];
  const shift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + shift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= gmul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta) {
      if (oldLoc.length > errLoc.length) {
        const nl = pScale(oldLoc, delta);
        oldLoc = pScale(errLoc, ginv(delta));
        errLoc = nl;
      }
      errLoc = pAdd(errLoc, pScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  if ((errLoc.length - 1 - eraseCount) * 2 + eraseCount > nsym) throw new Error('too many errors');
  return errLoc;
}
function rsFindErrors(errLocRev, n) {
  const errs = errLocRev.length - 1, pos = [];
  for (let i = 0; i < n; i++) if (pEval(errLocRev, gpow(2, i)) === 0) pos.push(n - 1 - i);
  if (pos.length !== errs) throw new Error('chien');
  return pos;
}
/** Decode a codeword (array of bytes). Returns the corrected full codeword or throws. */
function rsDecode(cw, nsym, erasePos) {
  erasePos = erasePos || [];
  if (erasePos.length > nsym) throw new Error('too many erasures');
  let msg = Array.from(cw);
  for (const e of erasePos) msg[e] = 0;
  let synd = rsSyndromes(msg, nsym);
  if (Math.max(...synd) === 0) return msg;
  const fs = rsForneySyndromes(synd, erasePos, msg.length);
  const errLoc = rsErrorLocator(fs, nsym, erasePos.length);
  const errPos = rsFindErrors(errLoc.slice().reverse(), msg.length);
  msg = rsCorrectErrata(msg, synd, erasePos.concat(errPos));
  synd = rsSyndromes(msg, nsym);
  if (Math.max(...synd) !== 0) throw new Error('uncorrectable');
  return msg;
}
/** Soft decode: errors-only first, then mark the least-confident bytes as erasures. */
function rsDecodeSoft(cw, nsym, conf, validate) {
  const attempt = (er) => {
    try { const out = rsDecode(cw, nsym, er); if (validate(out)) return out; } catch (e) { /* try next */ }
    return null;
  };
  let out = attempt([]), er = 0;
  if (!out) {
    const order = conf.map((c, i) => i).sort((a, b) => conf[a] - conf[b]);
    for (er = 2; er <= nsym && !out; er += 2) out = attempt(order.slice(0, er));
    er -= 2;
  }
  if (!out) return null;
  let corrected = 0;
  for (let i = 0; i < cw.length; i++) if (cw[i] !== out[i]) corrected++;
  return { cw: out, corrected, erasures: er };
}

// ---------------------------------------------------------------- CRC-16/CCITT-FALSE
function crc16(b, start = 0, end = b.length) {
  let c = 0xffff;
  for (let i = start; i < end; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

Object.assign(M, { rsEncode, rsDecode, rsDecodeSoft, crc16 });
})(globalThis.Modem = globalThis.Modem || {});
