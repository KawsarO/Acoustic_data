/* Link parameters: bands, speed profiles, frame layout. */
(function (M) {
'use strict';

// ---------------------------------------------------------------- parameters
const NTONES = 16;               // 16-MFSK -> 4 bits / symbol
const BANDS = {
  ultra: { name: 'Near-ultrasonic 17.0–18.9 kHz', base: 17000, spacing: 125 },
  upper: { name: 'Upper-audible 15.0–16.9 kHz',  base: 15000, spacing: 125 },
  debug: { name: 'Audible debug 2.0–3.9 kHz',    base: 2000,  spacing: 125 },
};
const SPEEDS = {               // ts = integration window, tg = guard (echo absorber)
  robust:   { name: 'Robust (32+12 ms)',  ts: 0.032, tg: 0.012 },
  standard: { name: 'Standard (24+8 ms)', ts: 0.024, tg: 0.008 },
  fast:     { name: 'Fast (16+6 ms)',     ts: 0.016, tg: 0.006 },
  turbo:    { name: 'Turbo (12+4 ms)',    ts: 0.012, tg: 0.004 },
  max:      { name: 'Max (8+4 ms)',       ts: 0.008, tg: 0.004 },
};
const FRAME = {
  version: 1,
  chirpDur: 0.100,   // preamble sweep length (s)
  preGap: 0.020,     // silence after chirp so its echoes die before data
  lead: 0.050, tail: 0.080,
  hdrInfo: 10,       // 8 header bytes + CRC-16
  hdrPar: 8,         // RS parity on header (corrects 4 byte errors / 8 erasures)
  blkData: 32,       // payload bytes per data block
  blkPar: 12,        // RS parity per block (corrects 6 byte errors / 12 erasures)
  maxText: 255,      // Phase 1 cap (single preamble; keeps clock drift < guard)
};
const TYPE = { TEXT: 0, IMAGE: 1 };
const HDR_SYMS = (FRAME.hdrInfo + FRAME.hdrPar) * 2;

function makeParams(bandKey, speedKey, fs) {
  const b = BANDS[bandKey], s = SPEEDS[speedKey];
  const tones = [];
  for (let i = 0; i < NTONES; i++) tones.push(b.base + i * b.spacing);
  return {
    fs, bandKey, speedKey, tones, spacing: b.spacing,
    chirpF0: b.base - b.spacing, chirpF1: b.base + NTONES * b.spacing,
    chirpLen: Math.round(FRAME.chirpDur * fs),
    gapLen: Math.round(FRAME.preGap * fs),
    slot: (s.ts + s.tg) * fs,            // fractional samples per symbol slot
    guard: s.tg * fs,
    win: Math.round(s.ts * fs),
    ts: s.ts, tg: s.tg,
    baud: 1 / (s.ts + s.tg),
    rawBps: 4 / (s.ts + s.tg),
  };
}

Object.assign(M, { NTONES, BANDS, SPEEDS, FRAME, TYPE, HDR_SYMS, makeParams });
})(globalThis.Modem = globalThis.Modem || {});
