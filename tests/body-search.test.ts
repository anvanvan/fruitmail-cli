/**
 * RED tests for src/body-search.ts (body-FTS feature).
 * bm25 ranking with weights subject 1.0 / sender 0.5 / content 2.0 (behavior 12),
 * filter composition (behavior 13) and hostile-FTS-query resilience (behavior 15).
 *
 * The fixture index.db is built directly with node:sqlite using the exact
 * architecture DDL (see tests/body-index-fixtures.ts); the Python indexer is
 * never invoked. The module under test does not exist yet — required lazily.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SQLiteDatabase } from '../src/sqlite';
import { buildIndexDb, EmailRowFixture } from './body-index-fixtures';

const loadBodySearch = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../src/body-search');
};

const NOW = Math.floor(Date.now() / 1000);
const THIRTY_DAYS_AGO = NOW - 30 * 86400;

// One 'zebra' occurrence per matching doc, placed in exactly one column each for
// docs 1-3 so bm25 column weights are observable: content(2.0) > subject(1.0) > sender(0.5).
const FIXTURE_ROWS: EmailRowFixture[] = [
    { account: 'ACC1', mailbox: 'Inbox', message_id: 1, subject: 'zebra facts digest', sender: 'carol@example.com', content: 'plain text about horses', date_sent: NOW, emlx_path: '/r/1.emlx' },
    { account: 'ACC1', mailbox: 'Inbox', message_id: 2, subject: 'weekly news digest', sender: 'zebra@example.com', content: 'plain text about horses', date_sent: NOW, emlx_path: '/r/2.emlx' },
    { account: 'ACC1', mailbox: 'Inbox', message_id: 3, subject: 'weekly news digest', sender: 'dave@example.com', content: 'plain text about zebra', date_sent: NOW, emlx_path: '/r/3.emlx' },
    { account: 'ACC2', mailbox: 'Archive', message_id: 4, subject: 'project update note', sender: 'erin@example.com', content: 'the zebra roams the plains', date_sent: NOW, emlx_path: '/r/4.emlx' },
    { account: 'ACC1', mailbox: 'Oldbox', message_id: 5, subject: 'ancient zebra archive', sender: 'frank@example.com', content: 'zebra history compendium', date_sent: THIRTY_DAYS_AGO, emlx_path: '/r/5.emlx' },
    { account: 'ACC1', mailbox: 'Inbox', message_id: 6, subject: 'quarterly budget recap', sender: 'gina@example.com', content: 'totally unrelated filler words', date_sent: NOW, emlx_path: '/r/6.emlx' }
];

const PAGINATION = { limit: 50, offset: 0 };

describe('body-search', () => {
    let work: string;
    let dbPath: string;
    let db: SQLiteDatabase;

    beforeAll(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitmail-body-'));
        dbPath = path.join(work, 'index.db');
        buildIndexDb(dbPath, FIXTURE_ROWS);
        db = new SQLiteDatabase(dbPath, { readonly: true, fileMustExist: true });
    });

    afterAll(() => {
        db.close();
        fs.rmSync(work, { recursive: true, force: true });
    });

    const ids = (rows: any[]): number[] => rows.map((row) => row.id).sort((a, b) => a - b);

    it('returns bm25-ranked rows: content matches outrank subject matches outrank sender matches', () => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'zebra', {}, PAGINATION);

        const order = rows.map((row: any) => row.id);
        expect(ids(rows)).toEqual([1, 2, 3, 4, 5]);
        // among the single-occurrence docs: content-only (3) > subject-only (1) > sender-only (2)
        expect(order.indexOf(3)).toBeLessThan(order.indexOf(1));
        expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
        // score is negated bm25 (higher = better), sorted descending, positive
        const scores = rows.map((row: any) => row.score);
        for (let i = 1; i < scores.length; i += 1) {
            expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
        }
        expect(scores[0]).toBeGreaterThan(0);
    });

    it('returns a content snippet and the id/date/sender/subject/mailbox row shape', () => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'zebra', {}, PAGINATION);

        const contentMatch = rows.find((row: any) => row.id === 3);
        expect(contentMatch).toBeDefined();
        expect(contentMatch.snippet).toContain('zebra');
        for (const key of ['id', 'date', 'sender', 'subject', 'mailbox', 'snippet', 'score']) {
            expect(contentMatch).toHaveProperty(key);
        }
    });

    it.each([
        ['--account equality', { account: 'ACC2' }, [4]],
        ['--mailbox case-insensitive equality', { mailbox: 'inbox' }, [1, 2, 3]],
        ['--sender LIKE', { sender: 'dave' }, [3]],
        ['--subject LIKE', { subject: 'weekly' }, [2, 3]],
        ['--days epoch cutoff excluding older date_sent', { days: 7 }, [1, 2, 3, 4]],
        ['--days epoch cutoff including rows inside the window', { days: 31 }, [1, 2, 3, 4, 5]]
    ])('composes the body match with the %s filter', (_name, filters, expected) => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'zebra', filters, PAGINATION);

        expect(ids(rows)).toEqual(expected);
    });

    it.each([
        ['unbalanced quote', '"unbalanced'],
        ['bare hyphen', '-'],
        ['bare open paren', '('],
        ['colon token', 'foo:bar'],
        ['dangling boolean', 'zebra AND'],
        ['paren soup', ')(']
    ])('never throws on hostile FTS input: %s', (_name, hostile) => {
        const { searchBody } = loadBodySearch();

        let rows: unknown;
        expect(() => {
            rows = searchBody(db, hostile, {}, PAGINATION);
        }).not.toThrow();
        expect(Array.isArray(rows)).toBe(true);
    });

    it('rethrows a non-fts5 error hit on the escaped-phrase retry path instead of swallowing it (F5)', () => {
        const { searchBody } = loadBodySearch();
        let calls = 0;
        const fakeDb = {
            prepare: () => ({
                all: () => {
                    calls += 1;
                    if (calls === 1) throw new Error('fts5: syntax error near "("');
                    throw new Error('database disk image is malformed');
                }
            })
        } as unknown as SQLiteDatabase;

        expect(() => searchBody(fakeDb, '(', {}, PAGINATION)).toThrow(/database disk image is malformed/);
    });

    it('still returns [] when the escaped-phrase retry also hits an fts5 error', () => {
        const { searchBody } = loadBodySearch();
        const fakeDb = {
            prepare: () => ({
                all: () => {
                    throw new Error('fts5: syntax error near "("');
                }
            })
        } as unknown as SQLiteDatabase;

        expect(searchBody(fakeDb, '(', {}, PAGINATION)).toEqual([]);
    });

    it.each([
        ['wraps tokens containing special characters in double quotes', 'foo-bar', '"foo-bar"'],
        ['keeps balanced phrases intact', '"exact phrase"', '"exact phrase"'],
        ['keeps trailing prefix wildcards', 'zeb*', 'zeb*'],
        ['keeps boolean operators', 'cats AND dogs', 'cats AND dogs']
    ])('sanitizeFtsQuery %s', (_name, input, expected) => {
        const { sanitizeFtsQuery } = loadBodySearch();

        expect(sanitizeFtsQuery(input)).toBe(expected);
    });
});

describe('body-search: --mailbox leaf/non-ASCII matching and --days:0 (F20, F31, F37)', () => {
    let work: string;
    let dbPath: string;
    let db: SQLiteDatabase;

    const REF_NOW = Math.floor(Date.now() / 1000);
    // Deterministic offsets (not "now") so the --days:0 assertion below can't
    // race against the few seconds between fixture build and test execution.
    const ROWS: EmailRowFixture[] = [
        { account: 'ACC1', mailbox: 'Work/Projects/Q1', message_id: 101, subject: 'walrus report', sender: 'x@example.com', content: 'walrus body', date_sent: REF_NOW + 5, emlx_path: '/r/101.emlx' },
        { account: 'ACC1', mailbox: 'CaféMailbox', message_id: 102, subject: 'narwhal update', sender: 'y@example.com', content: 'narwhal body', date_sent: REF_NOW, emlx_path: '/r/102.emlx' },
        { account: 'ACC1', mailbox: 'Inbox', message_id: 103, subject: 'walrus older', sender: 'z@example.com', content: 'walrus body older', date_sent: REF_NOW - 3600, emlx_path: '/r/103.emlx' }
    ];

    beforeAll(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitmail-body-filters-'));
        dbPath = path.join(work, 'index.db');
        buildIndexDb(dbPath, ROWS);
        db = new SQLiteDatabase(dbPath, { readonly: true, fileMustExist: true });
    });

    afterAll(() => {
        db.close();
        fs.rmSync(work, { recursive: true, force: true });
    });

    const ids = (rows: any[]): number[] => rows.map((row) => row.id).sort((a, b) => a - b);

    it('matches --mailbox against the leaf segment of a nested stored path (F31)', () => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'walrus', { mailbox: 'Q1' }, PAGINATION);

        expect(ids(rows)).toEqual([101]);
    });

    it('still matches --mailbox against the full stored path exactly (F31)', () => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'walrus', { mailbox: 'Work/Projects/Q1' }, PAGINATION);

        expect(ids(rows)).toEqual([101]);
    });

    it('--mailbox case-insensitivity holds for non-ASCII folder names, not just ASCII (F37)', () => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'narwhal', { mailbox: 'CAFÉMAILBOX' }, PAGINATION);

        expect(ids(rows)).toEqual([102]);
    });

    it('applies a numeric --days 0 cutoff instead of silently skipping the filter (F20)', () => {
        const { searchBody } = loadBodySearch();

        const rows = searchBody(db, 'walrus', { days: 0 }, PAGINATION);

        // 103 (an hour before the reference time) falls outside a "today" cutoff;
        // if days:0 were still falsy-skipped, both 101 and 103 would return.
        expect(ids(rows)).toEqual([101]);
    });
});
