/* UI: transmit/receive pages, plots and reconstruction views. Uses window.Modem. */
(() => {
'use strict';
const M = window.Modem;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: false });

// ------------------------------------------------------------ settings
for (const [k, b] of Object.entries(M.BANDS)) $('band').add(new Option(b.name, k));
for (const [k, s] of Object.entries(M.SPEEDS)) $('speed').add(new Option(s.name, k));
$('speed').value = 'fast';                      // best performer in field tests (Nov 2026)
try { const s = JSON.parse(localStorage.getItem('amodem') || '{}'); if (s.band) $('band').value = s.band; if (s.speed) $('speed').value = s.speed; } catch (e) {}
if (!window.isSecureContext) $('secureWarn').classList.remove('hide');

let ctx = null;
const fsNow = () => (ctx ? ctx.sampleRate : 48000);
const params = (fs) => M.makeParams($('band').value, $('speed').value, fs || fsNow());

function showParams() {
  const p = params(), F = M.FRAME;
  const net = p.rawBps * F.blkData / (F.blkData + 2 + F.blkPar);
  const rows = [
    ['modulation', `16-MFSK, ${p.tones[0]}–${p.tones[15]} Hz, ${p.spacing} Hz spacing`],
    ['symbol', `${(p.ts * 1000).toFixed(0)} ms integrate + ${(p.tg * 1000).toFixed(0)} ms guard = ${p.baud.toFixed(1)} baud`],
    ['rate', `${p.rawBps.toFixed(0)} bit/s raw, about ${net.toFixed(0)} bit/s after FEC`],
    ['sync', `linear chirp ${p.chirpF0} → ${p.chirpF1} Hz, ${F.chirpDur * 1000} ms`],
    ['FEC', `RS(${F.blkData + 2 + F.blkPar},${F.blkData + 2}) + CRC-16 per block, header RS(${F.hdrInfo + F.hdrPar},${F.hdrInfo})`],
  ];
  $('paramTable').innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
  updateTxInfo(); scheduleTxPreview();
  try { localStorage.setItem('amodem', JSON.stringify({ band: $('band').value, speed: $('speed').value })); } catch (e) {}
}
$('band').onchange = $('speed').onchange = () => { showParams(); if (rxRunning) restartReceiver(); };

// ------------------------------------------------------------ nav
function tab(which) {
  $('navTx').classList.toggle('on', which === 'tx'); $('navRx').classList.toggle('on', which === 'rx');
  $('txPanel').classList.toggle('hide', which !== 'tx'); $('rxPanel').classList.toggle('hide', which !== 'rx');
  sizeCanvases(); if (which === 'tx') scheduleTxPreview(); else drawSymbols();
}
function route() { if (location.hash === '#rx') tab('rx'); else if (location.hash === '#tx' || !location.hash) tab('tx'); }
window.addEventListener('hashchange', route);

async function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

// ------------------------------------------------------------ plotting helpers
function sizeCanvases() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of document.querySelectorAll('canvas.plot')) {
    if (!c.dataset.h) c.dataset.h = c.getAttribute('height');
    const w = Math.round(c.clientWidth * dpr), h = Math.round(+c.dataset.h * dpr);
    c.style.height = c.dataset.h + 'px';
    if (w && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; c.dataset.dpr = dpr; }
  }
}
window.addEventListener('resize', () => { sizeCanvases(); scheduleTxPreview(); drawSymbols(); });
// parula-like colormap (the MATLAB default)
const CMAP = [[0, 53, 42, 135], [0.2, 3, 99, 225], [0.4, 20, 132, 212], [0.6, 56, 185, 158], [0.8, 209, 187, 89], [1, 249, 251, 14]];
function cmap(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < CMAP.length; i++) if (v <= CMAP[i][0]) {
    const a = CMAP[i - 1], b = CMAP[i], t = (v - a[0]) / (b[0] - a[0]);
    return [a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])];
  }
  return CMAP[CMAP.length - 1].slice(1);
}
function viewRange(p) {
  if (!$('zoom').checked) return [0, p.fs / 2];
  return [Math.max(0, p.chirpF0 - 800), Math.min(p.fs / 2, p.chirpF1 + 800)];
}
const MARGIN = { l: 44, b: 22, t: 6, r: 8 };
function plotBox(c) { const d = +c.dataset.dpr || 1; return { d, x0: MARGIN.l * d, y0: MARGIN.t * d, w: c.width - (MARGIN.l + MARGIN.r) * d, h: c.height - (MARGIN.t + MARGIN.b) * d }; }
function axes(g, c, box, xlab, ylab, xticks, yticks, outside) {
  const d = box.d;
  g.strokeStyle = '#111'; g.lineWidth = 1;
  if (outside) g.strokeRect(box.x0 - 1.5, box.y0 - 1.5, box.w + 3, box.h + 3);   // keep the border out of the scrolling image
  else g.strokeRect(box.x0 + .5, box.y0 + .5, box.w, box.h);
  g.fillStyle = '#111'; g.font = `${11 * d}px "IBM Plex Mono", monospace`;
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const [x, s] of xticks) { g.fillText(s, x, box.y0 + box.h + 4 * d); g.beginPath(); g.moveTo(x, box.y0 + box.h); g.lineTo(x, box.y0 + box.h - 4 * d); g.stroke(); }
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const [y, s] of yticks) { g.fillText(s, box.x0 - 4 * d, y); g.beginPath(); g.moveTo(box.x0, y); g.lineTo(box.x0 + 4 * d, y); g.stroke(); }
  g.save(); g.translate(10 * d, box.y0 + box.h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText(ylab, 0, 0); g.restore();
  if (xlab) { g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(xlab, box.x0 + box.w - 2 * d, box.y0 + box.h - 2 * d); }
}
function freqTicks(box, f0, f1) {
  const step = (f1 - f0) > 6000 ? 2000 : (f1 - f0) > 2500 ? 500 : 250, out = [];
  for (let f = Math.ceil(f0 / step) * step; f <= f1; f += step) out.push([box.x0 + (f - f0) / (f1 - f0) * box.w, (f / 1000).toFixed(step < 1000 ? 2 : 0).replace(/\.?0+$/, '') + 'k']);
  return out;
}

// ------------------------------------------------------------ TX
function txPayload() { let b = enc.encode($('txText').value); if (b.length > M.FRAME.maxText) b = b.slice(0, M.FRAME.maxText); return b; }
function updateTxInfo() {
  const raw = enc.encode($('txText').value).length, b = Math.min(raw, M.FRAME.maxText), p = params();
  const nb = M.blockLayout(b).blocks.length, onAir = M.buildFrame(0, txPayload()).length;
  $('txInfo').innerHTML = `${raw}/${M.FRAME.maxText} bytes${raw > M.FRAME.maxText ? ' <span class="bad">(will be cut off)</span>' : ''}, ${nb} block${nb === 1 ? '' : 's'}, ${onAir} bytes on air, about ${M.airtime(p, b).toFixed(1)} s`;
}
let txPrevTimer = null;
function scheduleTxPreview() { clearTimeout(txPrevTimer); txPrevTimer = setTimeout(drawTxPreview, 250); }
$('txText').oninput = () => { updateTxInfo(); scheduleTxPreview(); };
$('vol').oninput = () => $('volV').textContent = (+$('vol').value).toFixed(2);
$('zoom').onchange = scheduleTxPreview;

function drawTxPreview() {
  const c = $('txSpec'); if (!c.clientWidth || $('txPanel').classList.contains('hide')) return;
  sizeCanvases();
  const fs = 48000, p = params(fs), sig = M.synthesize(p, M.buildFrame(0, txPayload()), 0.7);
  const N = 1024, hop = 240, frames = Math.max(1, Math.floor((sig.length - N) / hop));
  const g = c.getContext('2d'), box = plotBox(c), [f0, f1] = viewRange(p), binHz = fs / N;
  const b0 = Math.floor(f0 / binHz), b1 = Math.ceil(f1 / binHz);
  const W = Math.round(box.w), H = Math.round(box.h), img = g.createImageData(W, H);
  const colMax = new Float32Array(W * H).fill(-200);
  const re = new Float64Array(N), im = new Float64Array(N), win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  for (let fr = 0; fr < frames; fr++) {
    const x = Math.min(W - 1, Math.floor(fr / frames * W));
    for (let i = 0; i < N; i++) { re[i] = sig[fr * hop + i] * win[i]; im[i] = 0; }
    M.fft(re, im, false);
    for (let b = b0; b <= b1; b++) {
      const y = H - 1 - Math.floor((b * binHz - f0) / (f1 - f0) * H); if (y < 0 || y >= H) continue;
      const db = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-12);
      if (db > colMax[y * W + x]) colMax[y * W + x] = db;
    }
  }
  // fill gaps between frequency bins and between frames
  for (let x = 0; x < W; x++) for (let y = 1; y < H; y++) if (colMax[y * W + x] === -200) colMax[y * W + x] = colMax[(y - 1) * W + x];
  for (let x = 1; x < W; x++) for (let y = 0; y < H; y++) if (colMax[y * W + x] === -200) colMax[y * W + x] = colMax[y * W + x - 1];
  for (let i = 0; i < W * H; i++) {
    const [r, gg, b] = cmap(colMax[i] / 50);
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.putImageData(img, box.x0, box.y0);
  const dur = sig.length / fs, tticks = [];
  const tstep = dur > 12 ? 2 : dur > 4 ? 1 : 0.5;
  for (let t = 0; t <= dur; t += tstep) tticks.push([box.x0 + t / dur * box.w, t.toFixed(tstep < 1 ? 1 : 0) + 's']);
  const fstep = (f1 - f0) > 6000 ? 4000 : 1000, fticks = [];
  for (let f = Math.ceil(f0 / fstep) * fstep; f <= f1; f += fstep) fticks.push([box.y0 + box.h - (f - f0) / (f1 - f0) * box.h, (f / 1000) + 'k']);
  axes(g, c, box, 'time', 'Hz', tticks, fticks);
}

let txSrc = null, txTimer = null, txAnim = null, stopRequested = false;
async function transmit() {
  await ensureCtx();
  const p = params(), payload = txPayload(), frame = M.buildFrame(M.TYPE.TEXT, payload);
  const sig = M.synthesize(p, frame, +$('vol').value);
  const buf = ctx.createBuffer(1, sig.length, p.fs); buf.getChannelData(0).set(sig);
  txSrc = ctx.createBufferSource(); txSrc.buffer = buf; txSrc.connect(ctx.destination);
  const t0 = ctx.currentTime, dur = sig.length / p.fs;
  txSrc.start();
  setTxBusy(true);
  $('txOut').textContent = `sending ${payload.length} B (${frame.length} B on air) at ${p.fs} Hz, ${dur.toFixed(1)} s ...`;
  cancelAnimationFrame(txAnim);
  const tick = () => { $('txBar').value = Math.min(100, (ctx.currentTime - t0) / dur * 100); if (txSrc) txAnim = requestAnimationFrame(tick); };
  tick();
  txSrc.onended = () => {
    txSrc = null; $('txBar').value = 100;
    if ($('repeat').checked && !stopRequested) { txTimer = setTimeout(transmit, +$('repeatGap').value * 1000); $('txOut').textContent += ' done, repeating'; }
    else { setTxBusy(false); $('txOut').textContent += ' done'; }
  };
}
$('btnSend').onclick = () => { stopRequested = false; transmit().catch(e => $('txOut').textContent = 'error: ' + e.message); };
$('btnStopTx').onclick = () => {
  stopRequested = true; clearTimeout(txTimer);
  if (txSrc) { try { txSrc.stop(); } catch (e) {} }
  setTxBusy(false);
};
$('btnWav').onclick = () => {
  const p = params(48000);
  const sig = M.synthesize(p, M.buildFrame(M.TYPE.TEXT, txPayload()), +$('vol').value);
  download(new Blob([M.encodeWav(sig, 48000)], { type: 'audio/wav' }), `amodem_${p.bandKey}_${p.speedKey}.wav`);
};
$('btnSelfTest').onclick = () => {
  $('txOut').textContent = 'running simulated room (echoes + hum + clock drift) ...';
  setTimeout(() => {
    const p = params(48000), payload = txPayload();
    const sig = M.synthesize(p, M.buildFrame(M.TYPE.TEXT, payload), 0.7);
    const lines = ['  SNR(wideband)  drift    result'];
    for (const [snr, ppm] of [[0, 50], [-8, 120], [-12, 150], [-15, 200]]) {
      const rxs = M.simulateChannel(sig, 48000, { snrDb: snr, ppm, hum: 1, seed: Math.floor(Math.random() * 1e9) });
      let pk = null; const R = new M.Receiver(p, { onEvent: e => { if (e.type === 'packet') pk = e; } });
      for (let i = 0; i < rxs.length; i += 2048) R.push(rxs.subarray(i, i + 2048));
      const good = pk && pk.blocksOk === pk.nBlocks && dec.decode(pk.payload) === dec.decode(payload);
      lines.push(`  ${String(snr).padStart(4)} dB       ${String(ppm).padStart(3)} ppm  ${good ? 'pass' : 'FAIL'}` +
        (pk ? `  (symbol SNR ${pk.snrAvg.toFixed(1)} dB, ${pk.corrected} bytes fixed, ${pk.blocksOk}/${pk.nBlocks} blocks)` : '  (no sync)'));
    }
    $('txOut').textContent = lines.join('\n');
  }, 30);
};

// ------------------------------------------------------------ image TX
M.IMG.names.forEach((n, i) => $('imgFmt').add(new Option(n, i)));
let imgSrc = null, imgPrep = null, imgSeq = Math.floor(Math.random() * 16), prepToken = 0;
function setTxBusy(b) {
  $('btnSend').disabled = b; $('btnSendImg').disabled = b || !imgPrep; $('btnResend').disabled = b || !imgPrep;
  $('btnWavImg').disabled = !imgPrep; $('btnStopTx').disabled = !b; $('btnStopImg').disabled = !b;
}
const fmtTime = (s) => s < 90 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
function testPattern() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 256); sky.addColorStop(0, '#9cc8ec'); sky.addColorStop(1, '#f2f9fd');
  g.fillStyle = sky; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#f6c343'; g.beginPath(); g.arc(190, 70, 34, 0, 7); g.fill();
  g.fillStyle = '#2f5f2c'; g.beginPath(); g.moveTo(0, 256); g.lineTo(0, 170); g.lineTo(70, 120); g.lineTo(140, 175); g.lineTo(200, 140); g.lineTo(256, 180); g.lineTo(256, 256); g.fill();
  g.fillStyle = '#1b2a4a'; g.font = 'bold 64px Georgia, serif'; g.fillText('ECE', 20, 90);
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#111' : '#eee'; g.fillRect(i * 32, 232, 32, 24); }
  return c;
}
$('btnPattern').onclick = () => { imgSrc = testPattern(); prepImage(); };
$('imgIn').onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try { imgSrc = await createImageBitmap(f); }
  catch (e) {
    try { imgSrc = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(f); }); }
    catch (e2) { $('imgInfo').innerHTML = '<span class="bad">could not read that image file</span>'; return; }
  }
  prepImage();
};
['imgSize', 'imgFmt', 'imgDither', 'imgStretch'].forEach(id => $(id).onchange = () => prepImage());
$('jpegQ').oninput = () => { $('jpegQV').textContent = (+$('jpegQ').value).toFixed(2); prepImage(); };
function idxToImageData(g, idx, w, h, fmt) {
  const im = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const c = M.indexColor(fmt, idx[i]); im.data[i * 4] = c[0]; im.data[i * 4 + 1] = c[1]; im.data[i * 4 + 2] = c[2]; im.data[i * 4 + 3] = 255; }
  return im;
}
function sized(cv, w, h) { if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return cv.getContext('2d'); }
async function prepImage() {
  const fmt = +$('imgFmt').value, isJ = fmt === M.IMG.FMT.JPEG;
  $('jpegQWrap').style.display = isJ ? '' : 'none'; $('imgDither').parentElement.style.display = isJ ? 'none' : ''; $('imgStretch').parentElement.style.display = isJ || fmt === M.IMG.FMT.COLOR4 ? 'none' : '';
  if (!imgSrc) return;
  const tok = ++prepToken;
  const N = +$('imgSize').value, sw = imgSrc.width, sh = imgSrc.height, sc = N / Math.max(sw, sh);
  const w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(imgSrc, 0, 0, w, h);
  sized($('imgOrig'), w, h).drawImage(c, 0, 0);
  try {
    let stream;
    if (isJ) {
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', +$('jpegQ').value));
      if (tok !== prepToken) return;
      const body = new Uint8Array(await blob.arrayBuffer());
      stream = new Uint8Array(body.length + 2); stream[0] = body.length >> 8; stream[1] = body.length & 255; stream.set(body, 2);
      const bm = await createImageBitmap(blob); if (tok !== prepToken) return;
      sized($('imgPrev'), w, h).drawImage(bm, 0, 0);
    } else {
      const idx = M.quantizeImage(g.getImageData(0, 0, w, h).data, w, h, fmt, $('imgDither').checked, $('imgStretch').checked);
      stream = M.packImage(idx, w, h, fmt);
      const pg = sized($('imgPrev'), w, h); pg.putImageData(idxToImageData(pg, idx, w, h, fmt), 0, 0);
    }
    imgSeq = (imgSeq + 1) & 15;
    const packets = M.imagePackets(stream, fmt, w, h, imgSeq), p = params();
    const secs = packets.reduce((t, pk) => t + M.airtime(p, pk.payload.length) + M.IMG.gap, 0);
    const onAir = packets.reduce((t, pk) => t + pk.frame.length, 0);
    imgPrep = { fmt, w, h, imgId: imgSeq, stream, packets };
    $('imgInfo').innerHTML = `${w}×${h} px, ${M.IMG.names[fmt]}: <b>${stream.length} bytes</b> → ${packets.length} packets (${onAir} bytes on air), about <b>${fmtTime(secs)}</b> at ${p.speedKey} speed · image id ${imgSeq}` +
      (secs > 180 ? ' <span class="warn">(long: try a smaller size or 1-bit)</span>' : '');
  } catch (e) { imgPrep = null; $('imgInfo').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  setTxBusy(!!txSrc);
}
function buildImageSignal(list, fs) {
  const p = params(fs), gap = Math.round(M.IMG.gap * p.fs), parts = [], marks = [];
  let t = 0;
  for (const pk of list) { const s = M.synthesize(p, pk.frame, +$('vol').value); marks.push({ t: t / p.fs, i: pk.index }); parts.push(s); t += s.length + gap; }
  const sig = new Float32Array(t); let o = 0;
  for (const s of parts) { sig.set(s, o); o += s.length + gap; }
  return { sig, marks, p };
}
function pickPackets(indices) { return indices ? imgPrep.packets.filter(pk => indices.includes(pk.index)) : imgPrep.packets; }
async function sendImage(indices) {
  if (!imgPrep) return;
  const list = pickPackets(indices);
  if (!list.length) { $('imgOut').textContent = `no such packets (this image has 0–${imgPrep.packets.length - 1})`; return; }
  await ensureCtx();
  stopRequested = false;
  const { sig, marks, p } = buildImageSignal(list, ctx.sampleRate);
  const buf = ctx.createBuffer(1, sig.length, p.fs); buf.getChannelData(0).set(sig);
  txSrc = ctx.createBufferSource(); txSrc.buffer = buf; txSrc.connect(ctx.destination);
  const t0 = ctx.currentTime, dur = sig.length / p.fs;
  txSrc.start(); setTxBusy(true);
  const label = indices ? `resending packet${list.length > 1 ? 's' : ''} ${list.map(k => k.index).join(', ')}` : `sending image ${imgPrep.w}×${imgPrep.h}`;
  cancelAnimationFrame(txAnim);
  const tick = () => {
    if (!txSrc) return;
    const el = ctx.currentTime - t0; let k = 0; while (k + 1 < marks.length && marks[k + 1].t <= el) k++;
    $('imgBar').value = Math.min(100, el / dur * 100);
    $('imgOut').textContent = `${label}: packet ${marks[k].i} (${k + 1} of ${marks.length}), ${fmtTime(Math.max(0, dur - el))} left`;
    txAnim = requestAnimationFrame(tick);
  };
  tick();
  txSrc.onended = () => {
    txSrc = null; setTxBusy(false); $('imgBar').value = stopRequested ? $('imgBar').value : 100;
    $('imgOut').textContent = `${label}: ${stopRequested ? 'stopped' : `done (${list.length} packet${list.length > 1 ? 's' : ''}, ${fmtTime(dur)})`}`;
  };
}
$('btnSendImg').onclick = () => sendImage(null).catch(e => $('imgOut').textContent = 'error: ' + e.message);
$('btnResend').onclick = () => {
  const l = $('resendList').value.split(/[^0-9]+/).filter(Boolean).map(Number);
  if (!l.length) { $('imgOut').textContent = 'type the packet numbers the receiver says are missing, e.g. 2, 5'; return; }
  sendImage(l).catch(e => $('imgOut').textContent = 'error: ' + e.message);
};
$('btnStopImg').onclick = () => $('btnStopTx').onclick();
$('btnWavImg').onclick = () => {
  if (!imgPrep) return;
  const { sig, p } = buildImageSignal(imgPrep.packets, 48000);
  download(new Blob([M.encodeWav(sig, 48000)], { type: 'audio/wav' }), `amodem_image${imgPrep.imgId}_${p.bandKey}_${p.speedKey}.wav`);
};

// ------------------------------------------------------------ RX state + reconstruction
let rxRunning = false, stream = null, srcNode = null, tapNode = null, sinkNode = null, analyser = null, rx = null, raf = null;
let peakNcc = 0, logEntries = [];
let recon = null;   // { pk, layout, blocks[], status, len }

function log(msg, cls, data) {
  const line = document.createElement('div'); if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`; $('log').appendChild(line); $('log').scrollTop = 1e9;
  if (data) logEntries.push(Object.assign({ t: new Date().toISOString() },
    rx && data.event !== 'start' ? { band: rx.p.bandKey, speed: rx.p.speedKey, thr: +rx.effThr().toFixed(3), noiseNcc: +rx.noiseNcc.toFixed(3) } : {}, data));
}
const fmt = (x) => (x == null || !isFinite(x) ? '-' : x.toFixed(1));
const hx = (b) => b.toString(16).padStart(2, '0');
const esc = (s) => s.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

function onEvent(e) {
  if (e.type === 'sync') {
    recon = { pk: e.pk, layout: null, blocks: [], status: 'header', len: 0 };
    log(`chirp sync, NCC=${e.ncc.toFixed(3)}`, 'dim', { event: 'sync', ncc: +e.ncc.toFixed(4) });
    renderRecon();
  } else if (e.type === 'header_fail') {
    if (recon) recon.status = 'header failed';
    log(`header failed (NCC ${e.ncc.toFixed(2)}, SNR ${fmt(e.snrAvg)}/${fmt(e.snrMin)} dB). Probably a false sync`, 'bad',
        { event: 'header_fail', ncc: +e.ncc.toFixed(4), snrAvg: +e.snrAvg.toFixed(2), snrMin: +e.snrMin.toFixed(2) });
    renderRecon(); drawSymbols();
  } else if (e.type === 'header') {
    if (recon) { recon.layout = e.layout; recon.len = e.len; recon.status = 'receiving'; recon.img = e.ptype === M.TYPE.IMAGE; }
    if (e.ptype === M.TYPE.IMAGE) onImageHeader(e);
    log(`header ok: ${e.ptype === 0 ? 'text' : `image #${M.imageMeta(e.meta).imgId} packet ${M.imageMeta(e.meta).pkt}`}, ${e.len} B, ${e.nBlocks} blocks, ${e.eta.toFixed(1)} s (fixed ${e.corrected})`, 'ok',
        Object.assign({ event: 'header', ptype: e.ptype, len: e.len, corrected: e.corrected, erasures: e.erasures, snrAvg: +e.snrAvg.toFixed(2) }, e.ptype === M.TYPE.IMAGE ? { img: M.imageMeta(e.meta) } : {}));
    renderRecon();
  } else if (e.type === 'block') {
    if (recon) recon.blocks[e.index] = e;
    if (recon && recon.img) onImageBlock(e);
    log(`  block ${e.index + 1}/${e.nBlocks} ${e.ok ? 'ok' : 'FAILED'}, SNR ${fmt(e.snrAvg)}/${fmt(e.snrMin)} dB${e.ok ? `, fixed ${e.corrected}, erased ${e.erasures}` : ''}`, e.ok ? '' : 'bad',
        { event: 'block', index: e.index, ok: e.ok, corrected: e.corrected, erasures: e.erasures, snrAvg: +e.snrAvg.toFixed(2), snrMin: +e.snrMin.toFixed(2) });
    renderRecon(); drawSymbols();
  } else if (e.type === 'packet') {
    const good = e.blocksOk === e.nBlocks, text = dec.decode(e.payload);
    if (recon) recon.status = good ? 'complete' : 'partial';
    $('mSnr').textContent = `${fmt(e.snrAvg)} / ${fmt(e.snrMin)} dB`;
    $('mBlk').innerHTML = `<span class="${good ? 'ok' : 'bad'}">${e.blocksOk}/${e.nBlocks}</span> / ${e.corrected}`;
    log(recon && recon.img ? `image packet ${good ? 'complete' : 'PARTIAL'} (${e.blocksOk}/${e.nBlocks} blocks)` : `packet ${good ? 'complete' : 'PARTIAL'}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`, good ? 'ok' : 'warn', {
      event: 'packet', ok: good, len: e.len, blocksOk: e.blocksOk, nBlocks: e.nBlocks, ncc: +e.ncc.toFixed(4),
      snrAvg: +e.snrAvg.toFixed(2), snrMin: +e.snrMin.toFixed(2), corrected: e.corrected, erasures: e.erasures, ...(recon && recon.img ? { image: true } : { text }) });
    if (recon && recon.img) { onImagePacket(); renderRecon(); drawSymbols(); return; }
    const li = document.createElement('li');
    li.innerHTML = `${reconText()}<br><span class="meta">${new Date().toLocaleTimeString()} · ${e.len} B · ${e.blocksOk}/${e.nBlocks} blocks · SNR ${fmt(e.snrAvg)} dB (min ${fmt(e.snrMin)}) · ${e.corrected} B fixed · sync ${e.ncc.toFixed(2)}</span>`;
    if (!good) li.querySelector('.meta').classList.add('bad');
    $('msgs').prepend(li);
    renderRecon(); drawSymbols();
  }
}
// Text from good blocks; lost blocks become a red run of dots of the right length.
function reconText() {
  if (!recon || !recon.layout) return '';
  let html = '';
  recon.layout.blocks.forEach((b, i) => {
    const r = recon.blocks[i]; if (!r) return;
    html += r.ok ? esc(dec.decode(r.data)) : `<span class="lost">${'·'.repeat(b.dlen)}</span>`;
  });
  return html;
}
function renderRecon() {
  if (!recon) return;
  const lines = [`<span class="dim">status: ${recon.status}${recon.layout ? `, ${recon.len} bytes in ${recon.layout.blocks.length} block(s)` : ''}</span>`];
  if (recon.layout) recon.layout.blocks.forEach((b, i) => {
    const r = recon.blocks[i], tag = `B${String(i).padStart(2, '0')} `;
    if (!r) { lines.push(`<span class="dim">${tag} ...  (waiting)</span>`); return; }
    const fixed = new Set(r.fixed || []);
    const st = r.ok ? '<span class="ok">ok  </span>' : '<span class="bad">FAIL</span>';
    const fx = r.ok ? `fix ${String(r.corrected).padStart(2)}${r.erasures ? ' er ' + r.erasures : ''}` : 'crc bad';
    for (let half = 0; half < b.dlen; half += 16) {
    let hex = '', asc = '';
    for (let k = half; k < Math.min(b.dlen, half + 16); k++) {
      const v = r.ok ? r.data[k] : r.raw[k], h = hx(v), ch = v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '.';
      if (!r.ok) { hex += `<s>${h}</s> `; asc += ch; }
      else if (fixed.has(k)) { hex += `<mark title="received as ${hx(r.raw[k])}">${h}</mark> `; asc += `<mark>${ch}</mark>`; }
      else { hex += h + ' '; asc += ch; }
    }
    const n = Math.min(16, b.dlen - half);
    lines.push((half ? ' '.repeat(tag.length + 15) : `${tag}${st} ${fx.padEnd(10)}`) + `| ${hex}${'   '.repeat(16 - n)}| ${asc}`);
    }
  });
  $('hex').innerHTML = lines.join('\n');
  const t = recon.img ? '' : reconText();
  $('textOut').innerHTML = t || `<span class="dim">${recon.img ? 'this is an image packet, see 2.3 below' : recon.status === 'header failed' ? 'header failed, not a real packet' : '...'}</span>`;
}

// Fig. 4: winning tone index per symbol for the current packet
function drawSymbols() {
  const c = $('symPlot'); if (!c.clientWidth || $('rxPanel').classList.contains('hide')) return;
  const g = c.getContext('2d'), box = plotBox(c), d = box.d;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  const pk = recon && recon.pk;
  const total = recon && recon.layout ? recon.layout.totalSyms : M.HDR_SYMS;
  const yOf = (t) => box.y0 + box.h - (t + 0.5) / 16 * box.h, xOf = (i) => box.x0 + (i + 0.5) / total * box.w;
  g.fillStyle = '#e6e6e6'; g.fillRect(box.x0, box.y0, M.HDR_SYMS / total * box.w, box.h);
  g.font = `${10 * d}px "IBM Plex Mono", monospace`; g.textAlign = 'left'; g.textBaseline = 'top';
  if (recon && recon.layout) recon.layout.blocks.forEach((b, i) => {
    const r = recon.blocks[i], x0 = box.x0 + b.startSym / total * box.w, x1 = box.x0 + b.endSym / total * box.w;
    if (r && !r.ok) { g.fillStyle = '#fbd3d3'; g.fillRect(x0, box.y0, x1 - x0, box.h); }
    g.strokeStyle = '#888'; g.setLineDash([4 * d, 3 * d]); g.beginPath(); g.moveTo(x0 + .5, box.y0); g.lineTo(x0 + .5, box.y0 + box.h); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#555'; g.fillText('B' + i, x0 + 3 * d, box.y0 + 2 * d);
  });
  g.fillStyle = '#555'; g.fillText('hdr', box.x0 + 3 * d, box.y0 + 2 * d);
  g.strokeStyle = '#efefef'; for (let t = 0; t < 16; t++) { const y = yOf(t); g.beginPath(); g.moveTo(box.x0, y); g.lineTo(box.x0 + box.w, y); g.stroke(); }
  if (pk) {
    const n = pk.syms.length, rad = Math.max(1.2 * d, Math.min(3 * d, box.w / total * 0.45));
    g.strokeStyle = 'rgba(0,0,0,0.15)'; g.beginPath();
    for (let i = 0; i < n; i++) { const x = xOf(i), y = yOf(pk.syms[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    for (let i = 0; i < n; i++) {
      const cf = pk.conf[i];
      g.fillStyle = cf > 8 ? '#111' : cf > 3 ? '#e07b00' : '#d00000';
      g.beginPath(); g.arc(xOf(i), yOf(pk.syms[i]), rad, 0, 2 * Math.PI); g.fill();
    }
  } else {
    g.fillStyle = '#999'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `${12 * d}px "IBM Plex Mono", monospace`;
    g.fillText('no packet yet', box.x0 + box.w / 2, box.y0 + box.h / 2);
  }
  const xt = [], step = total > 400 ? 100 : total > 150 ? 50 : 10;
  for (let i = 0; i <= total; i += step) xt.push([box.x0 + i / total * box.w, String(i)]);
  axes(g, c, box, 'symbol #', 'tone', xt, [0, 5, 10, 15].map(t => [yOf(t), String(t)]));
}

function makeReceiver(fs) { rx = new M.Receiver(params(fs), { threshold: +$('thr').value, onEvent }); $('mFs').textContent = `${fs} Hz`; }
function restartReceiver() { makeReceiver(ctx.sampleRate); log(`receiver reset: ${$('band').value} / ${$('speed').value}`, 'dim', { event: 'reset' }); }
$('thr').oninput = () => { $('thrV').textContent = (+$('thr').value).toFixed(2); if (rx) rx.threshold = +$('thr').value; };

const WORKLET = `class Tap extends AudioWorkletProcessor {
  constructor(){ super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs){ const ch = inputs[0] && inputs[0][0]; if (ch) { for (let i=0;i<ch.length;i++){ this.b[this.n++] = ch[i]; if (this.n === this.b.length){ this.port.postMessage(this.b); this.b = new Float32Array(2048); this.n = 0; } } } return true; }
} registerProcessor('amodem-tap', Tap);`;

async function startListening() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia unavailable (needs HTTPS or localhost)');
  await ensureCtx();
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  srcNode = ctx.createMediaStreamSource(stream);
  analyser = ctx.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0; analyser.minDecibels = -140; analyser.maxDecibels = 0;
  srcNode.connect(analyser);
  sinkNode = ctx.createGain(); sinkNode.gain.value = 0; sinkNode.connect(ctx.destination);
  makeReceiver(ctx.sampleRate);
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    tapNode = new AudioWorkletNode(ctx, 'amodem-tap');
    tapNode.port.onmessage = (ev) => { if (rx) rx.push(ev.data); };
  } catch (err) {
    tapNode = ctx.createScriptProcessor(4096, 1, 1);
    tapNode.onaudioprocess = (ev) => { if (rx) rx.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
    log('AudioWorklet unavailable, using ScriptProcessor fallback', 'warn');
  }
  srcNode.connect(tapNode); tapNode.connect(sinkNode);
  const track = stream.getAudioTracks()[0], st = track.getSettings ? track.getSettings() : {};
  log(`listening: ctx ${ctx.sampleRate} Hz, mic ${st.sampleRate || '?'} Hz, AEC=${st.echoCancellation} NS=${st.noiseSuppression} AGC=${st.autoGainControl}`, '',
      { event: 'start', fs: ctx.sampleRate, mic: st, band: $('band').value, speed: $('speed').value, ua: navigator.userAgent });
  if (st.echoCancellation || st.noiseSuppression || st.autoGainControl) log('warning: browser left some mic processing on', 'warn');
  rxRunning = true; $('btnListen').disabled = true; $('btnStopRx').disabled = false;
  peakNcc = 0; frame = 0; sizeCanvases(); draw();
}
function stopListening() {
  rxRunning = false; cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach(t => t.stop());
  [srcNode, tapNode, sinkNode, analyser].forEach(n => { try { n && n.disconnect(); } catch (e) {} });
  stream = srcNode = tapNode = sinkNode = analyser = null;
  $('btnListen').disabled = false; $('btnStopRx').disabled = true; $('mState').textContent = 'idle';
  log('stopped', 'dim');
}
$('btnListen').onclick = () => startListening().catch(e => log('mic error: ' + e.message, 'bad'));
$('btnStopRx').onclick = stopListening;

// ------------------------------------------------------------ live spectrum + waterfall
let fbuf = null, frame = 0;
function binMax(f0, f1, binHz, n) {
  const b0 = Math.floor(f0 / binHz), b1 = Math.max(b0 + 1, Math.floor(f1 / binHz));
  let m = -200; for (let b = b0; b < b1 && b < n; b++) m = Math.max(m, fbuf[b]); return m;
}
function draw() {
  if (!rxRunning || !analyser) return;
  raf = requestAnimationFrame(draw);
  const p = rx.p, n = analyser.frequencyBinCount, binHz = p.fs / analyser.fftSize;
  if (!fbuf || fbuf.length !== n) fbuf = new Float32Array(n);
  analyser.getFloatFrequencyData(fbuf);
  const [f0, f1] = viewRange(p), lo = +$('floor').value, hi = -20;
  // Fig. 2 spectrum
  const c = $('spec'), g = c.getContext('2d'), box = plotBox(c), d = box.d;
  const f2x = (f) => box.x0 + (f - f0) / (f1 - f0) * box.w, db2y = (v) => box.y0 + box.h - (v - lo) / (hi - lo) * box.h;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#eef3fb'; g.fillRect(f2x(p.chirpF0), box.y0, f2x(p.chirpF1) - f2x(p.chirpF0), box.h);
  g.strokeStyle = '#9db4d8'; g.lineWidth = 1;
  for (const f of p.tones) { const x = Math.round(f2x(f)) + .5; g.beginPath(); g.moveTo(x, box.y0); g.lineTo(x, box.y0 + box.h); g.stroke(); }
  g.strokeStyle = '#111'; g.lineWidth = 1.2 * d; g.beginPath();
  for (let x = 0; x < box.w; x++) {
    const m = binMax(f0 + (f1 - f0) * x / box.w, f0 + (f1 - f0) * (x + 1) / box.w, binHz, n);
    const y = Math.max(box.y0, Math.min(box.y0 + box.h, db2y(m)));
    x ? g.lineTo(box.x0 + x, y) : g.moveTo(box.x0 + x, y);
  }
  g.stroke(); g.lineWidth = 1;
  const yt = []; for (let v = Math.ceil(lo / 20) * 20; v <= hi; v += 20) yt.push([db2y(v), String(v)]);
  axes(g, c, box, 'freq', 'dB', freqTicks(box, f0, f1), yt);
  // Fig. 3 waterfall
  const w = $('wf'), wg = w.getContext('2d'), wb = plotBox(w);
  const W = Math.round(wb.w), H = Math.round(wb.h);
  wg.drawImage(w, wb.x0, wb.y0, W, H - 1, wb.x0, wb.y0 + 1, W, H - 1);
  const row = wg.createImageData(W, 1);
  for (let x = 0; x < W; x++) {
    const [r, gg, b] = cmap((binMax(f0 + (f1 - f0) * x / W, f0 + (f1 - f0) * (x + 1) / W, binHz, n) - lo) / (hi - lo));
    row.data[x * 4] = r; row.data[x * 4 + 1] = gg; row.data[x * 4 + 2] = b; row.data[x * 4 + 3] = 255;
  }
  wg.putImageData(row, wb.x0, wb.y0);
  if (frame++ % 30 === 0) {
    wg.fillStyle = '#fff'; wg.fillRect(0, 0, wb.x0 - 2, w.height); wg.fillRect(0, wb.y0 + H + 2, w.width, w.height);
    axes(wg, w, wb, '', 'time', freqTicks(wb, f0, f1), [], true);
  }
  // status table
  const vals = []; let pk = -200;
  for (let b = Math.floor(p.chirpF0 / binHz); b <= Math.ceil(p.chirpF1 / binHz) && b < n; b++) { vals.push(fbuf[b]); pk = Math.max(pk, fbuf[b]); }
  vals.sort((a, b) => a - b);
  $('mBand').textContent = `${(pk - vals[vals.length >> 1]).toFixed(1)} dB`;
  peakNcc = Math.max(peakNcc * 0.995, rx.lastNcc);
  const et = rx.effThr();
  $('mNcc').innerHTML = `${rx.lastNcc.toFixed(2)} / <span class="${peakNcc >= et ? 'ok' : ''}">${peakNcc.toFixed(2)}</span> / ${et.toFixed(2)}`;
  const pr = rx.progress();
  $('mState').textContent = pr ? (pr.phase === 'header' ? 'reading header' : `receiving (${pr.got}/${pr.need} symbols)`) : 'searching for chirp';
  $('rxBar').value = pr ? pr.got / pr.need * 100 : 0;
  if (pr && frame % 3 === 0) drawSymbols();
}

// ------------------------------------------------------------ RX image reconstruction
let asm = null, asmCur = null;
function onImageHeader(e) {
  const m = M.imageMeta(e.meta); asmCur = m;
  if (!asm || asm.key !== M.ImageAssembler.key(m)) {
    if (asm && !asm.archived) archiveImage(false);
    asm = new M.ImageAssembler(m.fmt, m.w, m.h, m.imgId);
  }
  renderImage();
}
function onImageBlock(e) { if (asm && asmCur && e.ok) { asm.addBlock(asmCur.pkt, e.off, e.data); renderImage(); } }
function onImagePacket() {
  if (!asm || !asmCur) return;
  asm.heard.add(asmCur.pkt); renderImage();
  if (asm.complete() && !asm.archived) archiveImage(true);
}
function archiveImage(complete) {
  asm.archived = true;
  const li = document.createElement('li');
  li.innerHTML = `<img src="${$('rxImg').toDataURL()}" alt="received image"> image #${asm.imgId}, ${asm.w}×${asm.h}, ${M.IMG.names[asm.fmt]}` +
    `<br><span class="meta${complete ? '' : ' bad'}">${new Date().toLocaleTimeString()} · ${complete ? 'complete' : 'incomplete'} · ${(asm.coverage() * 100).toFixed(0)}% of bytes received</span>`;
  $('msgs').prepend(li);
}
function renderImage() {
  if (!asm) return;
  const { fmt, w, h } = asm, gi = sized($('rxImg'), w, h);
  if (fmt !== M.IMG.FMT.JPEG) {
    const u = M.unpackImage(asm.buf, asm.known, w, h, fmt);
    const mid = fmt === M.IMG.FMT.COLOR4 ? 7 : (1 << M.IMG.bits[fmt]) >> 1;
    if (u.have.indexOf(1) < 0) { gi.fillStyle = '#ddd'; gi.fillRect(0, 0, w, h); }
    else gi.putImageData(idxToImageData(gi, M.fillMissing(u.pix, u.have, w, h, mid), w, h, fmt), 0, 0);
    const gc = sized($('rxCov'), w, h), im = gc.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const c = u.have[i] ? M.indexColor(fmt, u.pix[i]).map(v => 128 + v / 2) : [220, 40, 40];
      im.data[i * 4] = c[0]; im.data[i * 4 + 1] = c[1]; im.data[i * 4 + 2] = c[2]; im.data[i * 4 + 3] = 255;
    }
    gc.putImageData(im, 0, 0);
  } else {
    const pre = asm.jpegPrefix();
    if (pre && pre.bytes.length > 8) {
      const url = URL.createObjectURL(new Blob([pre.bytes], { type: 'image/jpeg' })), im = new Image();
      im.onload = () => { sized($('rxImg'), w, h).drawImage(im, 0, 0, w, h); URL.revokeObjectURL(url); };
      im.onerror = () => URL.revokeObjectURL(url);
      im.src = url;
    } else { gi.fillStyle = '#ddd'; gi.fillRect(0, 0, w, h); }
    const total = asm.total ?? (Math.max(0, ...asm.heard) + 1) * M.IMG.pktPayload, cols = 32, rows = Math.max(1, Math.ceil(total / cols));
    const gc = sized($('rxCov'), cols, rows), im = gc.createImageData(cols, rows);
    for (let i = 0; i < cols * rows; i++) {
      const c = i >= total ? [255, 255, 255] : asm.known[i] ? [90, 150, 100] : [220, 40, 40];
      im.data[i * 4] = c[0]; im.data[i * 4 + 1] = c[1]; im.data[i * 4 + 2] = c[2]; im.data[i * 4 + 3] = 255;
    }
    gc.putImageData(im, 0, 0);
  }
  const n = asm.nPackets, miss = asm.missing();
  let strip = 'packets: ';
  if (n == null) strip += [...asm.heard].sort((a, b) => a - b).map(i => `<span class="${asm.packetStatus(i)}">${i}</span>`).join('') + ' <span class="dim" style="border:0">(total unknown until packet 0 arrives)</span>';
  else {
    for (let i = 0; i < n; i++) strip += `<span class="${asm.packetStatus(i)}" title="packet ${i}: ${asm.packetStatus(i)}">${i}</span>`;
    strip += miss.length ? `<br>missing or damaged: <b>${miss.join(', ')}</b> (type these into "resend packets" on the transmitter)` : '<br><span class="ok" style="border:0;background:none">all packets received</span>';
  }
  $('pktStrip').innerHTML = strip;
  $('imgRxInfo').textContent = `image #${asm.imgId} · ${w}×${h} · ${M.IMG.names[fmt]} · ${(asm.coverage() * 100).toFixed(0)}% received` + (asmCur ? ` · last packet ${asmCur.pkt}` : '');
  $('btnSavePng').disabled = false;
}
$('btnSavePng').onclick = () => { if (asm) $('rxImg').toBlob(b => download(b, `amodem_image${asm.imgId}_${asm.w}x${asm.h}.png`)); };

// ------------------------------------------------------------ RX tools
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function summarize() {
  const by = {};
  for (const e of logEntries) {
    if (!e.band) continue;
    const k = `${e.band}/${e.speed}`, s = by[k] || (by[k] = { syncs: 0, headerFails: 0, packets: 0, packetsOk: 0, blocks: 0, blocksOk: 0, snrAvg: [], snrMin: [], realNcc: [], falseNcc: [] });
    if (e.event === 'sync') s.syncs++;
    if (e.event === 'header_fail') { s.headerFails++; s.falseNcc.push(e.ncc); }
    if (e.event === 'block') { s.blocks++; if (e.ok) s.blocksOk++; }
    if (e.event === 'packet') { s.packets++; if (e.ok) s.packetsOk++; s.snrAvg.push(e.snrAvg); s.snrMin.push(e.snrMin); s.realNcc.push(e.ncc); }
  }
  return by;
}
$('btnLog').onclick = () => {
  const p = rx ? rx.p : params();
  const out = { app: 'amodem-phase3', exported: new Date().toISOString(), ua: navigator.userAgent,
    params: { band: p.bandKey, speed: p.speedKey, fs: p.fs, tones: [p.tones[0], p.tones[15]], ts: p.ts, tg: p.tg, threshold: rx ? rx.threshold : null },
    summary: summarize(), events: logEntries };
  download(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }), `amodem_log_${Date.now()}.json`);
};
$('btnRec').onclick = () => {
  if (!rx || !rx.total) { log('nothing recorded yet', 'warn'); return; }
  const n = Math.min(rx.total, Math.round(20 * rx.p.fs)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rx.get(rx.total - n + i);
  let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v));
  log(`saved ${(n / rx.p.fs).toFixed(1)} s of raw mic audio (peak ${(20 * Math.log10(pk + 1e-9)).toFixed(1)} dBFS)`, 'dim');
  download(new Blob([M.encodeWav(out, rx.p.fs)], { type: 'audio/wav' }), `amodem_rx_${rx.p.fs}Hz_${Date.now()}.wav`);
};
$('wavIn').onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  await ensureCtx();
  try {
    const ab = await ctx.decodeAudioData(await f.arrayBuffer());
    const ch = ab.getChannelData(0);
    log(`decoding ${f.name} (${ab.duration.toFixed(1)} s @ ${ab.sampleRate} Hz)`, 'dim', { event: 'file', name: f.name });
    const R = new M.Receiver(params(ab.sampleRate), { threshold: +$('thr').value, onEvent });
    for (let i = 0; i < ch.length; i += 4096) R.push(ch.subarray(i, i + 4096));
    R.push(new Float32Array(Math.round(ab.sampleRate * 0.5)));
    log('file decode finished', 'dim');
  } catch (e) { log('file decode error: ' + e.message, 'bad'); }
  ev.target.value = '';
};
$('btnClear').onclick = () => {
  $('log').innerHTML = ''; logEntries = []; $('msgs').innerHTML = ''; recon = null; asm = null; asmCur = null;
  $('pktStrip').innerHTML = ''; $('imgRxInfo').textContent = 'no image packets yet'; $('btnSavePng').disabled = true;
  for (const id of ['rxImg', 'rxCov']) { const g = $(id).getContext('2d'); g.clearRect(0, 0, $(id).width, $(id).height); }
  $('hex').innerHTML = '<span class="dim">waiting for a packet...</span>'; $('textOut').innerHTML = '<span class="dim">-</span>'; drawSymbols();
};

showParams();
prepImage();
route();
})();
