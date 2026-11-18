"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.epochSecondsAgoFromNow = epochSecondsAgoFromNow;
/** Epoch-seconds cutoff `days` ago from now, shared by every `--days` filter. */
function epochSecondsAgoFromNow(days) {
    const raw = String(days);
    // parseInt silently truncates "7xyz" -> 7 and "3.9" -> 3, contradicting
    // this error message's "non-negative integer" claim (F22); require the
    // whole value to be digits only.
    if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid --days value: expected a non-negative integer, got "${days}"`);
    }
    const daysNum = Number.parseInt(raw, 10);
    return Math.floor(Date.now() / 1000) - (daysNum * 86400);
}
