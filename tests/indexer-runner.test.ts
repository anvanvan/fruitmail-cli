/**
 * RED tests for src/indexer-runner.ts (body-FTS feature).
 * runIndexer build/refresh semantics, missing-uv/stderr surfacing, staleness
 * (incl. stamp-less db => stale => refresh, F2) and ensureIndexFresh routing.
 *
 * Uses a real fake `uv` executable on PATH (no child_process mocking), matching
 * the existing suite's stub-binary pattern (see tests/search.test.ts osascript stub).
 * The module under test does not exist yet — required lazily inside test bodies.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildIndexDb, installUvStub, EmailRowFixture } from './body-index-fixtures';

const loadRunner = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../src/indexer-runner');
};

const sampleRows = (): EmailRowFixture[] => {
    const now = Math.floor(Date.now() / 1000);
    return [
        { account: 'ACC1', mailbox: 'Inbox', message_id: 1, subject: 'one', sender: 'a@example.com', content: 'first body', date_sent: now, emlx_path: '/r/1.emlx' },
        { account: 'ACC1', mailbox: 'Inbox', message_id: 2, subject: 'two', sender: 'b@example.com', content: 'second body', date_sent: now, emlx_path: '/r/2.emlx' }
    ];
};

describe('indexer-runner', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
        'FRUITMAIL_MAIL_ROOT', 'FRUITMAIL_INDEX_DB', 'FRUITMAIL_STATE_DB',
        'FRUITMAIL_TEST_UV_LOG', 'FRUITMAIL_TEST_UV_EXIT', 'FRUITMAIL_TEST_UV_STDERR',
        'FRUITMAIL_TEST_UV_CREATE_DB', 'PATH'
    ] as const;

    let work: string;
    let stubBin: string;
    let uvLog: string;
    let indexDb: string;
    let stateDb: string;

    beforeAll(() => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    });

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitmail-runner-'));
        stubBin = path.join(work, 'bin');
        installUvStub(stubBin);
        uvLog = path.join(work, 'uv.log');
        indexDb = path.join(work, 'index.db');
        stateDb = path.join(work, 'state.db');
        fs.mkdirSync(path.join(work, 'mailroot'), { recursive: true });
        process.env.FRUITMAIL_INDEX_DB = indexDb;
        process.env.FRUITMAIL_STATE_DB = stateDb;
        process.env.FRUITMAIL_MAIL_ROOT = path.join(work, 'mailroot');
        process.env.FRUITMAIL_TEST_UV_LOG = uvLog;
        delete process.env.FRUITMAIL_TEST_UV_EXIT;
        delete process.env.FRUITMAIL_TEST_UV_STDERR;
        delete process.env.FRUITMAIL_TEST_UV_CREATE_DB;
        process.env.PATH = `${stubBin}${path.delimiter}${savedEnv.PATH}`;
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        fs.rmSync(work, { recursive: true, force: true });
    });

    const uvInvocations = (): string => (fs.existsSync(uvLog) ? fs.readFileSync(uvLog, 'utf8') : '');
    const tempLeftovers = (): string[] => fs.readdirSync(work).filter((name) => name.includes('.build-') && name.endsWith('.tmp'));

    it('runIndexer("build") builds into a temp db and atomically swaps it into index.db/state.db on success (F2)', async () => {
        fs.writeFileSync(indexDb, 'stale index bytes');
        fs.writeFileSync(stateDb, 'stale state bytes');
        process.env.FRUITMAIL_TEST_UV_CREATE_DB = '1';
        const { runIndexer } = loadRunner();

        await runIndexer('build');

        expect(fs.readFileSync(indexDb, 'utf8')).toBe(''); // replaced by the freshly built (empty) temp file
        expect(fs.statSync(stateDb).isDirectory()).toBe(true); // replaced by the freshly built state dir
        expect(fs.existsSync(path.join(stateDb, 'data.mdb'))).toBe(true);
        expect(tempLeftovers()).toEqual([]); // no stray temp files left behind
        const log = uvInvocations();
        expect(log).toContain('ARGS run cocoindex update main.py');
        expect(log).toContain(`CWD ${path.resolve(__dirname, '..', 'indexer')}`);
    });

    it('runIndexer("build") preserves the existing index and state db when the rebuild fails (F2)', async () => {
        fs.writeFileSync(indexDb, 'good index bytes');
        fs.mkdirSync(stateDb, { recursive: true });
        fs.writeFileSync(path.join(stateDb, 'data.mdb'), 'good lmdb payload');
        process.env.FRUITMAIL_TEST_UV_EXIT = '1';
        process.env.FRUITMAIL_TEST_UV_STDERR = 'uv offline';
        const { runIndexer } = loadRunner();

        await expect(runIndexer('build')).rejects.toThrow(/uv offline/);

        expect(fs.readFileSync(indexDb, 'utf8')).toBe('good index bytes');
        expect(fs.readFileSync(path.join(stateDb, 'data.mdb'), 'utf8')).toBe('good lmdb payload');
        expect(tempLeftovers()).toEqual([]); // failed-build temp files are cleaned up
    });

    it('runIndexer("build") replaces a directory-shaped state db (LMDB) without throwing (F0)', async () => {
        fs.writeFileSync(indexDb, 'stale index bytes');
        fs.mkdirSync(stateDb, { recursive: true });
        fs.writeFileSync(path.join(stateDb, 'data.mdb'), 'lmdb payload');
        process.env.FRUITMAIL_TEST_UV_CREATE_DB = '1';
        const { runIndexer } = loadRunner();

        await runIndexer('build');

        expect(fs.existsSync(indexDb)).toBe(true);
        expect(fs.statSync(stateDb).isDirectory()).toBe(true);
    });

    it('runIndexer("build") swaps a non-empty LMDB-shaped state db in place across consecutive builds, sweeping stray leftovers, without ENOTEMPTY', async () => {
        // Regression: delete-then-rename could lose the race against POSIX's
        // refusal to rename over a non-empty directory, so a real LMDB state
        // store crashed the *second* and *third* build. Also seed a stray
        // leftover temp dir (as a prior aborted build would leave) to prove
        // it gets swept, not tripped over.
        fs.writeFileSync(indexDb, 'stale index bytes');
        fs.mkdirSync(stateDb, { recursive: true });
        fs.writeFileSync(path.join(stateDb, 'data.mdb'), 'lmdb payload 1');
        const strayStateTmp = path.join(work, '.state.db.build-deadbeef0000.tmp');
        fs.mkdirSync(strayStateTmp, { recursive: true });
        fs.writeFileSync(path.join(strayStateTmp, 'junk'), 'leftover from a killed build');
        const strayIndexTmp = path.join(work, '.index.db.build-deadbeef0000.tmp');
        fs.writeFileSync(strayIndexTmp, 'leftover index temp');
        process.env.FRUITMAIL_TEST_UV_CREATE_DB = '1';
        const { runIndexer } = loadRunner();

        await runIndexer('build'); // "build 2" against a real prior LMDB dir
        expect(fs.statSync(stateDb).isDirectory()).toBe(true);
        expect(tempLeftovers()).toEqual([]); // the seeded strays are swept too

        await runIndexer('build'); // "build 3" against the just-rebuilt LMDB dir
        expect(fs.statSync(stateDb).isDirectory()).toBe(true);
        expect(fs.existsSync(indexDb)).toBe(true);
        expect(tempLeftovers()).toEqual([]);
    });

    it('self-heals a stray non-traversable (0600) directory left by a poisoned older build, across consecutive builds', async () => {
        // Regression: secure_perms() used to chmod the LMDB state dir to
        // 0600 (no execute/search bit), making it non-traversable — so
        // fs.rmSync({recursive:true}) on it (both the superseded aside copy
        // after a successful swap, and a stray leftover from an even older
        // aborted build) threw ENOTEMPTY/EACCES, crashing the build AFTER a
        // successful swap and leaving a permanently poisoned leftover that
        // tripped up every later build identically.
        fs.writeFileSync(indexDb, 'stale index bytes');
        fs.mkdirSync(stateDb, { recursive: true });
        fs.writeFileSync(path.join(stateDb, 'data.mdb'), 'poisoned lmdb payload');
        fs.chmodSync(stateDb, 0o600); // non-traversable: not even the owner can list it

        const strayStateTmp = path.join(work, '.state.db.build-poisoned0001.tmp');
        fs.mkdirSync(strayStateTmp, { recursive: true });
        fs.writeFileSync(path.join(strayStateTmp, 'junk'), 'leftover from an even older, poisoned build');
        fs.chmodSync(strayStateTmp, 0o600); // also non-traversable

        process.env.FRUITMAIL_TEST_UV_CREATE_DB = '1';
        const { runIndexer } = loadRunner();

        await runIndexer('build'); // must self-heal + succeed despite the poisoned tree
        expect(fs.statSync(stateDb).isDirectory()).toBe(true);
        expect(tempLeftovers()).toEqual([]); // poisoned stray + superseded aside both healed and removed

        await runIndexer('build'); // a second consecutive build must also succeed
        expect(fs.statSync(stateDb).isDirectory()).toBe(true);
        expect(fs.existsSync(indexDb)).toBe(true);
        expect(tempLeftovers()).toEqual([]);
    });

    it('a mid-swap rename failure restores the previous state db instead of losing it', async () => {
        fs.writeFileSync(indexDb, 'good index bytes');
        fs.mkdirSync(stateDb, { recursive: true });
        fs.writeFileSync(path.join(stateDb, 'data.mdb'), 'good lmdb payload');
        process.env.FRUITMAIL_TEST_UV_CREATE_DB = '1';
        const { runIndexer } = loadRunner();

        const originalRename = fs.renameSync;
        let callsTargetingStateDb = 0;
        const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            // Two renames target `stateDb` as their destination: the swap-IN
            // (temp -> real) we want to fail, and swapIntoPlace's own
            // restore-on-failure (aside -> real) afterward, which must be
            // allowed through so the previous state db isn't lost for real.
            if (String(newPath) === stateDb) {
                callsTargetingStateDb += 1;
                if (callsTargetingStateDb === 1) {
                    throw new Error('simulated rename failure mid-swap');
                }
            }
            return originalRename(oldPath, newPath);
        }) as typeof fs.renameSync);

        try {
            await expect(runIndexer('build')).rejects.toThrow(/simulated rename failure mid-swap/);
        } finally {
            renameSpy.mockRestore();
        }

        expect(fs.statSync(stateDb).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(stateDb, 'data.mdb'), 'utf8')).toBe('good lmdb payload');
    });

    it('runIndexer("refresh") runs the indexer without deleting the existing dbs', async () => {
        fs.writeFileSync(indexDb, 'keep me');
        fs.writeFileSync(stateDb, 'keep me too');
        const { runIndexer } = loadRunner();

        await runIndexer('refresh');

        expect(fs.existsSync(indexDb)).toBe(true);
        expect(fs.existsSync(stateDb)).toBe(true);
        expect(uvInvocations()).toContain('ARGS run cocoindex update main.py');
    });

    it('missing uv (ENOENT) rejects with an actionable install message', async () => {
        const emptyBin = path.join(work, 'empty-bin');
        fs.mkdirSync(emptyBin, { recursive: true });
        process.env.PATH = emptyBin;
        const { runIndexer } = loadRunner();

        await expect(runIndexer('refresh')).rejects.toThrow(/uv not found/i);
        await expect(runIndexer('refresh')).rejects.toThrow(/docs\.astral\.sh\/uv/);
    });

    it('non-zero indexer exit rejects with the trimmed stderr', async () => {
        process.env.FRUITMAIL_TEST_UV_EXIT = '3';
        process.env.FRUITMAIL_TEST_UV_STDERR = 'cocoindex exploded: bad flow';
        const { runIndexer } = loadRunner();

        await expect(runIndexer('refresh')).rejects.toThrow(/cocoindex exploded: bad flow/);
    });

    it('forwards exit-0 stderr that does not contain "warning" (per-file skip diagnostics, F16)', async () => {
        process.env.FRUITMAIL_TEST_UV_STDERR = 'fruitmail-indexer: skipping (bad-name): /r/x.emlx';
        const { runIndexer } = loadRunner();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

        await runIndexer('refresh');

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping (bad-name)'));
        warnSpy.mockRestore();
    });

    it('getIndexStatus reports stale with indexedAt=null when the indexed_at stamp is absent (F2)', () => {
        buildIndexDb(indexDb, sampleRows(), { indexedAt: null });
        const { getIndexStatus } = loadRunner();

        const status = getIndexStatus();

        expect(status.exists).toBe(true);
        expect(status.emails).toBe(2);
        expect(status.indexedAt).toBeNull();
        expect(status.stale).toBe(true);
    });

    it('getIndexStatus reports needs-rebuild (stale) instead of throwing when index.db exists but is schemaless (F1)', () => {
        // Simulates a build killed between sqlite.connect and table creation.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DatabaseSync } = require('node:sqlite');
        const rawDb = new DatabaseSync(indexDb);
        rawDb.exec('CREATE TABLE unrelated (x INTEGER)');
        rawDb.close();
        const { getIndexStatus } = loadRunner();

        const status = getIndexStatus();

        expect(status.exists).toBe(true);
        expect(status.stale).toBe(true);
        expect(status.indexedAt).toBeNull();
    });

    it('getIndexStatus reports exists:false without throwing when index.db is missing', () => {
        const { getIndexStatus } = loadRunner();

        const status = getIndexStatus();

        expect(status.exists).toBe(false);
    });

    it('ensureIndexFresh builds (atomically replacing the orphan state db) when index.db is missing (F2)', async () => {
        fs.writeFileSync(stateDb, 'orphan state');
        process.env.FRUITMAIL_TEST_UV_CREATE_DB = '1';
        const { ensureIndexFresh } = loadRunner();

        await ensureIndexFresh();

        expect(uvInvocations()).toContain('cocoindex update');
        expect(fs.existsSync(indexDb)).toBe(true);
        expect(fs.statSync(stateDb).isDirectory()).toBe(true); // orphan file replaced by the new state db
    });

    it('ensureIndexFresh refreshes (keeps the dbs) when index.db exists but the stamp is absent (F2)', async () => {
        buildIndexDb(indexDb, sampleRows(), { indexedAt: null });
        fs.writeFileSync(stateDb, 'state');
        const { ensureIndexFresh } = loadRunner();

        await ensureIndexFresh();

        expect(uvInvocations()).toContain('cocoindex update');
        expect(fs.existsSync(indexDb)).toBe(true);
        expect(fs.existsSync(stateDb)).toBe(true);
    });

    it('ensureIndexFresh refreshes when the index is older than 24 hours', async () => {
        const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        buildIndexDb(indexDb, sampleRows(), { indexedAt: twoDaysAgo });
        const { ensureIndexFresh } = loadRunner();

        await ensureIndexFresh();

        expect(uvInvocations()).toContain('cocoindex update');
        expect(fs.existsSync(indexDb)).toBe(true);
    });

    it('ensureIndexFresh does not run the indexer when the index is fresh', async () => {
        buildIndexDb(indexDb, sampleRows(), { indexedAt: new Date().toISOString() });
        const { ensureIndexFresh } = loadRunner();

        await ensureIndexFresh();

        expect(uvInvocations()).toBe('');
    });
});
