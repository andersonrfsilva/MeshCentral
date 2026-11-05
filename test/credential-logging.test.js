'use strict';

// Secrets must not reach debug/console/server-warning sinks, while the real values still reach
// authentication and the backup subprocess. Sentinels are synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child_process = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createDbParent } = require('./helpers/fake-parent.js');

const root = path.join(__dirname, '..');
const common = require('../common.js');
const SENTINEL = 'S3NT1NEL-pw';
const restores = [];
const tmpDirs = [];

test.afterEach(function () {
    while (restores.length) { restores.pop()(); }
    while (tmpDirs.length) { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); }
});

function patch(target, key, value) {
    const original = target[key];
    target[key] = value;
    restores.push(function () { target[key] = original; });
}

function serialize(x) { return JSON.stringify(x, function (k, v) { return (v instanceof Error) ? { message: v.message, stack: v.stack } : v; }); }

// ---------------------------------------------------------------------------------------------
// Intel AMT relay interceptors (webserver.js)
// ---------------------------------------------------------------------------------------------

// The interceptor setup sits deep inside the relay websocket handler. Execute that exact source block with fakes.
function interceptorBlock() {
    const src = fs.readFileSync(path.join(root, 'webserver.js'), 'utf8');
    const start = src.indexOf('// Fetch Intel AMT credentials & Setup interceptor\n');
    const end = src.indexOf('} else if ((conn & 4) != 0)', start);
    assert.ok((start > 0) && (end > start), 'interceptor block located');
    return src.substring(start, end) + '}'; // Restore the closing brace of the else-if chain.
}

for (const mode of [1, 2]) {
    test('webrelay interceptor mode ' + mode + ': password is redacted in debug but forwarded to the interceptor', function () {
        const debugCalls = [], created = [];
        const parent = { debug: function () { debugCalls.push(Array.from(arguments)); } };
        const obj = {
            interceptor: {
                CreateHttpInterceptor: function (a) { created.push({ kind: 'http', args: a }); return {}; },
                CreateRedirInterceptor: function (a) { created.push({ kind: 'redir', args: a }); return {}; }
            }
        };
        const node = { host: 'amt.example.invalid', intelamt: { user: 'admin', pass: SENTINEL } };
        const ws = {};
        const run = new Function('parent', 'obj', 'req', 'node', 'port', 'ws', 'if (true) {' + interceptorBlock().replace(/^\s*\/\/.*\n/, ''));
        run(parent, obj, { query: { p: mode } }, node, 16992, ws);

        assert.equal(created.length, 1);
        assert.equal(created[0].kind, (mode == 1) ? 'http' : 'redir');
        assert.equal(created[0].args.pass, SENTINEL, 'real credential still reaches the interceptor');
        assert.equal(created[0].args.user, 'admin');
        assert.ok(debugCalls.length >= 1);
        assert.doesNotMatch(serialize(debugCalls), new RegExp(SENTINEL));
        assert.match(serialize(debugCalls), /\*\*\*/);
        assert.match(serialize(debugCalls), /admin/);
    });
}

// ---------------------------------------------------------------------------------------------
// MPS / APF USERAUTH_REQUEST (mpsserver.js)
// ---------------------------------------------------------------------------------------------

function apfUserAuth(username, password) {
    const service = 'pfwd-service', method = 'password';
    return String.fromCharCode(50) + common.IntToStr(username.length) + username + common.IntToStr(service.length) + service
        + common.IntToStr(method.length) + method + '\x00' + common.IntToStr(password.length) + password;
}

// Starts the real MPS server code with net.createServer captured, returns a helper that sends APF data on a fake socket.
function mpsFixture(args, parentExtra) {
    const logs = [], cookies = [];
    const net = require('node:net');
    let handler = null;
    patch(net, 'createServer', function (h) {
        handler = h;
        const server = new EventEmitter();
        server.listen = function () { return server; };
        return server;
    });
    patch(console, 'log', function () { logs.push(Array.from(arguments)); });
    const parent = Object.assign({
        debug: function () { logs.push(Array.from(arguments)); },
        authLog: function () { },
        updateServerState: function () { },
        decodeCookie: function (c) { cookies.push(c); return null; },
        loginCookieEncryptionKey: 'k',
        config: { domains: {} },
        webserver: { trafficStats: { CIRAIn: 0, CIRAOut: 0 }, meshes: {} }
    }, parentExtra);
    const certificates = { AmtMpsName: 'mps.example.invalid' };
    require('../mpsserver.js').CreateMpsServer(parent, {}, Object.assign({ mpstlsoffload: true, mpsport: 4433 }, args), certificates);
    assert.equal(typeof handler, 'function');

    const socket = new EventEmitter();
    const writes = [];
    Object.assign(socket, {
        setEncoding: function () { }, setTimeout: function () { }, write: function (d) { writes.push(d); }, end: function () { },
        remoteAddress: '127.0.0.1', bytesRead: 0, bytesWritten: 0
    });
    handler(socket);
    socket.tag.first = false; // Skip the HTTP/MQTT/certificate detection, go straight to APF parsing.
    return {
        logs: logs, cookies: cookies, writes: writes, socket: socket,
        send: function (data) { socket.emit('data', data); },
        text: function () { return serialize(logs); }
    };
}

test('mps USERAUTH: cookie login failure redacts the cookie, decoder still gets the original', function () {
    const f = mpsFixture({}, {});
    f.send(apfUserAuth('**MeshAgentApfTunnel**', SENTINEL));
    assert.deepEqual(f.cookies, [SENTINEL]);
    assert.doesNotMatch(f.text(), new RegExp(SENTINEL));
    assert.match(f.text(), /USERAUTH_REQUEST user=\*\*MeshAgentApfTunnel\*\*/);
    assert.match(f.text(), /password=\*\*\*/);
    assert.match(f.text(), /Incorrect password/);
});

test('mps USERAUTH: unknown device group from a valid cookie redacts the password', function () {
    const f = mpsFixture({}, { decodeCookie: function (c) { return { a: 'apf', m: 'mesh/x/y', n: 'node/x/z' }; } });
    f.send(apfUserAuth('**MeshAgentApfTunnel**', SENTINEL));
    assert.doesNotMatch(f.text(), new RegExp(SENTINEL));
    assert.match(f.text(), /Device group not found \(1\)/);
});

test('mps USERAUTH: wrong CIRA password is rejected, correct one is compared with the original, neither is logged', function () {
    const wrong = mpsFixture({ mpspass: 'expected-' + SENTINEL }, {});
    wrong.send(apfUserAuth('user', SENTINEL));
    assert.doesNotMatch(wrong.text(), new RegExp(SENTINEL));
    assert.match(wrong.text(), /Incorrect password/);

    // The configured password matches what was sent: authentication proceeds past the password check to the username check.
    const right = mpsFixture({ mpspass: SENTINEL }, {});
    right.send(apfUserAuth('short', SENTINEL));
    assert.doesNotMatch(right.text(), /Incorrect password/);
    assert.match(right.text(), /Username length not 16/);
    assert.doesNotMatch(right.text(), new RegExp(SENTINEL));
});

test('mps USERAUTH: unknown device group (2) redacts the password in the debug line', function () {
    const f = mpsFixture({}, {});
    f.send(apfUserAuth('0123456789abcdef', SENTINEL));
    assert.match(f.text(), /Device group not found \(2\)/);
    assert.doesNotMatch(f.text(), new RegExp(SENTINEL));
});

test('source guard: no debug or log call in mpsserver.js USERAUTH handling prints the password variable', function () {
    const src = fs.readFileSync(path.join(root, 'mpsserver.js'), 'utf8');
    const start = src.indexOf('case APFProtocol.USERAUTH_REQUEST: {');
    const end = src.indexOf('case APFProtocol.', start + 10);
    const lines = src.substring(start, end).split('\n').filter(function (l) { return /debug\(|console\.log\(/.test(l); });
    assert.ok(lines.length >= 6);
    for (const l of lines) { assert.doesNotMatch(l, /password\s*[,)]|' \+ password|password=' \+ password/, l); }
});

// ---------------------------------------------------------------------------------------------
// Database backup (db.js)
// ---------------------------------------------------------------------------------------------

const DB_MONGODB = 3, DB_MARIADB = 4, DB_POSTGRESQL = 6;

async function withBackupDb(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc015-db-'));
    const parent = createDbParent(dir);
    const db = await new Promise(function (resolve) { require('../db.js').CreateDB(parent, resolve); });
    const stores = [db.file, db.eventsfile, db.powerfile, db.serverstatsfile];
    try {
        const warnings = [];
        parent.config.settings.autobackup = { backupintervalhours: 24, minfreespacemb: 0, backupname: 'bk-', mysqldumppath: 'mysqldump', pgdumppath: '/usr/bin/pg_dump', mongodumppath: 'mongodump' };
        parent.config.settings.postgres = { user: 'pguser', password: 'p@ss/' + SENTINEL, host: 'db.example.invalid', port: 5432 };
        parent.backuppath = dir;
        parent.parentpath = dir;
        parent.platform = 'linux';
        parent.args.mongodb = 'mongodb://mongouser:' + SENTINEL + '@db.example.invalid:27017/mc';
        parent.args.mariadb = { user: 'myuser', password: SENTINEL, host: 'db.example.invalid', port: 3306 };
        parent.args.mysql = parent.args.mariadb;
        parent.addServerWarning = function (msg) { warnings.push(msg); };
        const debugCalls = [], consoleCalls = [];
        parent.debug = function () { debugCalls.push(Array.from(arguments)); };
        patch(console, 'log', function () { consoleCalls.push(Array.from(arguments)); });
        patch(console, 'error', function () { consoleCalls.push(Array.from(arguments)); });
        await body({ db: db, parent: parent, warnings: warnings, debugCalls: debugCalls, consoleCalls: consoleCalls });
    } finally {
        for (const store of stores) { await new Promise(function (resolve) { store.find({}, resolve); }); }
        for (const store of stores) { store.stopAutocompaction(); }
        db.databaseType = 1; // Back to NeDB so dispose() behaves as in the NeDB tests.
        try { db.dispose(); } catch (ex) { }
        await new Promise(function (resolve) { setTimeout(resolve, 100); }); // Let NeDB finish its initial file creation.
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Command-bearing child process error, as produced by child_process.exec.
function execError(cmd, code) {
    const err = new Error('Command failed: ' + cmd + '\n' + SENTINEL + ' ' + encodeURIComponent('p@ss/' + SENTINEL) + ' stderr');
    err.cmd = cmd;
    err.code = code;
    err.stderr = 'authentication failed for ' + SENTINEL;
    return err;
}

const backends = [
    { name: 'mongodump', type: DB_MONGODB, label: /mongodump/ },
    { name: 'mysqldump', type: DB_MARIADB, label: /mysqldump/ },
    { name: 'pg_dump', type: DB_POSTGRESQL, label: /pg_dump/ }
];

for (const b of backends) {
    test('backup ' + b.name + ': failure logs only the executable name, sets BACKUPFAIL_DBDUMP, continues, exec gets the real command', function () {
        return withBackupDb(async function (ctx) {
            const executed = [];
            patch(child_process, 'exec', function (cmd, options, cb) { executed.push(cmd); setImmediate(function () { cb(execError(cmd, 2)); }); });
            ctx.db.databaseType = b.type;
            let continued = 0;
            ctx.db.createBackupfile = function () { continued++; };
            ctx.db.performBackup(function () { });
            await new Promise(function (resolve) { setImmediate(resolve); });
            await new Promise(function (resolve) { setImmediate(resolve); });

            assert.equal(executed.length, 1);
            assert.match(executed[0], new RegExp(SENTINEL), 'exec receives the real credentials');
            assert.equal(continued, 1);
            assert.equal(ctx.db.backupStatus & 0x0100, 0x0100);

            const everything = serialize([ctx.debugCalls, ctx.consoleCalls, ctx.warnings]);
            assert.doesNotMatch(everything, new RegExp(SENTINEL));
            assert.doesNotMatch(everything, /p%40ss/);
            assert.doesNotMatch(everything, /--password|--dbname|--uri|--user|postgresql:\/\//);
            assert.match(everything, b.label);
            assert.match(everything, /exit code 2/);
        });
    });
}

test('backup: non-numeric exec error code is not echoed', function () {
    return withBackupDb(async function (ctx) {
        patch(child_process, 'exec', function (cmd, options, cb) { setImmediate(function () { cb(execError(cmd, 'EACCES-' + SENTINEL)); }); });
        ctx.db.databaseType = DB_POSTGRESQL;
        ctx.db.createBackupfile = function () { };
        ctx.db.performBackup(function () { });
        await new Promise(function (resolve) { setImmediate(resolve); });
        await new Promise(function (resolve) { setImmediate(resolve); });
        assert.doesNotMatch(serialize([ctx.debugCalls, ctx.consoleCalls, ctx.warnings]), /EACCES|S3NT1NEL/);
        assert.equal(ctx.db.backupStatus & 0x0100, 0x0100);
    });
});

test('backup: an exception thrown while running the dump does not leak into console or server warnings', function () {
    return withBackupDb(async function (ctx) {
        patch(child_process, 'exec', function (cmd) { throw execError(cmd, 1); });
        ctx.db.databaseType = DB_MONGODB;
        ctx.db.createBackupfile = function () { };
        ctx.db.performBackup(function () { });
        assert.equal(ctx.warnings.length, 1);
        assert.doesNotMatch(serialize([ctx.debugCalls, ctx.consoleCalls, ctx.warnings]), new RegExp(SENTINEL));
        assert.doesNotMatch(serialize([ctx.debugCalls, ctx.consoleCalls, ctx.warnings]), /--uri|mongodb:\/\//);
    });
});

test('backup: success path logs the executable name only', function () {
    return withBackupDb(async function (ctx) {
        patch(child_process, 'exec', function (cmd, options, cb) { setImmediate(function () { cb(null); }); });
        ctx.db.databaseType = DB_POSTGRESQL;
        let continued = 0;
        ctx.db.createBackupfile = function () { continued++; };
        ctx.db.performBackup(function () { });
        await new Promise(function (resolve) { setImmediate(resolve); });
        assert.equal(continued, 1);
        assert.equal(ctx.db.backupStatus & 0x0100, 0);
        assert.doesNotMatch(serialize([ctx.debugCalls, ctx.consoleCalls]), new RegExp(SENTINEL));
        assert.match(serialize(ctx.debugCalls), /pg_dump/);
    });
});
