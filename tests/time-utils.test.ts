/**
 * Regression tests for src/time-utils.ts — epochSecondsAgoFromNow.
 * F22: parseInt silently truncated "7xyz" -> 7 and "3.9" -> 3, contradicting
 * the "expected a non-negative integer" error message; validation must now
 * reject anything that isn't purely digits.
 */
import { epochSecondsAgoFromNow } from '../src/time-utils';

describe('epochSecondsAgoFromNow', () => {
    it('accepts a clean non-negative integer (string or number)', () => {
        const nowSeconds = Math.floor(Date.now() / 1000);
        expect(epochSecondsAgoFromNow('7')).toBeLessThanOrEqual(nowSeconds - 6 * 86400);
        expect(epochSecondsAgoFromNow(0)).toBeLessThanOrEqual(nowSeconds);
        expect(epochSecondsAgoFromNow(0)).toBeGreaterThan(nowSeconds - 5);
    });

    it.each([
        ['a trailing non-digit suffix', '7xyz'],
        ['a decimal point', '3.9'],
        ['a negative number', '-5'],
        ['whitespace-padded digits', ' 7 '],
        ['a non-numeric string', 'abc'],
        ['an empty string', '']
    ])('rejects %s instead of silently truncating it (F22)', (_name, value) => {
        expect(() => epochSecondsAgoFromNow(value)).toThrow(/expected a non-negative integer/);
    });
});
