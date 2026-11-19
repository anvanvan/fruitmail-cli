## Ziel

„Bot-Hinweise aus der Landung von 2026-11-18-bot-findings nachziehen: bugbot NOTE 1 idna-Charset, NOTE 2 VT/FF/NEL in Tabellenzellen."

## Route

- Base: main ed9f9bb. Both notes predate the cycle; the earlier F1/F2 fixes covered only part of each class.
- `_part_text`: the fallback catches `UnicodeError` as well as `LookupError`, because the `idna` codec raises it under `errors="replace"`.
- `sanitizeCell`: VT, FF and NEL (U+0085) join tab, CR and LF as word separators that become a space.
- Each fix is pinned by one new row in its existing table test.

## Proofs

- `pytest tests/test_emlx.py -k unknown_charset`: the `charset=idna` row was red (1 failed, 5 passed) before the fix. After it, all 20 tests in the file pass.
- `npx jest tests/table-cells.test.ts`: the VT, FF and NEL rows were red (3 failed, 5 passed) before the fix. After it, 8/8 pass.
