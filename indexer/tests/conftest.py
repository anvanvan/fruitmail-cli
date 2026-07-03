"""Shared fixtures for the fruitmail indexer test suite.

Builds synthetic Apple-Mail-style ``.emlx`` files/trees:
``<byte-count>\\n<MIME message bytes><binary plist footer>``.

IMPORTANT: no indexer modules (emlx/paths/schema/main) are imported here or at
module level in any test file — they do not exist until GREEN. Tests import
them lazily inside the test body so collection always succeeds and missing
modules surface as per-test FAILURES, not collection errors.
"""

from __future__ import annotations

import pathlib
import plistlib
import sys

import pytest

# Make `import emlx` / `import paths` / `import schema` / `import main` work the
# same way `uv run cocoindex update main.py` does (indexer/ as sys.path[0]),
# regardless of how pytest is invoked.
INDEXER_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(INDEXER_DIR) not in sys.path:
    sys.path.insert(0, str(INDEXER_DIR))

DEFAULT_PLIST_FOOTER = plistlib.dumps({"date-sent": 1700000000, "flags": 0})


def make_emlx_bytes(
    mime: bytes,
    *,
    byte_count: int | None = None,
    footer: bytes = DEFAULT_PLIST_FOOTER,
) -> bytes:
    """Assemble raw .emlx bytes: first line = MIME byte count, then MIME, then plist."""
    count = len(mime) if byte_count is None else byte_count
    return str(count).encode("ascii") + b"\n" + mime + footer


def make_mime(
    *,
    subject: str = "Hello",
    sender: str = "alice@example.com",
    body: str = "plain body text",
    date: str = "Mon, 6 Jan 2025 10:00:00 +0000",
    content_type: str = "text/plain; charset=utf-8",
) -> bytes:
    """A minimal single-part MIME message."""
    return (
        f"From: {sender}\r\n"
        f"To: bob@example.com\r\n"
        f"Subject: {subject}\r\n"
        f"Date: {date}\r\n"
        "MIME-Version: 1.0\r\n"
        f"Content-Type: {content_type}\r\n"
        "\r\n"
        f"{body}\r\n"
    ).encode("utf-8")


@pytest.fixture
def emlx_factory():
    return make_emlx_bytes


@pytest.fixture
def mime_factory():
    return make_mime


class MailTree:
    """A synthetic mail root that tests can populate and mutate."""

    def __init__(self, root: pathlib.Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def write_emlx(self, rel: str, mime: bytes, *, raw: bytes | None = None) -> pathlib.Path:
        target = self.root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw if raw is not None else make_emlx_bytes(mime))
        return target

    def remove(self, rel: str) -> None:
        (self.root / rel).unlink()


@pytest.fixture
def mail_tree(tmp_path) -> MailTree:
    return MailTree(tmp_path / "MailRoot")


@pytest.fixture
def indexer_env(tmp_path, mail_tree, monkeypatch):
    """Point the indexer at the synthetic tree + tmp databases via env vars."""
    fruitmail_home = tmp_path / "fruitmail-home"
    index_db = fruitmail_home / "index.db"
    state_db = fruitmail_home / "cocoindex-state.db"
    monkeypatch.setenv("FRUITMAIL_MAIL_ROOT", str(mail_tree.root))
    monkeypatch.setenv("FRUITMAIL_INDEX_DB", str(index_db))
    monkeypatch.setenv("FRUITMAIL_STATE_DB", str(state_db))
    monkeypatch.delenv("FRUITMAIL_PROCESS_LOG", raising=False)

    class Env:
        pass

    env = Env()
    env.mail_root = mail_tree.root
    env.home = fruitmail_home
    env.index_db = index_db
    env.state_db = state_db
    return env
