# acoustic-modem

Sends text and small images from one device's speaker to another device's microphone.
It runs in the browser (Web Audio API + canvas) with no libraries and no build step.

## Running it

The microphone only works on HTTPS or `localhost`, so open the page through a server:

```
python3 -m http.server 8000      # then open http://localhost:8000
```

To test with a phone, host the folder somewhere with HTTPS (GitHub Pages works).
Open the page on both devices with the same band and speed. Use one as the transmitter and the other as the receiver (`#rx`).

## Layout

```
index.html          page markup
css/style.css
js/params.js        bands, speed profiles, frame constants
js/fec.js           GF(256) Reed-Solomon (errors + erasures), CRC-16
js/dsp.js           radix-2 FFT
js/modulator.js     chirp preamble, framing, continuous-phase 16-MFSK synth
js/receiver.js      chirp search (FFT matched filter), Goertzel demod, FEC decode
js/image.js         dithering/quantizing, interlaced packing, packetizer, assembler
js/sim.js           simulated room channel (echoes, noise, clock drift), WAV writer
js/app.js           UI: TX/RX pages, spectrum, waterfall, reconstruction plots
tests/              node tests (run the same modules outside the browser)
tools/plot_log.py   summarize/plot the JSON logs exported by the receiver
```

All the `js/` files attach to one global object (`Modem`). They're plain scripts so they load the same way in the browser and in Node (`tests/load.js`).

## Protocol

| | |
|---|---|
| modulation | 16-MFSK, 4 bits/symbol, continuous phase, 125 Hz tone spacing |
| bands | 17.0–18.9 kHz (near-ultrasonic), 15.0–16.9 kHz, 2.0–3.9 kHz (audible debug) |
| speeds | Standard 24+8 ms, **Fast 16+6 ms** (default, 182 bit/s raw), Max 8+4 ms, plus others |
| sync | 100 ms linear chirp, FFT cross-correlation, band-limited normalized score, adaptive threshold |
| header | type, length, block size, 4 meta bytes, CRC-16, RS(18,10) |
| data | 32-byte blocks, CRC-16 + RS(46,34): fixes 6 byte errors, or 12 with erasures from tone confidence |
| images | 1/2/4-bit gray or 16-color palette (Floyd-Steinberg), or JPEG; rows interlaced; 96-byte packets, each with its own chirp; header meta = format, image id, width, height, packet # |

## Testing

```
npm test               # FEC unit tests, simulated-room link tests, image end-to-end
npm run test:speeds    # all speed profiles across SNR levels + colored-noise false-sync check
python3 tools/plot_log.py amodem_log_*.json --plot
```

Laptop → iPhone results (ultrasonic band, same room):

| speed | packets ok | blocks ok | avg symbol SNR |
|---|---|---|---|
| Fast | 5/5 | 27/29 | 30.9 dB |
| Standard | 2/5 | 17/25 | 24.2 dB |
| Max | 2/3 | 13/18 | 13.4 dB |

At Standard, the long single-preamble frames lost their last blocks. That's why images now use short packets, each with its own chirp.

## Known limits

- No return channel. The receiver lists missing image packets and you resend them by number from the transmitter.
- Text is capped at 255 bytes per message.
- At 64 px, JPEG is bigger than the raw 1-bit format (about 600 bytes of fixed tables), and one lost byte breaks everything after it.
