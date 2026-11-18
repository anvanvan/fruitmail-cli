"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeFtsQuery = sanitizeFtsQuery;
exports.escapeAllSpecial = escapeAllSpecial;
exports.searchBody = searchBody;
const time_utils_1 = require("./time-utils");
const BOOLEAN_OPERATORS = new Set(['AND', 'OR', 'NOT']);
/**
 * Make user input safe(ish) for FTS5 MATCH: keep balanced "phrases",
 * trailing prefix wildcards and AND/OR/NOT; double-quote-wrap any other
 * token carrying FTS5 special characters.
 */
function sanitizeFtsQuery(query) {
    const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
    const sanitized = [];
    for (const token of tokens) {
        if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
            sanitized.push(token); // balanced phrase, keep intact
            continue;
        }
        if (BOOLEAN_OPERATORS.has(token)) {
            sanitized.push(token);
            continue;
        }
        if (/^[^"'\-():^*\s]+\*$/.test(token)) {
            sanitized.push(token); // trailing prefix wildcard, keep
            continue;
        }
        if (/["'\-():^*]/.test(token)) {
            sanitized.push(`"${token.replace(/"/g, '')}"`);
            continue;
        }
        sanitized.push(token);
    }
    return sanitized.join(' ');
}
/** Retry path: the whole query as ONE literal phrase (inner quotes doubled). */
function escapeAllSpecial(query) {
    return `"${query.replace(/"/g, '""')}"`;
}
/** The last `/`-separated segment of a stored mailbox path (e.g. 'Q1' from 'Work/Projects/Q1'). */
function mailboxLeaf(value) {
    if (typeof value !== 'string')
        return value;
    const segments = value.split('/');
    return segments[segments.length - 1];
}
function lowerValue(value) {
    return typeof value === 'string' ? value.toLowerCase() : value;
}
/**
 * Register the JS-backed helpers `--mailbox` matching relies on: SQLite's
 * built-in LOWER() only folds ASCII, so case-insensitivity is done via JS
 * String.prototype.toLowerCase() instead (F37); mailboxLeaf lets a matched
 * displayed leaf name (e.g. 'Q1') find a nested stored path like
 * 'Work/Projects/Q1' (F31). Safe to call on a read-only connection;
 * re-registering a name simply replaces it.
 */
function registerMailboxHelpers(db) {
    db.function('fruitmail_lower', lowerValue);
    db.function('fruitmail_mailbox_leaf', mailboxLeaf);
}
function searchBody(db, query, filters, pagination) {
    const conditions = [];
    const params = [];
    if (filters.subject) {
        conditions.push('e.subject LIKE ?');
        params.push(`%${filters.subject}%`);
    }
    if (filters.sender) {
        conditions.push('e.sender LIKE ?');
        params.push(`%${filters.sender}%`);
    }
    if (filters.account) {
        conditions.push('e.account = ?');
        params.push(filters.account);
    }
    if (filters.mailbox) {
        registerMailboxHelpers(db);
        // Match either the full stored path or just its leaf segment, so a
        // displayed leaf name (e.g. 'Q1') also finds a nested mailbox
        // ('Work/Projects/Q1') without breaking exact full-path matches (F31).
        conditions.push('(fruitmail_lower(e.mailbox) = fruitmail_lower(?) OR fruitmail_lower(fruitmail_mailbox_leaf(e.mailbox)) = fruitmail_lower(?))');
        params.push(filters.mailbox, filters.mailbox);
    }
    if (filters.days !== undefined) {
        // Same epoch cutoff arithmetic/field/units as runSearch --days (F6).
        const seconds = (0, time_utils_1.epochSecondsAgoFromNow)(filters.days);
        conditions.push('e.date_sent >= ?');
        params.push(seconds);
    }
    const extraWhere = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT
        e.message_id AS id,
        datetime(e.date_sent, 'unixepoch', 'localtime') AS date,
        e.sender,
        e.subject,
        e.mailbox,
        snippet(emails_fts, 2, '', '', '…', 12) AS snippet,
        -bm25(emails_fts, 1.0, 0.5, 2.0) AS score
      FROM emails_fts
      JOIN emails e ON emails_fts.rowid = e.rowid
      WHERE emails_fts MATCH ?${extraWhere}
      ORDER BY score DESC
      LIMIT ?
      OFFSET ?
    `;
    const run = (match) => db.prepare(sql).all([match, ...params, pagination.limit, pagination.offset]);
    try {
        return run(sanitizeFtsQuery(query));
    }
    catch (error) {
        if (!/fts5/i.test(error instanceof Error ? error.message : String(error)))
            throw error;
        try {
            return run(escapeAllSpecial(query));
        }
        catch (retryError) {
            // Only an fts5 syntax error is expected here — SQLITE_BUSY, I/O
            // errors, and corruption must still surface, not become a
            // silent "no matches".
            if (!/fts5/i.test(retryError instanceof Error ? retryError.message : String(retryError)))
                throw retryError;
            return [];
        }
    }
}
