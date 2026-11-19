import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Table output strips control chars from a cell, but a tab or line break separates
// words: each one becomes a single space, never glues the words together.
const ROWS: Array<[subject: string, cell: string]> = [
    ['Invoice\tMarch\nPayment', 'Invoice March Payment'],
    ['Line\r\nBreak', 'Line Break'],
    ['Tab\t\tTwice', 'Tab Twice'],
    ['Esc\x1b[31mRed', 'Esc[31mRed'],
    ['Bell\x07Ring', 'BellRing']
];

describe('Integration: table cells with control characters', () => {
    const binPath = path.resolve(__dirname, '../bin/fruitmail');
    let tempDir = '';
    let dbPath = '';

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitmail-table-cells-'));
        dbPath = path.join(tempDir, 'envelope.db');
        const db = new DatabaseSync(dbPath);
        db.exec(`
          CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, date_sent INTEGER, subject INTEGER, sender INTEGER,
            read INTEGER, deleted INTEGER, mailbox INTEGER);
          CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
          CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
          CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
          INSERT INTO addresses VALUES (1, 'me@example.com', 'Me');
          INSERT INTO mailboxes VALUES (1, 'imap://acct/INBOX');
        `);
        ROWS.forEach(([subject], index) => {
            db.prepare('INSERT INTO subjects VALUES (?, ?)').run(index + 1, subject);
            db.prepare('INSERT INTO messages VALUES (?, 0, ?, 1, 1, 0, 1)').run(100 + index, index + 1);
        });
        db.close();
    });

    afterAll(() => {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it.each(ROWS)('renders subject %j as %j', async (subject, cell) => {
        const needle = subject.slice(0, 3);
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile('node', [binPath, '--db', dbPath, 'subject', needle], {
                env: { ...process.env, FORCE_COLOR: '0' }
            }, (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out)));
        });
        const cells = stdout.split('\n').flatMap((line) => line.split('│').map((part) => part.trim()));
        expect(cells).toContain(cell);
    });
});
