/**
 * RED E2E tests for the CLI wiring (src/index.ts edits, body-FTS feature):
 * `search --body`, the `index build/refresh/status` verb group, --days parity
 * with the metadata search (F6), --json cleanliness, status perms, and the
 * package.json script/deps contract.
 *
 * Runs `node bin/fruitmail` like the existing E2E suite; `uv` is a stub binary
 * on PATH and index.db fixtures are built with node:sqlite (never the Python indexer).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildIndexDb, buildMetadataDb, installUvStub, EmailRowFixture } from './body-index-fixtures';

const binPath = path.resolve(__dirname, '../bin/fruitmail');
const packageJsonPath = path.resolve(__dirname, '../package.json');

interface CliResult {
    stdout: string;
    stderr: string;
    failed: boolean;
}

describe('Integration: body search + index CLI', () => {
    let work: string;
    let stubBin: string;
    let uvLog: string;
    let indexDb: string;
    let stateDb: string;
    let mailRoot: string;

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'fruitmail-cli-body-'));
        stubBin = path.join(work, 'bin');
        installUvStub(stubBin);
        uvLog = path.join(work, 'uv.log');
        indexDb = path.join(work, 'index.db');
        stateDb = path.join(work, 'state.db');
        mailRoot = path.join(work, 'mailroot');
        fs.mkdirSync(mailRoot, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(work, { recursive: true, force: true });
    });

    const cliEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        ...process.env,
        FORCE_COLOR: '0',
        FRUITMAIL_INDEX_DB: indexDb,
        FRUITMAIL_STATE_DB: stateDb,
        FRUITMAIL_MAIL_ROOT: mailRoot,
        FRUITMAIL_TEST_UV_LOG: uvLog,
        PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
        ...extra
    });

    const runCli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}, tolerateFailure = false): Promise<CliResult> =>
        new Promise((resolve, reject) => {
            execFile('node', [binPath, ...args], { env: cliEnv(extraEnv) }, (error, stdout, stderr) => {
                if (error && !tolerateFailure) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve({ stdout, stderr, failed: Boolean(error) });
            });
        });

    const uvInvocations = (): string => (fs.existsSync(uvLog) ? fs.readFileSync(uvLog, 'utf8') : '');

    const freshRow = (overrides: Partial<EmailRowFixture> = {}): EmailRowFixture => ({
        account: 'ACC1',
        mailbox: 'Inbox',
        message_id: 1,
        subject: 'greetings',
        sender: 'alice@example.com',
        content: 'a body with the zanzibar token inside',
        date_sent: Math.floor(Date.now() / 1000),
        emlx_path: '/r/1.emlx',
        ...overrides
    });

    it('search --body emits bm25 body matches as parseable JSON with a snippet and no ANSI noise', async () => {
        buildIndexDb(indexDb, [freshRow()]);

        const { stdout } = await runCli(['search', '--body', 'zanzibar', '--days', '3650', '--json']);

        // eslint-disable-next-line no-control-regex
        expect(stdout).not.toMatch(/\u001b\[/);
        const rows = JSON.parse(stdout);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(1);
        expect(rows[0].snippet).toContain('zanzibar');
    });

    it('--days windows agree between metadata search and search --body (same epoch cutoff on date_sent, F6)', async () => {
        const now = Math.floor(Date.now() / 1000);
        const recent = now - 2 * 86400;
        const old = now - 10 * 86400;
        const metaDb = path.join(work, 'envelope.db');
        buildMetadataDb(metaDb, [
            { id: 900, dateSent: recent, subject: 'ParityRecent' },
            { id: 901, dateSent: old, subject: 'ParityOld' }
        ]);
        buildIndexDb(indexDb, [
            freshRow({ message_id: 501, date_sent: recent, content: 'parityterm current' }),
            freshRow({ message_id: 502, date_sent: old, content: 'parityterm older' })
        ]);

        for (const [days, metaIds, bodyIds] of [
            ['7', [900], [501]],
            ['30', [900, 901], [501, 502]]
        ] as Array<[string, number[], number[]]>) {
            const meta = JSON.parse((await runCli(['--db', metaDb, 'search', '--days', days, '--json'])).stdout);
            const body = JSON.parse((await runCli(['search', '--body', 'parityterm', '--days', days, '--json'])).stdout);
            expect(meta.map((row: any) => row.id).sort()).toEqual(metaIds);
            expect(body.map((row: any) => row.id).sort()).toEqual(bodyIds);
        }
    });

    it('search --body applies no implicit --days window (full-index search unless the flag is given)', async () => {
        const now = Math.floor(Date.now() / 1000);
        const old = now - 30 * 86400; // well outside the metadata verb's 7-day default
        buildIndexDb(indexDb, [
            freshRow({ message_id: 601, date_sent: old, content: 'implicitwindow ancient' })
        ]);

        // Without --days: the >7-day-old row must be returned (no inherited default).
        const noDays = JSON.parse((await runCli(['search', '--body', 'implicitwindow', '--json'])).stdout);
        expect(noDays.map((row: any) => row.id)).toEqual([601]);

        // With an explicit --days 7: the same row is excluded (F6 cutoff semantics kept).
        const withDays = JSON.parse((await runCli(['search', '--body', 'implicitwindow', '--days', '7', '--json'])).stdout);
        expect(withDays).toEqual([]);
    });

    it('index status --json emits the index state as parseable JSON', async () => {
        buildIndexDb(indexDb, [freshRow()]);

        const { stdout } = await runCli(['index', 'status', '--json']);

        // eslint-disable-next-line no-control-regex
        expect(stdout).not.toMatch(/\u001b\[/);
        const status = JSON.parse(stdout);
        expect(status.exists).toBe(true);
        expect(status.emails).toBe(1);
        expect(status.indexedAt).toBeTruthy();
        expect(status.stale).toBe(false);
        expect(status.path).toBe(indexDb);
    });

    it('index status reports the 0600 permissions of the index db', async () => {
        buildIndexDb(indexDb, [freshRow()]);
        fs.chmodSync(indexDb, 0o600);

        const status = JSON.parse((await runCli(['index', 'status', '--json'])).stdout);

        const mode = status.mode;
        expect(mode).toBeDefined();
        if (typeof mode === 'number') {
            expect(mode & 0o777).toBe(0o600);
        } else {
            expect(String(mode)).toMatch(/600/);
        }
    });

    it('index build atomically replaces the index and state dbs only once the rebuild succeeds (F2), and invokes the indexer via uv', async () => {
        buildIndexDb(indexDb, [freshRow()]);
        fs.writeFileSync(stateDb, 'old state');

        await runCli(['index', 'build', '--json'], { FRUITMAIL_TEST_UV_CREATE_DB: '1' });

        expect(fs.readFileSync(indexDb, 'utf8')).toBe(''); // replaced by the freshly built (empty) temp file
        expect(fs.statSync(stateDb).isDirectory()).toBe(true); // replaced by the freshly built state dir
        expect(uvInvocations()).toContain('run cocoindex update main.py');
    });

    it('index build preserves the existing index and state dbs when the rebuild fails (F2)', async () => {
        buildIndexDb(indexDb, [freshRow()]);
        const before = fs.readFileSync(indexDb);

        await runCli(['index', 'build'], { FRUITMAIL_TEST_UV_EXIT: '1' }, true);

        expect(fs.readFileSync(indexDb)).toEqual(before);
    });

    it('index refresh invokes the indexer via uv without deleting the index db', async () => {
        buildIndexDb(indexDb, [freshRow()]);

        await runCli(['index', 'refresh']);

        expect(fs.existsSync(indexDb)).toBe(true);
        expect(uvInvocations()).toContain('run cocoindex update main.py');
    });

    it('search --body falls back to a stale index with a warning when its auto-refresh fails', async () => {
        const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        buildIndexDb(indexDb, [freshRow()], { indexedAt: twoDaysAgo });

        const result = await runCli(['search', '--body', 'zanzibar', '--json'], {
            FRUITMAIL_TEST_UV_EXIT: '1',
            FRUITMAIL_TEST_UV_STDERR: 'offline: cannot reach mail root'
        }, true);

        expect(uvInvocations()).toContain('cocoindex update');
        expect(result.failed).toBe(false);
        expect(JSON.parse(result.stdout).map((row: any) => row.id)).toEqual([1]);
        expect(result.stderr).toMatch(/stale/i);
        expect(result.stderr).toContain('offline: cannot reach mail root');
    });

    it('search --body reports the refresh failure when the stale index was never completed', async () => {
        fs.writeFileSync(indexDb, ''); // build killed before table creation: no schema, no stamp

        const result = await runCli(['search', '--body', 'zanzibar', '--json'], {
            FRUITMAIL_TEST_UV_EXIT: '1',
            FRUITMAIL_TEST_UV_STDERR: 'offline: cannot reach mail root'
        }, true);

        expect(result.failed).toBe(true);
        expect(result.stdout + result.stderr).toContain('offline: cannot reach mail root');
        expect(result.stdout + result.stderr).not.toContain('no such table');
    });

    it('search --body auto-builds when the index is missing and fails when that build fails', async () => {
        expect(fs.existsSync(indexDb)).toBe(false);

        const result = await runCli(['search', '--body', 'zanzibar', '--json'], { FRUITMAIL_TEST_UV_EXIT: '1' }, true);

        expect(uvInvocations()).toContain('cocoindex update');
        expect(result.failed).toBe(true);
    });

    it('package.json gains test:py/test:all scripts while runtime dependencies stay unchanged', () => {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

        expect(packageJson.scripts['test:py']).toBeDefined();
        expect(packageJson.scripts['test:all']).toBeDefined();
        expect(Object.keys(packageJson.dependencies).sort()).toEqual(['chalk', 'cli-table3', 'commander']);
    });
});
