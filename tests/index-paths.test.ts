/**
 * RED tests for src/index-paths.ts (body-FTS feature).
 * Path resolution + env overrides + numeric V<N> pick (F8) + indexerEnv authority.
 *
 * The module under test does not exist yet, so it is required lazily inside each
 * test body — a module-level import would ERROR the whole suite at collection.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

jest.mock('node:os');

const realOs: typeof os = jest.requireActual('node:os');
const mockHomedir = os.homedir as jest.Mock;

const ENV_KEYS = ['FRUITMAIL_MAIL_ROOT', 'FRUITMAIL_INDEX_DB', 'FRUITMAIL_STATE_DB', 'UV_PROJECT_ENVIRONMENT'] as const;

const loadIndexPaths = () => {
    jest.resetModules();
    // resetModules() clears jest's mock registry, so the module under test would
    // receive a FRESH node:os automock whose homedir() returns undefined instead
    // of the instance configured in beforeEach. Re-arm the fresh automock by
    // delegating to the already-configured mock (test infra only; no assertions).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('node:os').homedir as jest.Mock).mockImplementation(() => mockHomedir());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../src/index-paths');
};

describe('index-paths', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let fakeHome: string;

    beforeAll(() => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    });

    beforeEach(() => {
        jest.clearAllMocks();
        fakeHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'fruitmail-home-'));
        mockHomedir.mockReturnValue(fakeHome);
        for (const key of ENV_KEYS) delete process.env[key];
    });

    afterEach(() => {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    afterAll(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    const makeMailVersionDirs = (...names: string[]) => {
        for (const name of names) {
            fs.mkdirSync(path.join(fakeHome, 'Library', 'Mail', name), { recursive: true });
        }
    };

    it('mailRoot picks the highest V<N> mail root by numeric N (V10 beats V9)', () => {
        makeMailVersionDirs('V2', 'V9', 'V10');
        const { mailRoot } = loadIndexPaths();
        expect(mailRoot()).toBe(path.join(fakeHome, 'Library', 'Mail', 'V10'));
    });

    it('mailRoot honors the FRUITMAIL_MAIL_ROOT env override', () => {
        makeMailVersionDirs('V9', 'V10');
        const override = path.join(fakeHome, 'CustomMailRoot');
        fs.mkdirSync(override, { recursive: true });
        process.env.FRUITMAIL_MAIL_ROOT = override;
        const { mailRoot } = loadIndexPaths();
        expect(mailRoot()).toBe(override);
    });

    it('indexDbPath defaults to ~/.fruitmail/index.db', () => {
        const { indexDbPath } = loadIndexPaths();
        expect(indexDbPath()).toBe(path.join(fakeHome, '.fruitmail', 'index.db'));
    });

    it('indexDbPath honors the FRUITMAIL_INDEX_DB env override', () => {
        process.env.FRUITMAIL_INDEX_DB = '/custom/place/index.db';
        const { indexDbPath } = loadIndexPaths();
        expect(indexDbPath()).toBe('/custom/place/index.db');
    });

    it('stateDbPath defaults to ~/.fruitmail/cocoindex-state.db', () => {
        const { stateDbPath } = loadIndexPaths();
        expect(stateDbPath()).toBe(path.join(fakeHome, '.fruitmail', 'cocoindex-state.db'));
    });

    it('stateDbPath honors the FRUITMAIL_STATE_DB env override', () => {
        process.env.FRUITMAIL_STATE_DB = '/custom/place/state.db';
        const { stateDbPath } = loadIndexPaths();
        expect(stateDbPath()).toBe('/custom/place/state.db');
    });

    it('indexerDir resolves to the indexer directory next to the compiled dist', () => {
        const { indexerDir } = loadIndexPaths();
        expect(indexerDir()).toBe(path.resolve(__dirname, '..', 'indexer'));
    });

    it('indexerEnv always injects the resolved FRUITMAIL_MAIL_ROOT, FRUITMAIL_INDEX_DB and FRUITMAIL_STATE_DB (F8: TS is the root authority)', () => {
        makeMailVersionDirs('V9', 'V10');
        const { indexerEnv } = loadIndexPaths();
        const env = indexerEnv();
        expect(env.FRUITMAIL_MAIL_ROOT).toBe(path.join(fakeHome, 'Library', 'Mail', 'V10'));
        expect(env.FRUITMAIL_INDEX_DB).toBe(path.join(fakeHome, '.fruitmail', 'index.db'));
        expect(env.FRUITMAIL_STATE_DB).toBe(path.join(fakeHome, '.fruitmail', 'cocoindex-state.db'));
    });

    it('indexerEnv points UV_PROJECT_ENVIRONMENT at a writable per-user venv so uv never creates .venv in the shipped indexer/ tree (F42)', () => {
        makeMailVersionDirs('V10');
        delete process.env.UV_PROJECT_ENVIRONMENT;
        const { indexerEnv } = loadIndexPaths();
        expect(indexerEnv().UV_PROJECT_ENVIRONMENT).toBe(path.join(fakeHome, '.fruitmail', 'venv'));
    });

    it('indexerEnv honors an explicit UV_PROJECT_ENVIRONMENT override', () => {
        makeMailVersionDirs('V10');
        process.env.UV_PROJECT_ENVIRONMENT = '/custom/venv';
        const { indexerEnv } = loadIndexPaths();
        expect(indexerEnv().UV_PROJECT_ENVIRONMENT).toBe('/custom/venv');
    });
});
