#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const cli_table3_1 = __importDefault(require("cli-table3"));
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const db_finder_js_1 = require("./db-finder.js");
const mail_actions_js_1 = require("./mail-actions.js");
const sqlite_js_1 = require("./sqlite.js");
const body_search_js_1 = require("./body-search.js");
const index_paths_js_1 = require("./index-paths.js");
const indexer_runner_js_1 = require("./indexer-runner.js");
const time_utils_js_1 = require("./time-utils.js");
// Setup CLI
const program = new commander_1.Command();
const packageVersion = require('../package.json').version;
program
    .name('fruitmail')
    .description('Fast Apple Mail search via SQLite')
    .version(packageVersion)
    .configureHelp({ showGlobalOptions: true });
// Global Options
program
    .option('-n, --limit <number>', 'Max results', '20')
    .option('-o, --offset <number>', 'Skip first N results', '0')
    .option('-j, --json', 'Output as JSON')
    .option('-c, --csv', 'Output as CSV')
    .option('-q, --quiet', 'Minimal output')
    .option('--db <path>', 'Override database path')
    .option('--copy', 'Force copy mode (safe mode)');
function parseNonNegativeIntegerOption(value, name, defaultValue) {
    const rawValue = value ?? String(defaultValue);
    if (!/^\d+$/.test(rawValue)) {
        throw new Error(`Invalid --${name}: expected a non-negative integer`);
    }
    return Number.parseInt(rawValue, 10);
}
function parsePaginationOptions(options) {
    return {
        limit: parseNonNegativeIntegerOption(options.limit, 'limit', 20),
        offset: parseNonNegativeIntegerOption(options.offset, 'offset', 0)
    };
}
function getErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    return 'Unknown error';
}
function handleCommandError(error, options) {
    const message = getErrorMessage(error);
    if (options?.json) {
        console.log(JSON.stringify({ error: message }));
    }
    else {
        console.error(chalk_1.default.red(message));
    }
    process.exit(1);
}
function getCommandOptions(options, command) {
    return (command?.optsWithGlobals ? command.optsWithGlobals() : options);
}
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
function getTableColumns(db, tableName) {
    try {
        const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
        return rows.map((row) => row.name);
    }
    catch {
        return [];
    }
}
function findColumnByAlias(columns, aliases) {
    const columnByLower = new Map(columns.map((column) => [column.toLowerCase(), column]));
    for (const alias of aliases) {
        const match = columnByLower.get(alias.toLowerCase());
        if (match)
            return match;
    }
    return undefined;
}
function asNonEmptyString(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function asPositiveInteger(value) {
    const candidate = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(candidate) || candidate <= 0)
        return undefined;
    return candidate;
}
function buildMessageLookupContext(db, rowId) {
    if (!/^\d+$/.test(rowId)) {
        throw new Error('Invalid message ID');
    }
    const messageColumns = getTableColumns(db, 'messages');
    const selectedColumns = ['m.ROWID as _fruitmail_rowid'];
    const selectedAliases = [];
    const joins = [
        'LEFT JOIN subjects s ON m.subject = s.ROWID',
        'LEFT JOIN addresses a ON m.sender = a.ROWID'
    ];
    const textIdColumns = ['document_id', 'message_id', 'internet_message_id', 'remote_id', 'external_id'];
    for (const column of textIdColumns) {
        if (messageColumns.includes(column)) {
            const alias = `_fruitmail_${column}`;
            selectedColumns.push(`m.${quoteIdentifier(column)} as ${quoteIdentifier(alias)}`);
            selectedAliases.push({ column, alias });
        }
    }
    const numericIdColumns = ['id', 'message_id', 'mail_id', 'mailbox_message_id', 'remote_id'];
    for (const column of numericIdColumns) {
        if (!messageColumns.includes(column))
            continue;
        if (selectedAliases.some((entry) => entry.column === column))
            continue;
        const alias = `_fruitmail_${column}`;
        selectedColumns.push(`m.${quoteIdentifier(column)} as ${quoteIdentifier(alias)}`);
        selectedAliases.push({ column, alias });
    }
    const mailboxHintsAliases = [];
    const mailboxColumnInMessages = findColumnByAlias(messageColumns, ['mailbox']);
    const mailboxTableColumns = getTableColumns(db, 'mailboxes');
    if (mailboxColumnInMessages) {
        const mailboxAlias = '_fruitmail_mailbox_raw';
        selectedColumns.push(`m.${quoteIdentifier(mailboxColumnInMessages)} as ${quoteIdentifier(mailboxAlias)}`);
        mailboxHintsAliases.push(mailboxAlias);
        if (mailboxTableColumns.length > 0) {
            joins.push(`LEFT JOIN mailboxes mb ON m.${quoteIdentifier(mailboxColumnInMessages)} = mb.ROWID`);
            const mailboxHintColumns = ['display_name', 'name', 'path', 'url'];
            for (const column of mailboxHintColumns) {
                if (!mailboxTableColumns.includes(column))
                    continue;
                const alias = `_fruitmail_mailbox_${column}`;
                selectedColumns.push(`mb.${quoteIdentifier(column)} as ${quoteIdentifier(alias)}`);
                mailboxHintsAliases.push(alias);
            }
        }
    }
    const sql = `
      SELECT
        ${selectedColumns.join(', ')},
        s.subject as _fruitmail_subject,
        a.address as _fruitmail_sender
      FROM messages m
      ${joins.join('\n      ')}
      WHERE m.ROWID = ?
    `;
    const row = db.prepare(sql).get(rowId);
    if (!row)
        return undefined;
    const numericIdCandidates = new Set();
    const rowIdNumber = asPositiveInteger(row._fruitmail_rowid);
    if (rowIdNumber)
        numericIdCandidates.add(rowIdNumber);
    for (const { column, alias } of selectedAliases) {
        if (!['id', 'message_id', 'mail_id', 'mailbox_message_id'].includes(column))
            continue;
        const numericValue = asPositiveInteger(row[alias]);
        if (numericValue)
            numericIdCandidates.add(numericValue);
    }
    const messageIdCandidates = new Set();
    for (const { column, alias } of selectedAliases) {
        if (!['document_id', 'message_id', 'internet_message_id', 'remote_id', 'external_id'].includes(column))
            continue;
        const textValue = asNonEmptyString(row[alias]);
        if (textValue)
            messageIdCandidates.add(textValue.replace(/^<|>$/g, ''));
    }
    const mailboxHints = new Set();
    for (const alias of mailboxHintsAliases) {
        const hint = asNonEmptyString(row[alias]);
        if (hint)
            mailboxHints.add(hint);
    }
    return {
        numericIdCandidates: Array.from(numericIdCandidates),
        messageIdCandidates: Array.from(messageIdCandidates),
        mailboxHints: Array.from(mailboxHints),
        subject: asNonEmptyString(row._fruitmail_subject),
        sender: asNonEmptyString(row._fruitmail_sender)
    };
}
// Database Connection Helper
async function getDb(options) {
    let dbPath = options.db;
    if (!dbPath) {
        dbPath = await (0, db_finder_js_1.findDbPath)();
    }
    let dbFile = dbPath;
    let cleanUp;
    // Copy Mode (safe mode)
    if (options.copy) {
        const tempDir = node_os_1.default.tmpdir();
        const tempFile = node_path_1.default.join(tempDir, `fruitmail.${Date.now()}.db`);
        // Synchronous copy is fine for startup
        (0, node_fs_1.copyFileSync)(dbPath, tempFile);
        dbFile = tempFile;
        cleanUp = () => {
            try {
                (0, node_fs_1.unlinkSync)(tempFile);
            }
            catch { }
        };
    }
    // Open DB
    const db = new sqlite_js_1.SQLiteDatabase(dbFile, {
        readonly: !options.copy, // Read-only unless we are working on a copy
        fileMustExist: true,
        timeout: 2000 // Busy timeout handled natively
    });
    return { db, cleanUp };
}
function sanitizeCell(value) {
    // Strip C0/C1 control chars (incl. ESC) before whitespace collapse so
    // indexed mail can't inject terminal escape sequences into table output.
    // eslint-disable-next-line no-control-regex
    return String(value ?? '')
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function computeColumnWidths(headers, desiredWidths, terminalWidth) {
    const minWidths = headers.map((header) => {
        const headerLower = header.toLowerCase();
        if (headerLower === 'id')
            return 4;
        if (headerLower === 'date')
            return 16;
        return Math.min(12, Math.max(6, header.length));
    });
    const maxTotalContent = Math.max(10, terminalWidth - (headers.length * 3 + 1));
    const widths = [...minWidths];
    const minTotal = minWidths.reduce((sum, width) => sum + width, 0);
    if (minTotal > maxTotalContent) {
        return headers.map(() => Math.max(1, Math.floor(maxTotalContent / headers.length)));
    }
    let remaining = maxTotalContent - minTotal;
    while (remaining > 0) {
        let grew = false;
        for (let i = 0; i < widths.length && remaining > 0; i += 1) {
            if (widths[i] < desiredWidths[i]) {
                widths[i] += 1;
                remaining -= 1;
                grew = true;
            }
        }
        if (!grew)
            break;
    }
    return widths;
}
function toTitleCase(value) {
    return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}
function friendlyMailboxName(value) {
    const raw = sanitizeCell(value);
    if (!raw)
        return raw;
    let normalized = raw;
    try {
        normalized = decodeURIComponent(normalized);
    }
    catch {
        // Keep raw string if URL decoding fails.
    }
    normalized = normalized.replace(/^[a-z]+:\/\//i, '');
    const segments = normalized.split('/').map((segment) => segment.trim()).filter(Boolean);
    let candidate = segments.length > 0 ? segments[segments.length - 1] : normalized;
    if (candidate.includes(':')) {
        candidate = candidate.split(':').pop() ?? candidate;
    }
    candidate = candidate.replace(/[._-]+/g, ' ').trim();
    const canonical = candidate.toLowerCase();
    if (canonical === 'inbox')
        return 'Inbox';
    if (canonical === 'sent' || canonical === 'sent messages')
        return 'Sent';
    if (canonical === 'drafts')
        return 'Drafts';
    if (canonical === 'deleted messages' || canonical === 'trash')
        return 'Trash';
    if (canonical === 'junk' || canonical === 'junk mail' || canonical === 'spam')
        return 'Junk';
    if (canonical === 'archive' || canonical === 'archives')
        return 'Archive';
    return toTitleCase(candidate);
}
// Output Helper
function outputResults(rows, options) {
    if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
    }
    if (options.csv) {
        if (rows.length === 0)
            return;
        const headers = Object.keys(rows[0]);
        console.log(headers.join(','));
        for (const row of rows) {
            console.log(Object.values(row).map(v => JSON.stringify(v)).join(','));
        }
        return;
    }
    if (rows.length === 0) {
        if (!options.quiet)
            console.log(chalk_1.default.gray('No results found.'));
        return;
    }
    const headers = Object.keys(rows[0]);
    const sanitizedRows = rows.map((row) => headers.map((header) => sanitizeCell(row[header])));
    const desiredWidths = headers.map((header, index) => {
        let maxWidth = header.length;
        for (const rowValues of sanitizedRows) {
            maxWidth = Math.max(maxWidth, rowValues[index].length);
        }
        return maxWidth;
    });
    const terminalWidth = process.stdout.columns ?? 120;
    const contentWidths = computeColumnWidths(headers, desiredWidths, terminalWidth);
    const colWidths = contentWidths.map((width) => width + 2); // +2 for left/right cell padding
    const table = new cli_table3_1.default({
        head: headers.map((header) => chalk_1.default.bold(header)),
        colWidths,
        wordWrap: false,
        style: { head: ['cyan'], compact: false }
    });
    for (const rowValues of sanitizedRows) {
        table.push(rowValues);
    }
    console.log(table.toString());
}
// Unified Search Builder
async function runSearch(filters, options) {
    const pagination = parsePaginationOptions(options);
    const { db, cleanUp } = await getDb(options);
    try {
        const conditions = ['1=1'];
        const params = [];
        const joins = [
            'LEFT JOIN subjects s ON m.subject = s.rowid',
            'LEFT JOIN addresses a ON m.sender = a.rowid'
        ];
        let mailboxSelect = '';
        const messageColumns = getTableColumns(db, 'messages');
        const mailboxColumnInMessages = findColumnByAlias(messageColumns, ['mailbox']);
        const mailboxColumns = getTableColumns(db, 'mailboxes');
        if (mailboxColumnInMessages) {
            const quotedMailboxColumn = quoteIdentifier(mailboxColumnInMessages);
            const mailboxLabelColumn = mailboxColumns.length > 0
                ? findColumnByAlias(mailboxColumns, ['display_name', 'name', 'path', 'url'])
                : undefined;
            if (mailboxColumns.length > 0) {
                joins.push(`LEFT JOIN mailboxes mb ON m.${quotedMailboxColumn} = mb.ROWID`);
            }
            mailboxSelect = mailboxLabelColumn
                ? `,\n        COALESCE(mb.${quoteIdentifier(mailboxLabelColumn)}, CAST(m.${quotedMailboxColumn} AS TEXT)) as mailbox`
                : `,\n        CAST(m.${quotedMailboxColumn} AS TEXT) as mailbox`;
        }
        // --subject
        if (filters.subject) {
            conditions.push('s.subject LIKE ?');
            params.push(`%${filters.subject}%`);
        }
        // --sender
        if (filters.sender) {
            conditions.push('a.address LIKE ?');
            params.push(`%${filters.sender}%`);
        }
        // --from-name
        if (filters.fromName) {
            conditions.push('a.comment LIKE ?');
            params.push(`%${filters.fromName}%`);
        }
        // --to
        if (filters.to) {
            joins.push('JOIN recipients r ON m.ROWID = r.message');
            joins.push('JOIN addresses ra ON r.address = ra.ROWID');
            conditions.push('ra.address LIKE ?');
            params.push(`%${filters.to}%`);
        }
        // --unread / --read
        if (filters.unread)
            conditions.push('m.read = 0');
        if (filters.read)
            conditions.push('m.read = 1');
        // --days
        if (filters.days) {
            const seconds = (0, time_utils_js_1.epochSecondsAgoFromNow)(filters.days);
            conditions.push('m.date_sent >= ?');
            params.push(seconds);
        }
        // --has-attachment / --attachment-type
        if (filters.hasAttachment || filters.attachmentType) {
            joins.push('JOIN attachments att ON m.ROWID = att.message');
        }
        if (filters.attachmentType) {
            conditions.push('att.name LIKE ?');
            params.push(`%.${filters.attachmentType}`);
        }
        // Explicit deleted check
        conditions.push('m.deleted = 0');
        const sql = `
      SELECT DISTINCT 
        m.ROWID as id,
        datetime(m.date_sent, 'unixepoch', 'localtime') as date,
        a.address as sender,
        s.subject${mailboxSelect}
      FROM messages m
      ${[...new Set(joins)].join(' ')}
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.date_sent DESC
      LIMIT ?
      OFFSET ?
    `;
        params.push(pagination.limit, pagination.offset);
        // Synchronous execution
        const rows = db.prepare(sql).all(params);
        const normalizedRows = rows.map((row) => {
            if (!Object.prototype.hasOwnProperty.call(row, 'mailbox'))
                return row;
            return { ...row, mailbox: friendlyMailboxName(row.mailbox) };
        });
        outputResults(normalizedRows, options);
    }
    finally {
        db.close();
        if (cleanUp)
            cleanUp();
    }
}
// Body Full-Text Search (bm25 over ~/.fruitmail/index.db)
async function runBodySearch(filters, options) {
    const pagination = parsePaginationOptions(options);
    // Auto-index: missing index => build; stale/stamp-less => refresh.
    await (0, indexer_runner_js_1.ensureIndexFresh)();
    const db = new sqlite_js_1.SQLiteDatabase((0, index_paths_js_1.indexDbPath)(), {
        readonly: true,
        fileMustExist: true,
        timeout: 2000
    });
    try {
        const rows = (0, body_search_js_1.searchBody)(db, filters.body, filters, pagination);
        outputResults(rows, options);
    }
    finally {
        db.close();
    }
}
// --- Commands ---
program.command('search')
    .description('Unified advanced search')
    .option('--subject <text>', 'Search by subject')
    .option('--sender <text>', 'Search by sender email')
    .option('--from-name <text>', 'Search by sender name')
    .option('--to <text>', 'Search by recipient')
    .option('--unread', 'Only unread emails')
    .option('--read', 'Only read emails')
    .option('--days <number>', 'Days lookback', '7')
    .option('--has-attachment', 'Only emails with attachments')
    .option('--attachment-type <ext>', 'Filter by attachment extension (e.g. pdf)')
    .option('--body <query>', 'Full-text search email bodies via the local index (unread/read/attachment filters are ignored in body mode)')
    .option('--account <name>', 'Body mode: filter by account identifier')
    .option('--mailbox <name>', 'Body mode: filter by mailbox name (case-insensitive)')
    .action(async (opts, cmd) => {
    const commandOptions = cmd.optsWithGlobals();
    try {
        if (opts.body !== undefined) {
            const bodyQuery = typeof opts.body === 'string' ? opts.body.trim() : '';
            if (!bodyQuery) {
                throw new Error('--body requires a non-empty search query');
            }
            // Body mode must NOT inherit the metadata verb's 7-day default:
            // apply the --days cutoff only when the flag is explicitly given
            // (full-index search otherwise). Explicit --days keeps the F6
            // parity semantics (same epoch cutoff on date_sent as runSearch).
            const bodyFilters = cmd.getOptionValueSource('days') === 'default'
                ? { ...opts, body: bodyQuery, days: undefined }
                : { ...opts, body: bodyQuery };
            await runBodySearch(bodyFilters, commandOptions);
        }
        else {
            if (opts.account !== undefined || opts.mailbox !== undefined) {
                throw new Error('--account/--mailbox require --body');
            }
            await runSearch(opts, commandOptions);
        }
    }
    catch (error) {
        handleCommandError(error, commandOptions);
    }
});
// Index management (body full-text search index)
const indexCommand = program.command('index')
    .description('Manage the body full-text search index (~/.fruitmail/index.db)');
function addIndexCommand(name, description, mode, successMessage) {
    indexCommand.command(name)
        .description(description)
        .action(async (options, command) => {
        const opts = getCommandOptions(options, command);
        try {
            await (0, indexer_runner_js_1.runIndexer)(mode);
            if (opts.json) {
                console.log(JSON.stringify((0, indexer_runner_js_1.getIndexStatus)(), null, 2));
            }
            else if (!opts.quiet) {
                console.log(chalk_1.default.green(successMessage));
            }
        }
        catch (error) {
            handleCommandError(error, opts);
        }
    });
}
addIndexCommand('build', 'Delete and rebuild the body search index from scratch', 'build', 'Index built.');
addIndexCommand('refresh', 'Incrementally update the body search index', 'refresh', 'Index refreshed.');
indexCommand.command('status')
    .description('Show body search index status')
    .action(async (options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        const status = (0, indexer_runner_js_1.getIndexStatus)();
        if (opts.json) {
            console.log(JSON.stringify(status, null, 2));
            return;
        }
        console.log(chalk_1.default.bold('=== Body Search Index ==='));
        console.log(`Path:       ${status.path}`);
        console.log(`Exists:     ${status.exists ? chalk_1.default.green('yes') : chalk_1.default.red('no')}`);
        if (status.exists) {
            console.log(`Emails:     ${chalk_1.default.green(status.emails)}`);
            console.log(`Indexed at: ${status.indexedAt ?? chalk_1.default.yellow('never (no stamp)')}`);
            console.log(`Age:        ${status.ageHours === null ? 'unknown' : `${status.ageHours.toFixed(1)}h`}`);
            console.log(`Stale:      ${status.stale ? chalk_1.default.yellow('yes') : chalk_1.default.green('no')}`);
            console.log(`Mode:       ${status.mode === null ? 'unknown' : status.mode.toString(8).padStart(3, '0')}`);
        }
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
// Shortcuts
program.command('subject <pattern>').action(async (p, options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        await runSearch({ subject: p }, opts);
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
program.command('sender <pattern>').action(async (p, options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        await runSearch({ sender: p }, opts);
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
program.command('to <pattern>').action(async (p, options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        await runSearch({ to: p }, opts);
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
program.command('unread').action(async (options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        await runSearch({ unread: true }, opts);
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
// Recent
program.command('recent [days]')
    .action(async (days, options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        await runSearch({ days: days || '7' }, opts);
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
// Open
program.command('open <id>')
    .description('Open email in Mail.app')
    .action(async (id, options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        const numericId = Number.parseInt(String(id), 10);
        if (!Number.isNaN(numericId) && /^\d+$/.test(String(id))) {
            try {
                await (0, mail_actions_js_1.openEmailByLookup)({ numericIdCandidates: [numericId] });
                return;
            }
            catch (error) {
                if (getErrorMessage(error) !== 'Message not found') {
                    throw error;
                }
            }
        }
        const { db, cleanUp } = await getDb(opts);
        try {
            const lookup = buildMessageLookupContext(db, String(id));
            if (!lookup)
                throw new Error('Message not found');
            await (0, mail_actions_js_1.openEmailByLookup)(lookup);
        }
        finally {
            db.close();
            if (cleanUp)
                cleanUp();
        }
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
// Body
program.command('body <id>')
    .description('Read email body content')
    .action(async (id, options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        const numericId = Number.parseInt(String(id), 10);
        if (!Number.isNaN(numericId) && /^\d+$/.test(String(id))) {
            try {
                const content = await (0, mail_actions_js_1.getEmailBodyByLookup)({ numericIdCandidates: [numericId] });
                if (opts.json) {
                    console.log(JSON.stringify({ id, body: content }, null, 2));
                }
                else {
                    console.log(content);
                }
                return;
            }
            catch (error) {
                if (getErrorMessage(error) !== 'Message not found') {
                    throw error;
                }
            }
        }
        const { db, cleanUp } = await getDb(opts);
        try {
            const lookup = buildMessageLookupContext(db, String(id));
            if (!lookup)
                throw new Error('Message not found');
            const content = await (0, mail_actions_js_1.getEmailBodyByLookup)(lookup);
            if (opts.json) {
                console.log(JSON.stringify({ id, body: content }, null, 2));
            }
            else {
                console.log(content);
            }
        }
        finally {
            db.close();
            if (cleanUp)
                cleanUp();
        }
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
// Stats
program.command('stats')
    .description('Database statistics')
    .action(async (options, command) => {
    const opts = getCommandOptions(options, command);
    try {
        const { db, cleanUp } = await getDb(opts);
        try {
            // Synchronous
            const total = db.prepare('SELECT COUNT(*) as c FROM messages').get();
            const unread = db.prepare('SELECT COUNT(*) as c FROM messages WHERE read = 0 AND deleted = 0').get();
            const deleted = db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted = 1').get();
            const attachments = db.prepare('SELECT COUNT(DISTINCT message) as c FROM attachments').get();
            console.log(chalk_1.default.bold('=== Mail Database Statistics ==='));
            console.log(`Total messages: ${chalk_1.default.green(total.c)}`);
            console.log(`Unread:         ${chalk_1.default.yellow(unread.c)}`);
            console.log(`Deleted:        ${chalk_1.default.red(deleted.c)}`);
            console.log(`Attachments:    ${chalk_1.default.blue(attachments.c)}`);
        }
        finally {
            db.close();
            if (cleanUp)
                cleanUp();
        }
    }
    catch (error) {
        handleCommandError(error, opts);
    }
});
program.parseAsync(process.argv).catch((error) => {
    handleCommandError(error, program.opts());
});
