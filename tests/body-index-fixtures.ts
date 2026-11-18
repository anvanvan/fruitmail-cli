/**
 * Test fixtures for the body full-text-search feature.
 *
 * Reproduces the cross-side SQLite contract from the architecture verbatim:
 * the `emails` base table exactly as the CocoIndex sqlite connector generates it,
 * and AUX_SCHEMA_SQL (FTS5 vtable + 3 sync triggers + fruitmail_meta) exactly as
 * `indexer/schema.py` defines it. TS tests never invoke the Python indexer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const EMAILS_DDL = `CREATE TABLE IF NOT EXISTS "emails" (
  "account"    TEXT    NOT NULL,
  "mailbox"    TEXT    NOT NULL,
  "message_id" INTEGER NOT NULL,
  "subject"    TEXT,
  "sender"     TEXT,
  "content"    TEXT,
  "date_sent"  INTEGER,
  "emlx_path"  TEXT,
  PRIMARY KEY ("account", "mailbox", "message_id")
);`;

export const AUX_SCHEMA_SQL = `-- External-content FTS5: shares storage with emails via implicit rowid.
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
);`;

export interface EmailRowFixture {
    account: string;
    mailbox: string;
    message_id: number;
    subject: string | null;
    sender: string | null;
    content: string | null;
    date_sent: number | null;
    emlx_path: string | null;
}

export interface BuildIndexDbOptions {
    /** ISO timestamp for fruitmail_meta.indexed_at; `null` = no stamp row (F2 fixture). */
    indexedAt?: string | null;
}

export function buildIndexDb(filePath: string, rows: EmailRowFixture[], opts: BuildIndexDbOptions = {}): void {
    const db = new DatabaseSync(filePath);
    try {
        db.exec(EMAILS_DDL);
        db.exec(AUX_SCHEMA_SQL);
        const insert = db.prepare(
            'INSERT INTO emails (account, mailbox, message_id, subject, sender, content, date_sent, emlx_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const row of rows) {
            insert.run(row.account, row.mailbox, row.message_id, row.subject, row.sender, row.content, row.date_sent, row.emlx_path);
        }
        if (opts.indexedAt !== null) {
            const stamp = opts.indexedAt ?? new Date().toISOString();
            db.prepare("INSERT INTO fruitmail_meta(key, value) VALUES ('indexed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(stamp);
            db.prepare("INSERT INTO fruitmail_meta(key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
        }
    } finally {
        db.close();
    }
}

/**
 * Install a fake `uv` executable into `dir`.
 * Controlled via env vars:
 *   FRUITMAIL_TEST_UV_LOG       - append "CWD <pwd>" and "ARGS <argv>" lines here
 *   FRUITMAIL_TEST_UV_STDERR    - emit this on stderr
 *   FRUITMAIL_TEST_UV_EXIT      - exit code (default 0)
 *   FRUITMAIL_TEST_UV_CREATE_DB - on exit 0, write a fake index.db file and a
 *     state.db directory at the paths the child actually received via
 *     FRUITMAIL_INDEX_DB/FRUITMAIL_STATE_DB (the temp paths during a build,
 *     F2), simulating a real indexer run for atomic-swap tests.
 */
export function installUvStub(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const uvPath = path.join(dir, 'uv');
    fs.writeFileSync(uvPath, `#!/bin/bash
if [ -n "$FRUITMAIL_TEST_UV_LOG" ]; then
  printf 'CWD %s\\nARGS %s\\n' "$PWD" "$*" >> "$FRUITMAIL_TEST_UV_LOG"
fi
if [ -n "$FRUITMAIL_TEST_UV_STDERR" ]; then
  echo "$FRUITMAIL_TEST_UV_STDERR" >&2
fi
if [ -n "$FRUITMAIL_TEST_UV_CREATE_DB" ] && [ "\${FRUITMAIL_TEST_UV_EXIT:-0}" = "0" ]; then
  : > "$FRUITMAIL_INDEX_DB"
  mkdir -p "$FRUITMAIL_STATE_DB"
  echo lmdb > "$FRUITMAIL_STATE_DB/data.mdb"
fi
exit "\${FRUITMAIL_TEST_UV_EXIT:-0}"
`);
    fs.chmodSync(uvPath, 0o755);
    return uvPath;
}

/** Minimal Apple Mail Envelope-Index-shaped db (same schema the existing search tests use). */
export function buildMetadataDb(filePath: string, messages: Array<{ id: number; dateSent: number; subject: string }>): void {
    const db = new DatabaseSync(filePath);
    try {
        db.exec(`
    CREATE TABLE messages (
      ROWID INTEGER PRIMARY KEY,
      date_sent INTEGER,
      subject INTEGER,
      sender INTEGER,
      read INTEGER DEFAULT 1,
      deleted INTEGER DEFAULT 0,
      document_id TEXT,
      mailbox INTEGER
    );
    CREATE TABLE subjects (
        ROWID INTEGER PRIMARY KEY,
        subject TEXT
    );
    CREATE TABLE addresses (
        ROWID INTEGER PRIMARY KEY,
        address TEXT,
        comment TEXT
    );
    CREATE TABLE recipients (
        message INTEGER,
        address INTEGER
    );
    CREATE TABLE attachments (
        message INTEGER,
        name TEXT
    );
    CREATE TABLE mailboxes (
        ROWID INTEGER PRIMARY KEY,
        display_name TEXT
    );
  `);
        db.prepare("INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'someone@example.com', 'Someone')").run();
        db.prepare("INSERT INTO mailboxes (ROWID, display_name) VALUES (10, 'Inbox')").run();
        let subjectId = 1;
        for (const message of messages) {
            db.prepare('INSERT INTO subjects (ROWID, subject) VALUES (?, ?)').run(subjectId, message.subject);
            db.prepare('INSERT INTO messages (ROWID, date_sent, subject, sender, read, deleted, mailbox) VALUES (?, ?, ?, 1, 1, 0, 10)').run(
                message.id, message.dateSent, subjectId
            );
            subjectId += 1;
        }
    } finally {
        db.close();
    }
}
