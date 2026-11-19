import { exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Apple Mail stores messages.message_id as a signed 64-bit hash. node:sqlite throws
// on reading an INTEGER beyond Number.MAX_SAFE_INTEGER, so the DB fallback of
// `body` / `open` must not read such a value as a JS number.
describe('Integration: body DB fallback with a 64-bit message_id', () => {
    const binPath = path.resolve(__dirname, '../bin/fruitmail');
    let tempDir = '';
    let dbPath = '';

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitmail-body-lookup-'));
        dbPath = path.join(tempDir, 'envelope.db');
        const db = new DatabaseSync(dbPath);
        db.exec(`
          CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, date_sent INTEGER, subject INTEGER, sender INTEGER,
            read INTEGER, deleted INTEGER, message_id INTEGER, mailbox INTEGER);
          CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
          CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
          CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
          INSERT INTO subjects VALUES (1, 'Bigint Draft');
          INSERT INTO addresses VALUES (1, 'me@example.com', 'Me');
          INSERT INTO mailboxes VALUES (1, 'imap://acct/Drafts');
          INSERT INTO subjects VALUES (2, 'Min Int Draft');
          INSERT INTO subjects VALUES (3, 'Max Int Draft');
          INSERT INTO subjects VALUES (4, 'Safe Id Draft');
          INSERT INTO messages VALUES (200, 0, 1, 1, 1, 0, -301164615026087337, 1);
          INSERT INTO messages VALUES (201, 0, 2, 1, 1, 0, -9223372036854775808, 1);
          INSERT INTO messages VALUES (202, 0, 3, 1, 1, 0, 9223372036854775807, 1);
          INSERT INTO messages VALUES (203, 0, 4, 1, 1, 0, 42, 1);
        `);
        db.close();

        // The id-only lookup misses; the DB fallback finds the message by its subject.
        const osascriptPath = path.join(tempDir, 'osascript');
        fs.writeFileSync(osascriptPath, `#!/usr/bin/env bash
payload="$*"
if [[ "$payload" != *"-e"* ]]; then payload="$(cat)"; fi
case "$payload" in
  *"Bigint Draft"*) printf 'Mock Body' ;;
  *"Min Int Draft"*) printf 'Min Body' ;;
  *"Max Int Draft"*) printf 'Max Body' ;;
  *"Safe Id Draft"*) printf 'Safe Body' ;;
  *) printf '__FRUITMAIL_NOT_FOUND__' ;;
esac
`);
        fs.chmodSync(osascriptPath, 0o755);
    });

    afterAll(() => {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // Rows: ROWID → body; message_id spans INT64 min, max, a 64-bit hash and a safe id.
    it.each([
        [200, 'Mock Body'],
        [201, 'Min Body'],
        [202, 'Max Body'],
        [203, 'Safe Body']
    ])('reads the body of message %d through the DB fallback', async (rowid, body) => {
        const stdout = await new Promise<string>((resolve, reject) => {
            exec(`node ${binPath} --db "${dbPath}" body ${rowid}`, {
                env: { ...process.env, FORCE_COLOR: '0', PATH: `${tempDir}${path.delimiter}${process.env.PATH}` }
            }, (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out.trim())));
        });
        expect(stdout).toBe(body);
    });
});
