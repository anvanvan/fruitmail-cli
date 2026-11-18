"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fruitmailHome = fruitmailHome;
exports.indexDbPath = indexDbPath;
exports.stateDbPath = stateDbPath;
exports.mailRoot = mailRoot;
exports.indexerDir = indexerDir;
exports.indexerEnv = indexerEnv;
/**
 * Path resolution for the body full-text-search index (F8).
 *
 * The TS CLI is the single authority for the mail root: `indexerEnv()` always
 * injects the resolved FRUITMAIL_MAIL_ROOT (+ index/state db paths) into the
 * Python indexer child environment, so the Python-side scan is only a
 * standalone fallback.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const mail_version_1 = require("./mail-version");
function fruitmailHome() {
    return node_path_1.default.join(node_os_1.default.homedir(), '.fruitmail');
}
function indexDbPath() {
    return process.env.FRUITMAIL_INDEX_DB || node_path_1.default.join(fruitmailHome(), 'index.db');
}
function stateDbPath() {
    return process.env.FRUITMAIL_STATE_DB || node_path_1.default.join(fruitmailHome(), 'cocoindex-state.db');
}
/**
 * Highest `~/Library/Mail/V<N>` directory chosen by NUMERIC N (V10 beats V9,
 * F8); returns undefined if `mailDir` doesn't exist or has no `V<N>` dirs.
 */
function findHighestVersionDir(mailDir) {
    let entries = [];
    try {
        entries = node_fs_1.default.readdirSync(mailDir);
    }
    catch {
        return undefined;
    }
    const directories = entries.filter((name) => {
        try {
            return node_fs_1.default.statSync(node_path_1.default.join(mailDir, name)).isDirectory();
        }
        catch {
            return false;
        }
    });
    return (0, mail_version_1.sortMailVersionNames)(directories)[0];
}
/**
 * Highest `~/Library/Mail/V<N>` chosen by NUMERIC N (V10 beats V9, F8);
 * the FRUITMAIL_MAIL_ROOT env override always wins.
 */
function mailRoot() {
    const override = process.env.FRUITMAIL_MAIL_ROOT;
    if (override)
        return override;
    const mailDir = node_path_1.default.join(node_os_1.default.homedir(), 'Library', 'Mail');
    const bestName = findHighestVersionDir(mailDir);
    if (!bestName) {
        throw new Error(`No Apple Mail data found under ${mailDir} — set FRUITMAIL_MAIL_ROOT to override`);
    }
    return node_path_1.default.join(mailDir, bestName);
}
/** The Python indexer directory shipped next to the compiled dist. */
function indexerDir() {
    return node_path_1.default.resolve(__dirname, '..', 'indexer');
}
/**
 * Env for the indexer child process: ALWAYS carries the resolved
 * FRUITMAIL_MAIL_ROOT, FRUITMAIL_INDEX_DB and FRUITMAIL_STATE_DB (F8).
 */
function indexerEnv() {
    return {
        FRUITMAIL_MAIL_ROOT: mailRoot(),
        FRUITMAIL_INDEX_DB: indexDbPath(),
        FRUITMAIL_STATE_DB: stateDbPath(),
        // `uv run` with cwd=indexerDir() otherwise creates .venv inside the
        // shipped indexer/ package tree, which EACCESs under a read-only
        // global install prefix (F42). Point it at a writable per-user
        // location instead; an explicit env override still wins.
        UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT || node_path_1.default.join(fruitmailHome(), 'venv')
    };
}
