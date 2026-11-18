"use strict";
/**
 * Shared `~/Library/Mail/V<N>` version-directory parsing/ordering (F8),
 * used by both `index-paths.ts` and `db-finder.ts` so the "highest N wins"
 * rule (V10 beats V9) lives in one place.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMailVersion = parseMailVersion;
exports.sortMailVersionNames = sortMailVersionNames;
/** Parses a `V<N>` directory name; returns the numeric N, or undefined if it doesn't match. */
function parseMailVersion(name) {
    const match = /^V(\d+)$/.exec(name);
    return match ? Number.parseInt(match[1], 10) : undefined;
}
/** Sorts `V<N>` directory names by numeric N, highest first (V10 beats V9, F8). */
function sortMailVersionNames(names) {
    return names
        .map((name) => ({ name, n: parseMailVersion(name) }))
        .filter((entry) => entry.n !== undefined)
        .sort((a, b) => b.n - a.n)
        .map((entry) => entry.name);
}
