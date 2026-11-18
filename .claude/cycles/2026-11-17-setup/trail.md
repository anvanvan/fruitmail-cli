---
status: closed
landing: 1ec4610
---
## Ziel

„/setup-cycle für fruitmail-cli" — so wählte es der Nutzer am 2026-11-17, nachdem pr-gate den Push des Cycles 2026-11-16-stats-json-draft-body abgelehnt hatte: `gate project not found: fruitmail-cli`.

## Route

- Detection: no `cycle.toml`, no verify skill, no CLAUDE.md (only the upstream `AGENTS.md`), no project memory, no `.claude/{hooks,agents,workflows}`, no git hooks.
- `cycle.toml` comes from `verify/soll.toml`. The tool has no `⚠` probe lines. The user answered `gate.main_test=full`, `gate.revert=auto`, no deploy table, the house subject form, and `trailers=["Co-Authored-By"]`.
- The worktree branched from `origin/main` b62b310 and was fast-forwarded to local main cf066e7, which carries the unpushed 2026-11-16 cycle.
- qlty: `derive --apply` with the plan the user approved (minus gitleaks, trufflehog and yamllint, plus osv-scanner).

## Proofs

- `setup-cycle.rb --apply`: `angelegt .claude/cycle.toml`. Read back: gate.test=full, gate.main_test=full, gate.revert=auto, commit.trailers=Co-Authored-By, scripts.language=bash, deploy.dir=__UNSET__.
- Secret scan against a bare fixture remote: the clean push returned rc=0. The leak push returned rc=1 with `secret-scan: BLOCKED — 1 finding(s)` (`generic-api-key,low,leak.py,1,a751e83`). Afterwards `ls-remote` listed only `refs/heads/clean-fixture`. Stamped as `proof git: stamped (sha256-980ba6fe26f69ef7, betterleaks 1.9.0)`.
- `qlty-baseline.rb check`: config ok, stamp current, 0 findings.
- `npm run test:all`: 9 s, 134 jest tests and 50 pytest tests green.
