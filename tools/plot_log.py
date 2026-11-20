#!/usr/bin/env python3
"""Summarize (and optionally plot) receiver logs exported from the web app.

usage:
    python3 tools/plot_log.py amodem_log_*.json            # table per band/speed
    python3 tools/plot_log.py amodem_log_*.json --plot     # also saves snr.png (needs matplotlib)
"""
import json
import sys
from collections import defaultdict
from statistics import mean


def load(paths):
    events = []
    for p in paths:
        with open(p) as f:
            events += json.load(f)["events"]
    return events


def summarize(events):
    by = defaultdict(lambda: defaultdict(list))
    for e in events:
        mode = f'{e["band"]}/{e["speed"]}' if "band" in e else "(old log)"
        by[mode][e["event"]].append(e)

    print(f'{"mode":<16}{"packets ok":>11}{"blocks ok":>11}{"SNR avg":>9}{"SNR min":>9}{"sync":>7}{"false":>7}')
    for mode, ev in sorted(by.items()):
        pk, blk = ev["packet"], ev["block"]
        if not pk and not blk:
            continue
        ok_pk = sum(p["ok"] for p in pk)
        ok_blk = sum(b["ok"] for b in blk)
        snr = mean(p["snrAvg"] for p in pk) if pk else float("nan")
        snr_min = min((p["snrMin"] for p in pk), default=float("nan"))
        ncc = mean(p["ncc"] for p in pk) if pk else float("nan")
        print(f'{mode:<16}{ok_pk:>5}/{len(pk):<5}{ok_blk:>5}/{len(blk):<5}{snr:>9.1f}{snr_min:>9.1f}'
              f'{ncc:>7.2f}{len(ev["header_fail"]):>7}')
    return by


def plot(events, out="snr.png"):
    import matplotlib.pyplot as plt

    blocks = [e for e in events if e["event"] == "block"]
    if not blocks:
        print("no block events to plot")
        return
    x = range(len(blocks))
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.plot(x, [b["snrAvg"] for b in blocks], color="0.6", lw=1, label="block avg SNR")
    for i, b in enumerate(blocks):
        ax.scatter(i, b["snrMin"], s=14, color="tab:green" if b["ok"] else "tab:red", zorder=3)
    ax.axhline(13, ls="--", color="k", lw=0.8)
    ax.text(0, 13.5, "~13 dB: reliable", fontsize=8)
    ax.set_xlabel("block # (in log order)")
    ax.set_ylabel("symbol SNR (dB)")
    ax.set_title("per-block SNR (dots = min SNR, green ok / red CRC fail)")
    ax.legend(loc="lower right")
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    print("saved", out)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    ev = load(args)
    summarize(ev)
    if "--plot" in sys.argv:
        plot(ev)
