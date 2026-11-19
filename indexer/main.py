"""Fruitmail body-FTS indexer — a CocoIndex v1 app.

Run with ``uv run cocoindex update main.py`` from this directory. The file is
loaded as a bare top-level module (this directory becomes ``sys.path[0]``), so
sibling modules use absolute imports and there is no ``__init__.py`` (F1).

Builds the target ``index.db`` (emails table via the CocoIndex sqlite
connector + external-content FTS5 kept in sync by triggers) from the Apple
Mail ``.emlx`` tree. Skips are recorded, never fatal.
"""

from __future__ import annotations

import gc
import os
import pathlib
import re
import sqlite3
import sys
import types
import warnings
from typing import Iterator

import cocoindex as coco
from cocoindex.connectors import localfs, sqlite
from cocoindex.resources.file import FileLike, PatternFilePathMatcher

# Absolute imports: cocoindex loads this file as a bare top-level module with
# indexer/ on sys.path[0], making siblings importable as top-level modules.
from emlx import parse_emlx
from paths import (
    infer_account_mailbox,
    message_id_from_name,
    resolve_index_db,
    resolve_mail_root,
    resolve_state_db,
)
from schema import EmailRow, ensure_aux_schema, secure_perms, stamp_indexed_at

# F26: close the transient world/group-readable window between the OS
# creating index.db (subject to the process umask) and secure_perms()
# chmod'ing it to 0600 below — a kill in that gap would otherwise leave
# decoded mail data readable by other local users indefinitely.
os.umask(0o077)

APP_NAME = "FruitmailIndex"

# --- process-wide singletons -------------------------------------------------
# ContextKey strings are globally unique per process and app names are unique
# per environment, so a re-import of this module in one process (the test
# suite re-imports main per run) must reuse the key and retire the previous
# environment. The stash module survives `sys.modules.pop("main")`.
_SINGLETONS_MODULE = "_fruitmail_indexer_singletons"

_stash = sys.modules.get(_SINGLETONS_MODULE)
_REIMPORTED = _stash is not None
if _stash is None:
    _stash = types.ModuleType(_SINGLETONS_MODULE)
    _stash.sqlite_db_key = coco.ContextKey[sqlite.ManagedConnection](
        "fruitmail_index_db"
    )
    sys.modules[_SINGLETONS_MODULE] = _stash

SQLITE_DB: coco.ContextKey[sqlite.ManagedConnection] = _stash.sqlite_db_key

# F3 test-hook log: kept open for the whole run instead of opened/closed on
# every skip/process line (a build can touch it hundreds-to-thousands of
# times). `process_file` is `@coco.fn(memo=True)`, so its arguments become
# memoization keys — an open file handle can't be passed through it (not
# hashable), hence this module-level cache keyed by path instead.
_process_log_fh: object | None = None
_process_log_path: str | None = None


def _get_process_log_fh() -> object | None:
    global _process_log_fh, _process_log_path
    log_path = os.environ.get("FRUITMAIL_PROCESS_LOG")
    if not log_path:
        return None
    if _process_log_fh is None or _process_log_path != log_path:
        _process_log_fh = open(log_path, "a", encoding="utf-8")
        _process_log_path = log_path
    return _process_log_fh


def _close_process_log_fh() -> None:
    global _process_log_fh, _process_log_path
    if _process_log_fh is not None:
        _process_log_fh.close()
        _process_log_fh = None
        _process_log_path = None


_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _printable(path: pathlib.Path) -> str:
    """The path with C0/C1 control chars as \\xNN: a crafted file name
    cannot inject terminal escapes or forge extra lines."""
    return _CONTROL_CHARS.sub(lambda m: f"\\x{ord(m.group()):02x}", str(path))


def _record_skip(path: pathlib.Path, reason: str) -> None:
    """Recorded, never fatal: warn on stderr (+ optional test-hook log, F3)."""
    shown = _printable(path)
    print(f"fruitmail-indexer: skipping ({reason}): {shown}", file=sys.stderr)
    log_fh = _get_process_log_fh()
    if log_fh is not None:
        log_fh.write(f"SKIP {reason} {shown}\n")


def coco_lifespan(builder: coco.EnvironmentBuilder) -> Iterator[None]:
    index_db = resolve_index_db()
    state_db = resolve_state_db()
    for parent in {index_db.parent, state_db.parent}:
        parent.mkdir(parents=True, exist_ok=True)
        os.chmod(parent, 0o700)  # ~/.fruitmail is 0700
    # The state store is an LMDB directory; a previous run locked it down to
    # 0600 — restore owner rwx so the environment can reopen it.
    if state_db.is_dir():
        os.chmod(state_db, 0o700)
    builder.settings.db_path = state_db  # cocoindex state db (separate file)
    conn = sqlite.connect(index_db, load_vec=False)
    secure_perms(index_db)  # index.db 0600 (connect just created/opened it)
    builder.provide(SQLITE_DB, conn)
    try:
        yield
    finally:
        conn.close()


@coco.fn(memo=True)  # memo => unchanged .emlx files are skipped on catch-up
async def process_file(
    file: FileLike,
    target: sqlite.TableTarget[EmailRow],
    mail_root: pathlib.Path,
) -> None:
    # Compute the file's path the same way the root was resolved: app_main
    # resolved the root ONCE via Path.resolve() and the walker joins each
    # relative path onto it lexically. Fully re-resolving here would follow
    # symlink components inside the tree to a prefix that no longer matches
    # the root, skipping every file under a symlinked mail root.
    path = pathlib.Path(file.file_path.path)
    # F3 observability: this line only runs on NON-memoized (real) executions.
    log_fh = _get_process_log_fh()
    if log_fh is not None:
        log_fh.write(f"PROCESS {path}\n")
    # Containment is checked BEFORE the filename parses as a message id
    # (defense-in-depth, EDGE-4): a file outside the mail root / without a
    # .mbox ancestor must be skipped as no-mbox-or-outside-root regardless of
    # whether its name happens to parse — never reach the bad-name check.
    account, mailbox = infer_account_mailbox(path, mail_root)
    if account is None:  # outside root OR no .mbox ancestor (F7)
        _record_skip(path, "no-mbox-or-outside-root")
        return
    # Apple Mail stores messages (and .partial.emlx) only as
    # <mailbox>.mbox/.../Messages/<n>.emlx; any other .emlx is not mail.
    if path.parent.name != "Messages":
        _record_skip(path, "not-in-messages-dir")
        return
    try:
        message_id = message_id_from_name(path.name)  # F0 single owner
    except ValueError:
        _record_skip(path, "bad-name")
        return
    try:
        raw = await file.read()
    except OSError:
        # Apple Mail moves/deletes .emlx files constantly; a file that
        # vanishes mid-scan must be skipped, never abort the whole build.
        _record_skip(path, "read-error")
        return
    parsed = parse_emlx(raw)  # None => malformed/oversized => skip
    if parsed is None:
        _record_skip(path, "malformed")
        return
    target.declare_row(
        row=EmailRow(
            account=account,
            mailbox=mailbox,
            message_id=message_id,
            subject=parsed.subject,
            sender=parsed.sender,
            content=parsed.content,
            date_sent=parsed.date_sent,
            emlx_path=str(path),
        )
    )


@coco.fn
async def app_main() -> None:
    # Resolve the root ONCE; every file path is computed from this same
    # resolved form (walker join + lexical containment in paths.py), so a
    # symlinked FRUITMAIL_MAIL_ROOT — or a symlinked component within it —
    # cannot make containment checks skip the whole tree.
    mail_root = resolve_mail_root().resolve()
    index_db = resolve_index_db()
    target = await sqlite.mount_table_target(
        SQLITE_DB,
        table_name="emails",
        table_schema=await sqlite.TableSchema.from_class(
            EmailRow, primary_key=["account", "mailbox", "message_id"]
        ),
    )
    # Aux objects AFTER the emails table exists, BEFORE any row lands (the
    # triggers must see every insert). A single autocommit connection is kept
    # open for the whole run and reused below for the completion stamp:
    # executescript manages its own transaction boundaries and must not run
    # inside ManagedConnection.transaction().
    aux_conn = sqlite3.connect(index_db)
    ensure_aux_schema(aux_conn)
    files = localfs.walk_dir(
        mail_root,
        recursive=True,
        path_matcher=PatternFilePathMatcher(included_patterns=["**/*.emlx"]),
    )

    # Count discovered .emlx files so a build that skips EVERYTHING is
    # visible (WARN on stderr, still exit 0) instead of silently empty.
    discovered = 0

    async def counted_items():
        nonlocal discovered
        async for item in files.items():
            discovered += 1
            yield item

    try:
        handle = await coco.mount_each(process_file, counted_items(), target, mail_root)
        await handle.ready()  # all file components finished
        stamp_indexed_at(aux_conn)  # freshness stamp tied to completion
        indexed = aux_conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
    finally:
        _close_process_log_fh()
        aux_conn.close()
    if discovered > 0 and indexed == 0:
        print(
            f"fruitmail-indexer: WARNING: discovered {discovered} .emlx file(s) "
            f"under {mail_root} but indexed 0 emails — every file was skipped; "
            "check that FRUITMAIL_MAIL_ROOT points at an Apple Mail V<N> root",
            file=sys.stderr,
        )
    secure_perms(index_db)
    secure_perms(resolve_state_db())  # state store locked down too


def _env_signature() -> tuple[str, str, str]:
    """The resolved roots this app run would use (for re-import detection)."""
    try:
        mail_root = str(resolve_mail_root())
    except FileNotFoundError:
        mail_root = ""
    return (mail_root, str(resolve_index_db()), str(resolve_state_db()))


if _REIMPORTED and getattr(_stash, "env_signature", None) == _env_signature():
    # Re-imported with unchanged FRUITMAIL_* paths (the test suite re-imports
    # main per update run): keep the already-running environment and app so
    # memoization state carries over — exactly like consecutive
    # `cocoindex update` invocations against the same state db.
    app = _stash.app
else:
    if _REIMPORTED:
        # Paths changed since the previous import in this process: retire the
        # old environment so the new one re-reads FRUITMAIL_* in its lifespan.
        _stash.app = None  # drop the strong ref so gc can release the old app
        coco.stop_blocking()
    with warnings.catch_warnings():
        # Re-imports intentionally replace the previously registered lifespan.
        warnings.simplefilter("ignore")
        coco.lifespan(coco_lifespan)
    if _REIMPORTED:
        # The retired app is only weakly registered; collect it so the fresh
        # App(name=APP_NAME) below does not collide.
        gc.collect()
    app = coco.App(coco.AppConfig(name=APP_NAME), app_main)
    _stash.app = app
    _stash.env_signature = _env_signature()
