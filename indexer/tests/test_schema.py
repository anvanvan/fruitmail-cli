"""Unit tests for indexer/schema.py's secure_perms.

The module under test is imported lazily, matching the suite's convention.
"""

from __future__ import annotations

import stat


def _secure_perms():
    from schema import secure_perms

    return secure_perms


def test_secure_perms_locks_a_plain_file_to_0600(tmp_path):
    secure_perms = _secure_perms()
    target = tmp_path / "index.db"
    target.write_bytes(b"data")
    target.chmod(0o644)

    secure_perms(target)

    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_secure_perms_locks_a_directory_to_0700_not_0600(tmp_path):
    # The core regression: 0600 on a directory drops the executable/search
    # bit, making it non-traversable (not even the owner can list/recurse
    # into it) — this broke recursive cleanup of the LMDB state store.
    secure_perms = _secure_perms()
    target = tmp_path / "cocoindex-state.db"
    target.mkdir()
    target.chmod(0o755)

    secure_perms(target)

    assert stat.S_ISDIR(target.stat().st_mode)
    assert stat.S_IMODE(target.stat().st_mode) == 0o700


def test_secure_perms_recurses_into_nested_dirs_and_files(tmp_path):
    # Mirrors the real LMDB layout: a nested subdirectory containing the
    # actual data/lock files.
    secure_perms = _secure_perms()
    root = tmp_path / "cocoindex-state.db"
    nested_dir = root / "mdb"
    nested_dir.mkdir(parents=True)
    data_file = nested_dir / "data.mdb"
    lock_file = nested_dir / "lock.mdb"
    data_file.write_bytes(b"data")
    lock_file.write_bytes(b"lock")
    root.chmod(0o755)
    nested_dir.chmod(0o755)
    data_file.chmod(0o644)
    lock_file.chmod(0o644)

    secure_perms(root)

    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(nested_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(data_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(lock_file.stat().st_mode) == 0o600


def test_secure_perms_is_a_no_op_when_the_path_does_not_exist(tmp_path):
    secure_perms = _secure_perms()
    missing = tmp_path / "does-not-exist"

    secure_perms(missing)  # must not raise
