---
status: closed
landing: bf390ea
---
# Trail: bot-findings

## Ziel

„Bot-Funde aus der Landung von 2026-11-17-setup beheben: securitybot Messages-Pfad + Steuerzeichen, bugbot F1 F2 N1"

## Route

Each finding got one table-driven test at the level a user acts on. The test ran red before the fix and green after it.

- **securitybot, Messages path.** `process_file` in `indexer/main.py` skips an `.emlx` whose parent folder is not `Messages`, with the reason `not-in-messages-dir`. The check runs after containment and before the name parse. Test: `test_only_emlx_inside_a_messages_dir_is_indexed` runs one in-process build over 7 paths.
- **securitybot, control chars.** `_record_skip` prints the path through `_printable`, which shows C0, DEL and C1 as `\xNN`. The test-hook log line uses the same form. Test: `test_skip_line_escapes_control_chars_in_the_path`, 7 file names.
- **bugbot F2.** `_part_text` in `indexer/emlx.py` decodes a part as UTF-8 with `errors="replace"` when its charset label raises `LookupError`. Test: `test_unknown_charset_body_is_decoded_not_dropped`, 5 rows through `parse_emlx`.
- **bugbot F1.** `sanitizeCell` in `src/index.ts` maps tab, CR and LF to a space, then drops the other control chars. Test: `tests/table-cells.test.ts` runs `fruitmail subject` against its own DB, 5 rows.
- **bugbot N1.** `buildMessageLookupContext` guards id columns with `NOT BETWEEN -MAX_SAFE_INTEGER AND MAX_SAFE_INTEGER`. Test: `tests/body-lookup.test.ts` became a table of ROWID → body, with `message_id` = INT64 min, INT64 max, a 64-bit hash and 42.

The fixes landed in two commits: `fix(indexer)` for the three Python findings, then `fix(cli)` for F1, N1 and the rebuilt `dist/index.js`. Each commit carries its `CHANGELOG.md` lines under `## Unreleased` → `### Fixes`.

## Proofs

| Finding | Red before the fix | Green after the fix |
|---|---|---|
| Messages path | `assert 103 not in {101, 102, 103, 104, 105, 106}` | 1 passed |
| Control chars | 6 of 7 rows failed, e.g. `skipping (no-mbox-or-outside-root): …/LooseNotes/del\x7f.emlx` printed raw | 7 passed |
| F2 charset | `assert 'ascii body survives' in ''`, 4 of 5 rows failed | 5 passed |
| F1 cells | `fruitmail subject Inv` printed `InvoiceMarchPayment`, 3 of 5 rows failed | 5 passed |
| N1 min id | `body 201` failed with `integer overflow`, 1 of 4 rows failed | 4 passed |

Final suite at `6687998`: jest 142 passed in 12 suites (`npm test -- --maxWorkers=4`), pytest 63 passed (`npm run test:py`).
