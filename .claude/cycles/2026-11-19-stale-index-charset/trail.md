---
status: open
---
# Trail: stale-index-charset

## Ziel

„N2: alter Index + Warnung, wenn das Refresh scheitert; Charset-Fallback allgemein schließen (punycode, NUL)"

## Route

1. Fix A, `ensureIndexFresh` in `src/indexer-runner.ts`: a stale index whose refresh throws stays in use, and one stderr warning names the reason. A missing index whose build fails still errors, because there is no index to fall back on. Pinned at CLI level in `tests/index-cli.test.ts` with the `uv` stub (`FRUITMAIL_TEST_UV_EXIT=1`).
2. Fix B, `_decode_body` in `indexer/emlx.py`: UTF-8 takes over when the label is unknown (LookupError), malformed (ValueError, which covers UnicodeError and the NUL label), or names a hostname codec (`idna`, `punycode`).
3. Pivot on B. The brief assumed that punycode decodes a non-ASCII body to `''`. A probe on Python 3.12.14 showed that a non-ASCII body raises UnicodeDecodeError, already caught, so that row was green on base. The real loss is an ASCII body, which punycode turns into garbage without raising (`secret body words` → `હરિ`). An empty-text guard cannot catch garbage, so B excludes the hostname codecs by name.
4. Dropped the empty-text guard from the brief. A sweep of every stdlib codec, minus `idna` and `punycode`, found no body with words that decodes to blank text. The only blank result is iso2022_kr on a lone shift-out byte, so the guard would be untested dead code.
5. Trimmed from `UNKNOWN_CHARSET_ROWS`: the `x-unknown-8bit` ASCII row, which the `x-unknown-8bit` UTF-8 row already covers, and the non-ASCII punycode row, which was green on base.
6. The qlty mypy `arg-type` hint on the new `_decode_body` call led to a separate commit that narrows the payload check from `is None` to `isinstance(payload, bytes)`.

## Proofs

- A red (base 5f04ae5 + new test): `npx jest tests/index-cli.test.ts -t "falls back to a stale"` → `expect(result.failed).toBe(false)` fails, received `true`.
- A green: same command after the fix passes; `tests/index-cli.test.ts` + `tests/indexer-runner.test.ts` 28/28.
- B red (base `_part_text` + new rows): `uv run pytest -q tests/test_emlx.py -k unknown_charset` → 2 failed: `charset=punycode` with `secret body words`, and `charset="utf-8\x00"` with `nul label body kept` (content `''`).
- B green: `uv run pytest -q tests/test_emlx.py` → 21 passed.
- Suites at the fix commits: `npm test -- --maxWorkers=4` → 146 passed, 12 suites; `npm run test:py` → 65 passed.
- bugbot finding on 219135e: a schemaless `index.db` plus a failing refresh printed `no such table: emails_fts` instead of the refresh reason. The fallback now needs a stamped index (`indexedAt` set). Test `search --body reports the refresh failure when the stale index was never completed` was red before (`{"error":"no such table: emails_fts"}`) and is green after; `index-cli` + `indexer-runner` pass 29/29.
