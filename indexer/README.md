# fruitmail indexer

A [CocoIndex v1](https://cocoindex.io/docs/) Python app that builds
`~/.fruitmail/index.db` — an `emails` table (composite primary key
`account, mailbox, message_id`) plus an external-content FTS5 index
(`emails_fts`, porter/unicode61) kept in sync by triggers — from the Apple
Mail `.emlx` tree. The fruitmail CLI's `search --body` and `index` verbs
drive it via `uv run`; it also works standalone.

## Run

```sh
cd indexer
uv run cocoindex update main.py
```

Incremental by design: unchanged `.emlx` files are memoized and skipped;
added/modified/deleted files converge the index on the next run. Malformed,
oversized (>25 MB) and out-of-place files are skipped and recorded on stderr,
never fatal.

## Configuration (environment variables)

| Variable | Default |
|---|---|
| `FRUITMAIL_MAIL_ROOT` | highest `~/Library/Mail/V<N>` (numeric N — V10 beats V9) |
| `FRUITMAIL_INDEX_DB` | `~/.fruitmail/index.db` (created 0600; `~/.fruitmail` 0700) |
| `FRUITMAIL_STATE_DB` | `~/.fruitmail/cocoindex-state.db` (CocoIndex state, separate) |

When invoked by the fruitmail CLI, `FRUITMAIL_MAIL_ROOT` is always passed in —
the TypeScript side is the authority for the mail root; the scan above is only
the standalone fallback.

## Privacy & network

Only the first build on a fresh machine needs the network: `uv` installs the
locked dependencies (`uv.lock` is committed for reproducible installs). Your
mail data never leaves the machine — the pipeline and all query paths are
entirely network-free.

## Live mode

The pipeline runs in catch-up mode today. CocoIndex supports live file
watching (`cocoindex update main.py -L` with a `live=True` source); switching
to it is a future toggle, not part of the current CLI integration.
