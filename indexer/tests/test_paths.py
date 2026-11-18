"""RED tests for indexer/paths.py — root resolution and key derivation
(behaviors 9, 10, 11, 20 + F0 message_id ownership).

Modules under test are imported lazily inside each test body.
"""

from __future__ import annotations

import pytest


def _paths():
    import paths

    return paths


class TestMessageIdFromName:
    def test_simple_numeric_name(self):
        assert _paths().message_id_from_name("12345.emlx") == 12345

    def test_partial_emlx_name(self):
        assert _paths().message_id_from_name("12345.partial.emlx") == 12345

    def test_non_numeric_leading_segment_raises_value_error(self):
        with pytest.raises(ValueError):
            _paths().message_id_from_name("draft.emlx")


class TestInferAccountMailbox:
    def test_simple_account_and_mailbox(self, tmp_path):
        root = tmp_path / "MailRoot"
        path = root / "ACC-UUID-1" / "INBOX.mbox" / "Data" / "1" / "Messages" / "9.emlx"

        account, mailbox = _paths().infer_account_mailbox(path, root)

        assert account == "ACC-UUID-1"
        assert mailbox == "INBOX"

    def test_nested_mailbox_joins_parts_and_strips_mbox_suffix(self, tmp_path):
        root = tmp_path / "MailRoot"
        path = root / "ACC-UUID-1" / "Work" / "Projects" / "Q1.mbox" / "Data" / "7.emlx"

        account, mailbox = _paths().infer_account_mailbox(path, root)

        assert account == "ACC-UUID-1"
        assert mailbox == "Work/Projects/Q1"

    def test_path_outside_root_is_rejected(self, tmp_path):
        root = tmp_path / "MailRoot"
        outside = tmp_path / "Elsewhere" / "ACC" / "A.mbox" / "1.emlx"

        assert _paths().infer_account_mailbox(outside, root) == (None, "")

    def test_dotdot_traversal_is_contained_not_misattributed(self, tmp_path):
        # containment must use resolved is_relative_to, not str.startswith
        root = tmp_path / "MailRoot"
        root.mkdir(parents=True, exist_ok=True)
        hostile = root / "ACC" / ".." / ".." / "MailRoot-evil" / "ACC" / "A.mbox" / "1.emlx"

        assert _paths().infer_account_mailbox(hostile, root) == (None, "")

    def test_no_mbox_ancestor_is_skipped(self, tmp_path):
        # F7: inside the root but with no *.mbox component => (None, "")
        root = tmp_path / "MailRoot"
        path = root / "ACC-UUID-1" / "Notes" / "5.emlx"

        assert _paths().infer_account_mailbox(path, root) == (None, "")


class TestSymlinkContainment:
    """Regression: symlinked mail roots/components must stay attributed
    (live-verified defect — full per-file resolve() escaped the root)."""

    def test_symlinked_component_inside_root_is_contained(self, tmp_path):
        # root/ACC-2 is a real on-disk symlink to a detached directory: the
        # file must be attributed via the link name, not skipped as outside.
        root = tmp_path / "MailRoot"
        root.mkdir()
        detached = tmp_path / "Detached" / "account-data"
        (detached / "Archive.mbox" / "Data").mkdir(parents=True)
        (root / "ACC-2").symlink_to(detached)
        path = root / "ACC-2" / "Archive.mbox" / "Data" / "7.emlx"

        assert _paths().infer_account_mailbox(path, root) == ("ACC-2", "Archive")

    def test_file_spelled_via_symlinked_root_is_contained(self, tmp_path):
        real = tmp_path / "RealRoot"
        (real / "ACC" / "INBOX.mbox" / "Data").mkdir(parents=True)
        link = tmp_path / "LinkRoot"
        link.symlink_to(real)
        path = link / "ACC" / "INBOX.mbox" / "Data" / "1.emlx"

        assert _paths().infer_account_mailbox(path, link) == ("ACC", "INBOX")

    def test_file_under_real_location_of_symlinked_root_is_contained(self, tmp_path):
        # Fallback branch: spellings differ but both resolve to the same tree.
        real = tmp_path / "RealRoot"
        (real / "ACC" / "INBOX.mbox" / "Data").mkdir(parents=True)
        link = tmp_path / "LinkRoot"
        link.symlink_to(real)
        path = real / "ACC" / "INBOX.mbox" / "Data" / "1.emlx"

        assert _paths().infer_account_mailbox(path, link) == ("ACC", "INBOX")

    def test_true_escape_outside_symlinked_root_stays_excluded(self, tmp_path):
        real = tmp_path / "RealRoot"
        real.mkdir()
        link = tmp_path / "LinkRoot"
        link.symlink_to(real)
        outside = tmp_path / "Elsewhere" / "ACC" / "A.mbox" / "1.emlx"

        assert _paths().infer_account_mailbox(outside, link) == (None, "")

    def test_dotdot_traversal_through_symlinked_root_stays_excluded(self, tmp_path):
        real = tmp_path / "RealRoot"
        real.mkdir()
        link = tmp_path / "LinkRoot"
        link.symlink_to(real)
        hostile = link / "ACC" / ".." / ".." / "Evil" / "ACC" / "A.mbox" / "1.emlx"

        assert _paths().infer_account_mailbox(hostile, link) == (None, "")


class TestRootResolution:
    def test_resolve_mail_root_picks_highest_numeric_vn(self, tmp_path, monkeypatch):
        # F8: numeric comparison — V10 beats V9 (lexicographic would pick V9)
        home = tmp_path / "home"
        for name in ("V2", "V9", "V10"):
            (home / "Library" / "Mail" / name).mkdir(parents=True)
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.delenv("FRUITMAIL_MAIL_ROOT", raising=False)

        assert _paths().resolve_mail_root() == home / "Library" / "Mail" / "V10"

    def test_resolve_mail_root_env_override_wins(self, tmp_path, monkeypatch):
        override = tmp_path / "CustomRoot"
        override.mkdir()
        monkeypatch.setenv("FRUITMAIL_MAIL_ROOT", str(override))

        assert _paths().resolve_mail_root() == override

    def test_resolve_index_db_default_and_override(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.delenv("FRUITMAIL_INDEX_DB", raising=False)
        assert _paths().resolve_index_db() == home / ".fruitmail" / "index.db"

        monkeypatch.setenv("FRUITMAIL_INDEX_DB", str(tmp_path / "elsewhere.db"))
        assert _paths().resolve_index_db() == tmp_path / "elsewhere.db"

    def test_resolve_state_db_default_and_override(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.delenv("FRUITMAIL_STATE_DB", raising=False)
        assert _paths().resolve_state_db() == home / ".fruitmail" / "cocoindex-state.db"

        monkeypatch.setenv("FRUITMAIL_STATE_DB", str(tmp_path / "state-elsewhere.db"))
        assert _paths().resolve_state_db() == tmp_path / "state-elsewhere.db"
