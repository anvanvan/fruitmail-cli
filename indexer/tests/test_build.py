"""RED integration tests for indexer/main.py + schema.py (behaviors 3, 4, 5, 19, 25).

Runs the CocoIndex v1 app (a) in-process via ``app.update_blocking()`` and
(b) as the real ``uv run cocoindex update main.py`` subprocess (F1), against a
synthetic .emlx tree. Asserts schema, perms, FTS population, refresh
convergence and the memo call-counter (F3, via FRUITMAIL_PROCESS_LOG).

All indexer imports are lazy (inside helpers called from test bodies).
"""

from __future__ import annotations

import os
import pathlib
import sqlite3
import stat
import subprocess
import sys

from conftest import MailTree, make_emlx_bytes, make_mime

INDEXER_DIR = pathlib.Path(__file__).resolve().parent.parent


def _run_update_in_process():
    """(Re)import main with the current env and run one blocking update."""
    for mod in ("main", "paths", "emlx", "schema"):
        sys.modules.pop(mod, None)
    import main

    main.app.update_blocking()
    return main


def _connect(db_path: pathlib.Path) -> sqlite3.Connection:
    return sqlite3.connect(db_path)


def _seed_tree(mail_tree) -> dict[str, pathlib.Path]:
    """3 indexable emails (+1 malformed, +1 without .mbox ancestor)."""
    files = {
        "alpha": mail_tree.write_emlx(
            "ACC-1/INBOX.mbox/Data/1/Messages/101.emlx",
            make_mime(subject="Quarterly report", body="the zanzibar body token"),
        ),
        "beta": mail_tree.write_emlx(
            "ACC-1/INBOX.mbox/Data/1/Messages/102.emlx",
            make_mime(subject="Lunch plans", body="tacos on friday"),
        ),
        "gamma": mail_tree.write_emlx(
            "ACC-2/Archive.mbox/Data/2/Messages/201.emlx",
            make_mime(subject="Old news", body="archived correspondence"),
        ),
        # malformed byte-count: skipped, never fatal (behavior 8)
        "malformed": mail_tree.write_emlx(
            "ACC-1/INBOX.mbox/Data/1/Messages/103.emlx",
            b"",
            raw=b"notanumber\nGarbage",
        ),
        # no .mbox ancestor: skipped + recorded, never fatal (behavior 11 / F7)
        "no_mbox": mail_tree.write_emlx(
            "ACC-1/LooseNotes/104.emlx",
            make_mime(subject="loose", body="floating file"),
        ),
    }
    return files


def test_build_creates_emails_table_with_composite_pk_and_one_row_per_indexable_emlx(
    indexer_env, mail_tree
):
    _seed_tree(mail_tree)

    _run_update_in_process()

    conn = _connect(indexer_env.index_db)
    try:
        info = conn.execute('PRAGMA table_info("emails")').fetchall()
        # rows: (cid, name, type, notnull, dflt_value, pk) — pk>0 in PK order
        pk_cols = [row[1] for row in sorted((r for r in info if r[5] > 0), key=lambda r: r[5])]
        assert pk_cols == ["account", "mailbox", "message_id"]
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 3  # malformed + no-mbox files are skipped, not fatal
        rows = conn.execute(
            "SELECT account, mailbox, message_id FROM emails ORDER BY message_id"
        ).fetchall()
        assert ("ACC-1", "INBOX", 101) in rows
        assert ("ACC-1", "INBOX", 102) in rows
        assert ("ACC-2", "Archive", 201) in rows
    finally:
        conn.close()


def test_vanished_file_read_error_is_skipped_not_fatal(indexer_env, mail_tree, monkeypatch, capsys):
    # F33: await file.read() is the only unguarded I/O in process_file; Apple
    # Mail moves/deletes .emlx files constantly, so a file that vanishes
    # mid-scan must be recorded and skipped, never abort the whole build.
    _seed_tree(mail_tree)

    import cocoindex.connectors.localfs as localfs

    original_read_impl = localfs.File._read_impl

    async def flaky_read_impl(self, size=-1):
        if str(self._file_path.path).endswith("102.emlx"):
            raise FileNotFoundError(f"vanished: {self._file_path.path}")
        return await original_read_impl(self, size)

    monkeypatch.setattr(localfs.File, "_read_impl", flaky_read_impl)

    _run_update_in_process()

    conn = _connect(indexer_env.index_db)
    try:
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 2  # alpha + gamma indexed; beta (102.emlx) skipped, not fatal
        ids = {row[0] for row in conn.execute("SELECT message_id FROM emails").fetchall()}
        assert 102 not in ids
    finally:
        conn.close()
    assert "read-error" in capsys.readouterr().err


def test_importing_main_sets_a_restrictive_umask_to_close_the_index_db_perms_window(
    indexer_env, mail_tree
):
    # F26: os.umask(0o077) at import time closes the transient
    # world/group-readable window between the OS creating index.db (subject
    # to the process umask) and secure_perms() chmod'ing it to 0600.
    previous = os.umask(0o022)  # simulate a permissive shell umask first
    try:
        _run_update_in_process()
        current = os.umask(0o077)  # read without changing: restore the same value
        assert current == 0o077
    finally:
        os.umask(previous)


def test_index_db_has_0600_perms_and_fruitmail_home_is_0700(indexer_env, mail_tree):
    _seed_tree(mail_tree)

    _run_update_in_process()

    assert stat.S_IMODE(indexer_env.index_db.stat().st_mode) == 0o600
    assert stat.S_IMODE(indexer_env.home.stat().st_mode) == 0o700
    # The state store is an LMDB DIRECTORY: it must get 0700 (traversable),
    # never 0600 — 0600 on a directory drops the executable/search bit,
    # making it opaque (not even the owner can list/stat/recurse into it),
    # which broke `fs.rmSync({recursive: true})` on it from the TS side.
    assert stat.S_ISDIR(indexer_env.state_db.stat().st_mode)
    assert stat.S_IMODE(indexer_env.state_db.stat().st_mode) == 0o700
    # Recursively: nested dirs stay 0700, nested files stay 0600 (LMDB's
    # layout nests its actual data/lock files under a subdirectory).
    found_nested_file = False
    for child in indexer_env.state_db.rglob("*"):
        if child.is_dir():
            assert stat.S_IMODE(child.stat().st_mode) == 0o700
        else:
            assert stat.S_IMODE(child.stat().st_mode) == 0o600
            found_nested_file = True
    assert found_nested_file  # sanity: the state store isn't empty


def test_fts_matches_a_term_present_only_in_the_body(indexer_env, mail_tree):
    _seed_tree(mail_tree)

    _run_update_in_process()

    conn = _connect(indexer_env.index_db)
    try:
        rows = conn.execute(
            "SELECT e.message_id FROM emails_fts JOIN emails e ON emails_fts.rowid = e.rowid "
            "WHERE emails_fts MATCH ?",
            ("zanzibar",),
        ).fetchall()
        assert rows == [(101,)]
        stamp = conn.execute(
            "SELECT value FROM fruitmail_meta WHERE key = 'indexed_at'"
        ).fetchone()
        assert stamp is not None and stamp[0]
    finally:
        conn.close()


def test_refresh_converges_add_modify_delete_and_skips_unchanged_files(
    indexer_env, mail_tree, monkeypatch, tmp_path
):
    files = _seed_tree(mail_tree)
    _run_update_in_process()

    # mutate: add one, modify one, delete one; alpha stays untouched
    mail_tree.write_emlx(
        "ACC-1/INBOX.mbox/Data/1/Messages/105.emlx",
        make_mime(subject="Brand new", body="freshly arrived xylophone"),
    )
    modified = mail_tree.write_emlx(
        "ACC-1/INBOX.mbox/Data/1/Messages/102.emlx",
        make_mime(subject="Lunch plans", body="pizza instead quetzal"),
    )
    mail_tree.remove("ACC-2/Archive.mbox/Data/2/Messages/201.emlx")

    process_log = tmp_path / "process.log"
    monkeypatch.setenv("FRUITMAIL_PROCESS_LOG", str(process_log))
    _run_update_in_process()

    conn = _connect(indexer_env.index_db)
    try:
        count = conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        assert count == 3  # 3 - deleted + added
        ids = {row[0] for row in conn.execute("SELECT message_id FROM emails").fetchall()}
        assert ids == {101, 102, 105}
        # modified row's new body is searchable, its old body is gone
        match = lambda term: [  # noqa: E731
            row[0]
            for row in conn.execute(
                "SELECT e.message_id FROM emails_fts JOIN emails e "
                "ON emails_fts.rowid = e.rowid WHERE emails_fts MATCH ?",
                (term,),
            ).fetchall()
        ]
        assert match("quetzal") == [102]
        assert match("tacos") == []
        assert match("xylophone") == [105]
        assert match("archived") == []  # deleted email cleared from FTS via emails_ad
    finally:
        conn.close()

    # F3: memoization — unchanged alpha must NOT be reprocessed on the catch-up run
    logged = process_log.read_text() if process_log.exists() else ""
    assert str(modified) in logged
    assert "105.emlx" in logged
    assert str(files["alpha"]) not in logged


def _point_indexer_at(monkeypatch, mail_root: pathlib.Path, home: pathlib.Path) -> None:
    monkeypatch.setenv("FRUITMAIL_MAIL_ROOT", str(mail_root))
    monkeypatch.setenv("FRUITMAIL_INDEX_DB", str(home / "index.db"))
    monkeypatch.setenv("FRUITMAIL_STATE_DB", str(home / "cocoindex-state.db"))
    monkeypatch.delenv("FRUITMAIL_PROCESS_LOG", raising=False)


def test_build_indexes_files_under_a_symlinked_mail_root(tmp_path, monkeypatch, capsys):
    # Regression (live-verified defect): FRUITMAIL_MAIL_ROOT pointing at a
    # symlink — with a symlinked account component inside the tree, too —
    # used to build an EMPTY index with exit 0 (every file skipped as
    # no-mbox-or-outside-root). Files reachable through the links must be
    # indexed; true escapes (a sibling tree outside the root) stay excluded.
    real_root = tmp_path / "RealMailRoot"
    tree = MailTree(real_root)
    tree.write_emlx(
        "ACC-1/INBOX.mbox/Data/1/Messages/101.emlx",
        make_mime(subject="Quarterly report", body="the zanzibar body token"),
    )
    # a symlinked COMPONENT inside the root (EDGE-1)
    detached = tmp_path / "DetachedAccount"
    MailTree(detached).write_emlx(
        "Archive.mbox/Data/2/Messages/201.emlx",
        make_mime(subject="Old news", body="archived correspondence"),
    )
    (real_root / "ACC-2").symlink_to(detached)
    # a true escape: sibling tree never reachable from the root
    MailTree(tmp_path / "Elsewhere").write_emlx(
        "ACC-X/Old.mbox/Data/9/Messages/901.emlx",
        make_mime(subject="stray", body="should never be indexed"),
    )

    link_root = tmp_path / "MailRootLink"
    link_root.symlink_to(real_root)
    home = tmp_path / "fruitmail-home"
    _point_indexer_at(monkeypatch, link_root, home)

    _run_update_in_process()

    conn = _connect(home / "index.db")
    try:
        rows = conn.execute(
            "SELECT account, mailbox, message_id FROM emails ORDER BY message_id"
        ).fetchall()
        assert rows == [("ACC-1", "INBOX", 101), ("ACC-2", "Archive", 201)]
    finally:
        conn.close()
    assert "WARNING" not in capsys.readouterr().err


def test_build_warns_on_stderr_when_emlx_discovered_but_none_indexed(
    tmp_path, monkeypatch, capsys
):
    # A build that discovers .emlx files but indexes none must WARN on
    # stderr (while still succeeding) instead of staying silently empty.
    root = tmp_path / "MailRoot"
    MailTree(root).write_emlx(
        "ACC-1/LooseNotes/104.emlx",  # no .mbox ancestor => skipped (F7)
        make_mime(subject="loose", body="floating file"),
    )
    home = tmp_path / "fruitmail-home"
    _point_indexer_at(monkeypatch, root, home)

    _run_update_in_process()  # completes without raising (exit-0 semantics)

    conn = _connect(home / "index.db")
    try:
        assert conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0] == 0
    finally:
        conn.close()
    err = capsys.readouterr().err
    assert "WARNING" in err
    assert "1 .emlx file(s)" in err
    assert "indexed 0 emails" in err


def test_containment_checked_before_filename_validity_edge4(tmp_path, monkeypatch, capsys):
    # EDGE-4 (verify round-2, user-endorsed): containment must be checked
    # BEFORE the filename is parsed as a message id. A file that fails BOTH
    # checks (non-numeric name, no .mbox ancestor) must be recorded as
    # no-mbox-or-outside-root, never bad-name — containment is verified
    # independent of filename validity (defense-in-depth).
    root = tmp_path / "MailRoot"
    tree = MailTree(root)
    tree.write_emlx(
        "ACC-1/LooseNotes/not-a-number.emlx",  # non-numeric name AND no .mbox ancestor
        make_mime(subject="loose non-numeric", body="floating file"),
    )
    tree.write_emlx(
        "ACC-1/INBOX.mbox/Data/1/Messages/not-a-number.emlx",  # non-numeric name, but IN containment
        make_mime(subject="in-mbox non-numeric", body="body"),
    )
    home = tmp_path / "fruitmail-home"
    _point_indexer_at(monkeypatch, root, home)

    _run_update_in_process()  # completes without raising (exit-0 semantics)

    conn = _connect(home / "index.db")
    try:
        assert conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0] == 0
    finally:
        conn.close()
    lines = capsys.readouterr().err.splitlines()
    outside_containment_line = next(
        line for line in lines if "not-a-number.emlx" in line and "LooseNotes" in line
    )
    in_containment_line = next(
        line for line in lines if "not-a-number.emlx" in line and "INBOX.mbox" in line
    )
    assert "no-mbox-or-outside-root" in outside_containment_line
    assert "bad-name" not in outside_containment_line
    assert "bad-name" in in_containment_line
    assert "no-mbox-or-outside-root" not in in_containment_line


def test_real_uv_run_cocoindex_update_subprocess_builds_the_index(indexer_env, mail_tree):
    # F1/behavior 25: the real loader must import main.py (absolute imports, no
    # package) and build the fixture index end to end.
    _seed_tree(mail_tree)

    result = subprocess.run(
        ["uv", "run", "cocoindex", "update", "main.py"],
        cwd=INDEXER_DIR,
        env={**os.environ},
        capture_output=True,
        text=True,
        timeout=600,
    )

    assert result.returncode == 0, f"stderr:\n{result.stderr}\nstdout:\n{result.stdout}"
    assert indexer_env.index_db.exists()
    conn = _connect(indexer_env.index_db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM emails").fetchone()[0] == 3
        rows = conn.execute(
            "SELECT e.message_id FROM emails_fts JOIN emails e ON emails_fts.rowid = e.rowid "
            "WHERE emails_fts MATCH 'zanzibar'"
        ).fetchall()
        assert rows == [(101,)]
    finally:
        conn.close()
