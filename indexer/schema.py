"""Row shape, auxiliary SQLite DDL, freshness stamp and file perms.

The ``emails`` base table is created by the CocoIndex sqlite connector from
``EmailRow`` — never hand-created here. The FTS5 virtual table, its sync
triggers and the ``fruitmail_meta`` stamp table are auxiliary objects owned by
the app; their DDL lives in the single ``AUX_SCHEMA_SQL`` constant (F5), which
the TypeScript test fixtures reproduce verbatim.
"""

from __future__ import annotations

import datetime
import os
import pathlib
import sqlite3
from dataclasses import dataclass
from typing import Optional


@dataclass
class EmailRow:
    """One row of the ``emails`` table. Field order matches the DDL."""

    account: str
    mailbox: str
    message_id: int
    subject: Optional[str]
    sender: Optional[str]
    content: Optional[str]
    date_sent: Optional[int]
    emlx_path: Optional[str]


#: The single aux-DDL constant (F5): external-content FTS5 + sync triggers +
#: fruitmail_meta. Idempotent (IF NOT EXISTS throughout).
AUX_SCHEMA_SQL = """
-- External-content FTS5: shares storage with emails via implicit rowid.
-- Column order subject(0), sender(1), content(2) => bm25 weights (1.0, 0.5, 2.0).
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject,
  sender,
  content,
  content='emails',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, sender, content)
  VALUES (new.rowid, new.subject, new.sender, new.content);
END;

CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, sender, content)
  VALUES ('delete', old.rowid, old.subject, old.sender, old.content);
END;

CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, sender, content)
  VALUES ('delete', old.rowid, old.subject, old.sender, old.content);
  INSERT INTO emails_fts(rowid, subject, sender, content)
  VALUES (new.rowid, new.subject, new.sender, new.content);
END;

-- Index-level freshness + schema stamp (no per-file bookkeeping).
CREATE TABLE IF NOT EXISTS fruitmail_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
"""


def ensure_aux_schema(conn: sqlite3.Connection) -> None:
    """Idempotently create the aux objects. Run AFTER the emails table exists.

    Must be called on a connection with no explicit transaction open
    (``executescript`` manages its own transaction boundaries).
    """
    conn.executescript(AUX_SCHEMA_SQL)


def _upsert_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Upsert a key/value pair into ``fruitmail_meta``."""
    conn.execute(
        "INSERT INTO fruitmail_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def stamp_indexed_at(conn: sqlite3.Connection) -> None:
    """Record run completion (``indexed_at``) and the schema version."""
    iso_now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _upsert_meta(conn, "indexed_at", iso_now)
    _upsert_meta(conn, "schema_version", "1")
    conn.commit()


def secure_perms(path: pathlib.Path, mode: int = 0o600) -> None:
    """Recursively lock ``path`` down to owner-only access, if it exists.

    Files get ``mode`` (default 0600). Directories always get 0700 instead of
    ``mode`` — a directory needs its executable/search bit to stay
    traversable; 0600 on a directory makes it opaque (not even the owner can
    list/stat/recurse into it), which broke ``fs.rmSync({recursive: true})``
    on the LMDB state store's directory tree. Applied recursively since the
    state store may contain nested files/dirs (LMDB layout).
    """
    if not path.exists():
        return
    if path.is_dir():
        os.chmod(path, 0o700)
        for child in path.iterdir():
            secure_perms(child, mode)
    else:
        os.chmod(path, mode)
