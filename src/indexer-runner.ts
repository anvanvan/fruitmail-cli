/**
 * Drives the Python CocoIndex indexer (`uv run cocoindex update main.py`)
 * and owns index freshness:
 *   - `build` populates a temp index/state db and atomically swaps them in
 *     only once the rebuild has succeeded (F2): a failed rebuild (uv
 *     missing/offline/erroring) leaves the previous index fully intact
 *     instead of zeroing out body-search capability, and readers of
 *     index.db never observe it missing — only briefly the pre- or
 *     post-swap one, at the single `fs.renameSync` instant;
 *   - `refresh` runs in place against the existing dbs (incremental catch-up);
 *   - an absent/NULL `indexed_at` stamp is treated as stale (F2), so an
 *     interrupted build converges and re-stamps on the next refresh.
 *
 * On success, any non-empty stderr (e.g., "discovered N files but indexed 0",
 * or per-file skip diagnostics) is still reported to the user via
 * console.warn, instead of being silently discarded.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { SQLiteDatabase } from './sqlite';
import { indexDbPath, stateDbPath, indexerDir, indexerEnv } from './index-paths';

export const STALE_HOURS = 24;

export type IndexerMode = 'build' | 'refresh';

export interface IndexStatus {
    path: string;
    exists: boolean;
    emails: number;
    indexedAt: string | null;
    ageHours: number | null;
    stale: boolean;
    mode: number | null;
}

/**
 * Recursively chmod every directory under `root` (inclusive) to 0700, so a
 * subsequent recursive rm can actually traverse and delete it. Self-heals a
 * directory an older/poisoned build secured to a non-traversable mode (e.g.
 * secure_perms() used to chmod the LMDB state dir to 0600, which drops the
 * executable/search bit — not even the owner can list/stat/recurse into it,
 * which broke `fs.rmSync({recursive: true})` on it). Best-effort throughout:
 * a per-entry failure here isn't fatal — the caller's rm retry is what
 * actually needs to succeed.
 */
function makeTreeTraversable(root: string): void {
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(root);
    } catch {
        return;
    }
    if (!stats.isDirectory()) return;
    try {
        fs.chmodSync(root, 0o700);
    } catch {
        // best-effort; the rm retry below surfaces any real problem
    }
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(root);
    } catch {
        return;
    }
    for (const entry of entries) {
        makeTreeTraversable(path.join(root, entry));
    }
}

function unlinkIfExists(filePath: string): void {
    // The state store is an LMDB directory, not a plain file — unlinkSync
    // throws EPERM on macOS for directories, so this must recurse. A stray
    // non-traversable directory (see makeTreeTraversable) can make even a
    // recursive rm fail because it can't be listed; self-heal by chmod'ing
    // the tree traversable and retrying once before giving up.
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
    } catch {
        makeTreeTraversable(filePath);
        fs.rmSync(filePath, { recursive: true, force: true });
    }
}

/**
 * Best-effort removal for cleanup that must never abort the build: retries
 * via unlinkIfExists (which already self-heals once), but if it STILL
 * fails, warns on stderr and moves on instead of throwing — the next
 * build's sweepStrayTempSiblings gets another chance at the leftover.
 */
function unlinkBestEffort(filePath: string, context: string): void {
    try {
        unlinkIfExists(filePath);
    } catch (error) {
        console.warn(chalk.yellow(`[indexer] could not remove ${context} ${filePath}: ${(error as Error).message}`));
    }
}

/** A same-directory temp path for `realPath` (so the final rename is atomic). */
function tempSiblingPath(realPath: string): string {
    const dir = path.dirname(realPath);
    const base = path.basename(realPath);
    return path.join(dir, `.${base}.build-${crypto.randomBytes(6).toString('hex')}.tmp`);
}

/**
 * Remove any stray `.{base}.build-*.tmp` siblings of `realPath` left behind
 * by a prior aborted/killed build (before it reached its own cleanup, or a
 * hard-kill mid-swap). Safe to call unconditionally before every build; a
 * leftover that can't be removed (e.g. still non-traversable) is warned
 * about, never left to abort the whole build attempt before it even starts.
 */
function sweepStrayTempSiblings(realPath: string): void {
    const dir = path.dirname(realPath);
    const base = path.basename(realPath);
    const prefix = `.${base}.build-`;
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return; // parent dir doesn't exist yet — nothing to sweep
    }
    for (const entry of entries) {
        if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
            unlinkBestEffort(path.join(dir, entry), 'stray build leftover');
        }
    }
}

/**
 * Atomically replace `realPath` (a file OR a directory, e.g. an LMDB state
 * store; may not exist yet) with `tempPath`'s contents.
 *
 * The existing real path is renamed ASIDE first rather than deleted in
 * place, so the swap-in rename always targets a path that does not exist:
 * POSIX rename refuses to replace a non-empty directory, so a prior
 * delete-then-rename could lose that race if the recursive delete hadn't
 * (or hadn't fully) cleared the destination — this is what caused the 2nd
 * and 3rd `index build` to crash with ENOTEMPTY against the LMDB state
 * store. The aside copy is only removed after the swap-in succeeds; if the
 * swap-in itself throws, the aside copy is restored so the previously
 * working index/state is never lost.
 */
function swapIntoPlace(tempPath: string, realPath: string): void {
    const asidePath = tempSiblingPath(realPath);
    const hadExisting = fs.existsSync(realPath);
    if (hadExisting) {
        fs.renameSync(realPath, asidePath);
    }
    try {
        fs.renameSync(tempPath, realPath);
    } catch (error) {
        if (hadExisting) {
            fs.renameSync(asidePath, realPath); // restore: never lose the previous working db/state
        }
        throw error;
    }
    if (hadExisting) {
        // The swap-in already succeeded — the new index/state is live. A
        // failure removing the now-superseded aside copy must not fail the
        // build; warn and leave it for the next build's sweep. (This is
        // exactly what secure_perms() chmod'ing the LMDB state dir to 0600
        // used to do: crash the build here, AFTER a successful swap, and
        // leave a permanently stray non-traversable dir that every later
        // build's sweep tripped over identically.)
        unlinkBestEffort(asidePath, 'superseded');
    }
}

function spawnIndexer(env: Record<string, string>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn('uv', ['run', 'cocoindex', 'update', 'main.py'], {
            cwd: indexerDir(),
            env: { ...process.env, ...env },
            // stdout is never read; ignoring it (rather than piping and
            // leaving it undrained) avoids the child blocking on write()
            // once its progress output exceeds the pipe buffer.
            stdio: ['ignore', 'ignore', 'pipe']
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                reject(new Error('uv not found — install uv to enable body-search indexing: https://docs.astral.sh/uv'));
            } else {
                reject(error);
            }
        });

        child.on('close', (code) => {
            if (code === 0) {
                if (stderr.trim()) {
                    console.warn(chalk.yellow(`[indexer] ${stderr.trim()}`));
                }
                resolve();
            } else {
                reject(new Error(stderr.trim() || `indexer exited with code ${code}`));
            }
        });
    });
}

export async function runIndexer(mode: IndexerMode): Promise<void> {
    if (mode === 'refresh') {
        await spawnIndexer(indexerEnv());
        return;
    }

    const realIndexDb = indexDbPath();
    const realStateDb = stateDbPath();
    // Clear out any leftovers from a prior aborted build before generating
    // this run's temp paths.
    sweepStrayTempSiblings(realIndexDb);
    sweepStrayTempSiblings(realStateDb);
    const tempIndexDb = tempSiblingPath(realIndexDb);
    const tempStateDb = tempSiblingPath(realStateDb);

    try {
        await spawnIndexer({ ...indexerEnv(), FRUITMAIL_INDEX_DB: tempIndexDb, FRUITMAIL_STATE_DB: tempStateDb });
    } catch (error) {
        // Best-effort: a cleanup problem here must not mask the real spawn
        // failure being re-thrown below; the next build's sweep gets
        // another chance at any leftover.
        unlinkBestEffort(tempIndexDb, 'failed-build temp');
        unlinkBestEffort(tempStateDb, 'failed-build temp');
        throw error;
    }

    // Same-filesystem rename over an existing file is an atomic replace on
    // POSIX, so index.db readers see either the old or the new file, never
    // a missing one. swapIntoPlace handles the directory-shaped state store
    // (LMDB) the same way, without racing a delete against the swap-in.
    swapIntoPlace(tempIndexDb, realIndexDb);
    swapIntoPlace(tempStateDb, realStateDb);
}

export function getIndexStatus(): IndexStatus {
    const dbFile = indexDbPath();
    if (!fs.existsSync(dbFile)) {
        return { path: dbFile, exists: false, emails: 0, indexedAt: null, ageHours: null, stale: true, mode: null };
    }

    const mode = fs.statSync(dbFile).mode & 0o777;
    let emails = 0;
    let indexedAt: string | null = null;

    const db = new SQLiteDatabase(dbFile, { readonly: true, fileMustExist: true });
    try {
        try {
            const countRow = db.prepare('SELECT COUNT(*) AS c FROM emails').get() as { c: number } | undefined;
            emails = countRow ? Number(countRow.c) : 0;
            const stampRow = db.prepare("SELECT value FROM fruitmail_meta WHERE key = 'indexed_at'").get() as
                | { value: string | null }
                | undefined;
            indexedAt = stampRow?.value ?? null;
        } catch {
            // index.db exists but is schemaless/partial (build killed between
            // sqlite.connect and table creation): treat as needing a rebuild
            // instead of surfacing "no such table" to the caller.
            return { path: dbFile, exists: true, emails: 0, indexedAt: null, ageHours: null, stale: true, mode };
        }
    } finally {
        db.close();
    }

    let ageHours: number | null = null;
    if (indexedAt !== null) {
        const parsed = Date.parse(indexedAt);
        if (Number.isFinite(parsed)) {
            ageHours = (Date.now() - parsed) / 3_600_000;
        }
    }

    // Absent/NULL stamp (build interrupted pre-stamp) => stale (F2).
    const stale = indexedAt === null || ageHours === null || ageHours > STALE_HOURS;
    return { path: dbFile, exists: true, emails, indexedAt, ageHours, stale, mode };
}

export async function ensureIndexFresh(): Promise<void> {
    const status = getIndexStatus();
    if (!status.exists) {
        await runIndexer('build');
        return;
    }
    if (status.stale) {
        await runIndexer('refresh');
    }
}
