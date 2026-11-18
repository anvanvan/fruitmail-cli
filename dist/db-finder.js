"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findDbPath = findDbPath;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const mail_version_1 = require("./mail-version");
/**
 * Finds the Apple Mail database.
 * Logic:
 * 1. Search for ~/Library/Mail/V* folders.
 * 2. Sort by version (highest first).
 * 3. Return the first one that contains MailData/Envelope Index.
 */
async function findDbPath() {
    // Check override env var
    if (process.env.MAIL_DB) {
        return process.env.MAIL_DB;
    }
    const mailRoot = node_path_1.default.join(node_os_1.default.homedir(), 'Library/Mail');
    try {
        const entries = await promises_1.default.readdir(mailRoot, { withFileTypes: true });
        // Find V* directories, highest N first (V10 beats V9)
        const vDirs = (0, mail_version_1.sortMailVersionNames)(entries.filter(e => e.isDirectory()).map(e => e.name));
        for (const vDir of vDirs) {
            const dbPath = node_path_1.default.join(mailRoot, vDir, 'MailData', 'Envelope Index');
            try {
                await promises_1.default.access(dbPath);
                return dbPath;
            }
            catch {
                continue;
            }
        }
    }
    catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            throw new Error(`Permission denied accessing ${mailRoot}. Please grant Terminal 'Full Disk Access' in System Settings.`);
        }
    }
    // Fallback / helpful error
    throw new Error(`Could not find Mail database in ${mailRoot}. Ensure you have 'Full Disk Access' enabled.`);
}
