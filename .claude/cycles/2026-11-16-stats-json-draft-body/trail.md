## Ziel

„stats -j soll echtes JSON ausgeben, bau das ein. Bitte den Fehler untersuchen. Das script nach Ruby portieren."

- Fehler: `~/dev/fruitmail-cli/fruitmail body <id>` (Bash-CLI) meldet „Message not found" für eine Entwurfs-ID.
- Script: `~/tools/dev-cache-sweep/dev-cache-sweep.sh`. Die Portierung liegt im eigenen Repo, nicht in diesem Cycle.

## Route

- The worktree branched from `origin/main` (b62b310). Local main was 7 commits ahead, so the branch was fast-forwarded to local main `0f5360d`.
- `stats`: the global `-j` reaches the command through `getCommandOptions`. On `opts.json` the command prints `{total, unread, deleted, attachments}`. Committed as c942990.
- The draft-body bug and the Ruby port run in parallel subagents.
- Draft-body bug, two causes. The bash `body`/`open` searched only the app-level `every mailbox` (the On My Mac mailboxes); the fix walks every account's mailboxes first. In the node DB fallback, node:sqlite threw on the 64-bit `messages.message_id`; the fix reads ids beyond MAX_SAFE_INTEGER as NULL. Committed as 42b3919 and 3bff2b2.
- The only non-deleted drafts (5, ids 1309xx) sit in an account that Mail reports as disabled. `body` answers "Message not found" for them. That answer is correct, not a bug.

## Proofs

- `npx jest tests/search.test.ts -t stats`: 3× JSON red before the change, 5/5 green after it.
- Bash `body 156961` (inbox): rc=1 "Message not found" before, rc=0 with 2210 bytes after.
- `npx jest tests/body-lookup.test.ts`: red "Value is too large" before, green after. Together with search.test.ts: 44/44.
- Node `body 130910` (draft): crashed with "Value is too large" before, answers "Message not found" after.
- Live: `node bin/fruitmail stats -j` → `{"total": 32833, "unread": 75, "deleted": 48, "attachments": 2684}`, rc=0.
