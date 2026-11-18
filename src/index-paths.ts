/**
 * Path resolution for the body full-text-search index (F8).
 *
 * The TS CLI is the single authority for the mail root: `indexerEnv()` always
 * injects the resolved FRUITMAIL_MAIL_ROOT (+ index/state db paths) into the
 * Python indexer child environment, so the Python-side scan is only a
 * standalone fallback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sortMailVersionNames } from './mail-version';

export function fruitmailHome(): string {
    return path.join(os.homedir(), '.fruitmail');
}

export function indexDbPath(): string {
    return process.env.FRUITMAIL_INDEX_DB || path.join(fruitmailHome(), 'index.db');
}

export function stateDbPath(): string {
    return process.env.FRUITMAIL_STATE_DB || path.join(fruitmailHome(), 'cocoindex-state.db');
}

/**
 * Highest `~/Library/Mail/V<N>` directory chosen by NUMERIC N (V10 beats V9,
 * F8); returns undefined if `mailDir` doesn't exist or has no `V<N>` dirs.
 */
function findHighestVersionDir(mailDir: string): string | undefined {
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(mailDir);
    } catch {
        return undefined;
    }

    const directories = entries.filter((name) => {
        try {
            return fs.statSync(path.join(mailDir, name)).isDirectory();
        } catch {
            return false;
        }
    });
    return sortMailVersionNames(directories)[0];
}

/**
 * Highest `~/Library/Mail/V<N>` chosen by NUMERIC N (V10 beats V9, F8);
 * the FRUITMAIL_MAIL_ROOT env override always wins.
 */
export function mailRoot(): string {
    const override = process.env.FRUITMAIL_MAIL_ROOT;
    if (override) return override;

    const mailDir = path.join(os.homedir(), 'Library', 'Mail');
    const bestName = findHighestVersionDir(mailDir);
    if (!bestName) {
        throw new Error(`No Apple Mail data found under ${mailDir} — set FRUITMAIL_MAIL_ROOT to override`);
    }
    return path.join(mailDir, bestName);
}

/** The Python indexer directory shipped next to the compiled dist. */
export function indexerDir(): string {
    return path.resolve(__dirname, '..', 'indexer');
}

/**
 * Env for the indexer child process: ALWAYS carries the resolved
 * FRUITMAIL_MAIL_ROOT, FRUITMAIL_INDEX_DB and FRUITMAIL_STATE_DB (F8).
 */
export function indexerEnv(): Record<string, string> {
    return {
        FRUITMAIL_MAIL_ROOT: mailRoot(),
        FRUITMAIL_INDEX_DB: indexDbPath(),
        FRUITMAIL_STATE_DB: stateDbPath(),
        // `uv run` with cwd=indexerDir() otherwise creates .venv inside the
        // shipped indexer/ package tree, which EACCESs under a read-only
        // global install prefix (F42). Point it at a writable per-user
        // location instead; an explicit env override still wins.
        UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT || path.join(fruitmailHome(), 'venv')
    };
}
