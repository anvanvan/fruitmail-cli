# Changelog

## Unreleased

### Features

- Added `--offset` / `-o` to paginate search results based on PR #1. Thanks to @JakubPecenka.
- Added body full-text search: `search --body <query>` runs a bm25-ranked FTS5 query (with snippets, `--account`/`--mailbox` filters, and `--days` parity with metadata search) over a local `~/.fruitmail/index.db` built by a new CocoIndex-based Python indexer.
- Added the `index build`/`index refresh`/`index status` command group to manage the body search index; body searches auto-build a missing index and auto-refresh a stale one.
- `stats --json` / `-j` now prints the counts as a JSON object (`total`, `unread`, `deleted`, `attachments`) instead of ignoring the flag.
- Added `test:py` and `test:all` npm scripts plus a push/PR CI workflow so the Node and Python suites run together; releases are gated on `test:all` too.

### Fixes

- Fixed the body indexer indexing any `.emlx` file below the mail folder; it now indexes only messages in a mailbox's `Messages` folder, and its skip warnings show control characters in file names as `\xNN` so a crafted name cannot inject terminal escape sequences.
- Fixed the body indexer dropping the text of a mail part labelled with an unknown charset; the part is now decoded as UTF-8.
- Fixed the shell `fruitmail body`/`open` reporting "Message not found" for every message in an account mailbox; they searched only the local mailboxes.
- Fixed `body`/`open` crashing with "Value is too large to be represented as a JavaScript number" when the message id lookup had to fall back to the database.
- Fixed pnpm global installs by removing the native SQLite runtime binding (#2). Thanks to @Mytakeon for reporting this.
- Fixed the standalone Bash CLI so `fruitmail search --subject ...` and other search flags are accepted (#3). Thanks to @Mytakeon for reporting this.

### Changes

- npm installs now require Node.js 22.13 or newer.
- Renamed the published npm and Homebrew package to `fruitmail`.
- Documented the local release wrapper and normalized release workflow naming.

## 1.1.2 - 2026-05-14

### Fixes

- Fixed `fruitmail -V` to report the package version instead of a stale hardcoded version.
- Fixed npm, git, and Homebrew installs to run the same built CLI entrypoint.

## 1.1.1 - 2026-03-30

Initial release.

### Features

- Added SQLite-backed Apple Mail search with full body content support.
- Added a unified Node and Bash CLI for Fruitmail.
- Added an install script that copies the executable and updates shell startup files.
- Added release automation scripts.

### Changes

- Updated README installation guidance, ClawHub links, and repository links after the rename.
- Improved table output and Mail lookup behavior.

### Fixes

- Fixed ClawHub links and wording in the README.
