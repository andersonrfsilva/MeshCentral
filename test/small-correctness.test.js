'use strict';

// Regression tests for plan 017. Each top-level case is named with its SITE tag.
// Production code is exercised through exported factories where possible; code nested in the large
// server modules is loaded verbatim from source with node:vm and injected bindings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

const ROOT = path.join(__dirname, '..');
const common = require('../common.js');

function readSource(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

// Returns the full text of a four-space indented function declaration, from its header to its closing brace.
function extractFunction(file, header) {
    const src = readSource(file);
    const start = src.indexOf('\n    ' + header);
    assert.ok(start >= 0, 'extraction marker missing: ' + header);
    const end = src.indexOf('\n    }\n', start + 1);
    assert.ok(end > start, 'function end missing: ' + header);
    return src.slice(start + 1, end + 6);
}

// Returns the source text between two markers (both included, the end marker's line is completed).
function extractBetween(file, startMarker, endMarker) {
    const src = readSource(file);
    const start = src.indexOf(startMarker);
    assert.ok(start >= 0, 'extraction marker missing: ' + startMarker);
    const endAt = src.indexOf(endMarker, start);
    assert.ok(endAt > start, 'extraction marker missing: ' + endMarker);
    let end = src.indexOf('\n', endAt);
    if (end < 0) { end = src.length; }
    return src.slice(start, end);
}

// Compiles an extracted function declaration inside a sandbox that only sees the injected bindings.
function compileFunction(code, bindings) {
    const ctx = vm.createContext(Object.assign({ Buffer: Buffer, console: console, Object: Object, Date: Date, Math: Math, JSON: JSON, setTimeout: setTimeout, parseInt: parseInt }, bindings));
    return vm.runInContext('(' + code + ')', ctx);
}

// Loads a whole production module and exposes some of its non-exported top-level names.
function loadWithExports(file, names) {
    const full = path.join(ROOT, file);
    const src = fs.readFileSync(full, 'utf8') + '\n;' + names.map(function (n) { return '__x.' + n + ' = ' + n + ';'; }).join('');
    const wrapper = vm.runInThisContext('(function (module, exports, require, __x) {' + src + '\n})', { filename: full });
    const m = { exports: {} }, x = {};
    wrapper(m, m.exports, Module.createRequire(full), x);
    return x;
}

// Runs callbacks immediately ('sync') or holds them and releases them in reverse order ('reverse').
function makeScheduler(mode) {
    const queue = [];
    return {
        run: function (fn) { if (mode === 'sync') { fn(); } else { queue.push(fn); } },
        flush: function () { while (queue.length > 0) { queue.pop()(); } }
    };
}

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

async function until(cond, what) {
    for (let i = 0; i < 400; i++) { if (cond()) { return; } await new Promise(function (r) { setTimeout(r, 5); }); }
    assert.fail('timed out waiting for ' + what);
}

function sentActions(f, action) {
    return f.sent.map(function (s) { return JSON.parse(s); }).filter(function (m) { return m.action === action; });
}

// ---------------------------------------------------------------------------------------------

test('custom-core', async function (t) {
    for (const mode of ['success', 'error']) {
        await t.test(mode, async function (t2) {
            const f = await createMeshUserFixture({ user: { siteadmin: 0xFFFFFFFF } });
            const cores = [];
            f.parent.GetNodeWithRights = function (d, u, nodeid, cb) { cb({ _id: nodeid }, 0xFFFFFFFF, true); };
            f.parent.getServerFilePath = function () { return { fullpath: '/synthetic/core.js' }; };
            f.parent.sendMeshAgentCore = function () { cores.push(Array.from(arguments).slice(2)); };
            t2.mock.method(fs, 'readFile', function (file, enc, cb) { assert.equal(file, '/synthetic/core.js'); if (mode === 'success') { cb(null, 'core-body'); } else { cb(new Error('read failed')); } });
            try {
                f.ws.emit('message', Buffer.from(JSON.stringify({ action: 'uploadagentcore', type: 'custom', path: 'core.js', nodeids: ['node//n1'] })));
                if (mode === 'success') {
                    assert.deepEqual(cores, [['node//n1', 'custom', common.IntToStr(0) + 'core-body']]);
                } else {
                    assert.deepEqual(cores, []);
                }
                assert.deepEqual(f.errors, []);
            } finally { t2.mock.restoreAll(); f.close(); }
        });
    }
});

test('device-details', async function (t) {
    const nodeSets = { none: [], one: ['node//a'], two: ['node//a', 'node//b'] };
    for (const paged of [false, true]) {
        for (const mode of ['sync', 'reverse']) {
            for (const setName of Object.keys(nodeSets)) {
                for (const visibility of ['all-visible', 'none-visible', 'mixed', 'no-sysinfo']) {
                    if ((setName === 'none') && (visibility !== 'all-visible')) { continue; }
                    if ((setName === 'one') && (visibility === 'mixed')) { continue; }
                    const name = (paged ? 'paged' : 'unpaged') + '/' + mode + '/' + setName + '/' + visibility;
                    await t.test(name, async function () {
                        const f = await createMeshUserFixture({ user: { siteadmin: 0xFFFFFFFF } });
                        try {
                            const ids = nodeSets[setName];
                            const sched = makeScheduler(mode);
                            const visible = {};
                            ids.forEach(function (id, idx) { visible[id] = (visibility === 'none-visible') ? false : ((visibility === 'mixed') ? (idx === 0) : true); });
                            f.root.GetConnectivityState = function () { return null; };
                            f.parent.GetAllMeshIdWithRights = function () { return []; };
                            f.parent.cleanDevice = function () { };
                            f.parent.CloneSafeNode = function (n) { return Object.assign({}, n); };
                            f.parent.GetNodeRights = function () { return 0xFFFFFFFF; };
                            f.parent.GetNodeWithRights = function (d, u, id, cb) { sched.run(function () { cb({ _id: id, meshid: 'mesh//m' }, 0xFFFFFFFF, visible[id] === true); }); };
                            f.db.GetAllTypeNoTypeFieldMeshFiltered = function (links, extra, domainid, type, id, skip, limit, filter, cb) { cb(null, ids.map(function (id) { return { _id: id }; })); };
                            f.db.GetAllIdsOfType = function (ids2, domainid, type, cb) { cb(null, []); };
                            f.db.Get = function (key, cb) { sched.run(function () { if (visibility === 'no-sysinfo') { cb(null, []); } else { cb(null, [{ _id: key }]); } }); };
                            if (paged) { f.obj.visibleDevices = {}; ids.forEach(function (id) { f.obj.visibleDevices[id] = 1; }); }
                            f.clearCaptures();
                            f.ws.emit('message', Buffer.from(JSON.stringify({ action: 'getDeviceDetails', type: 'json' })));
                            sched.flush();
                            const replies = sentActions(f, 'getDeviceDetails');
                            assert.equal(replies.length, 1, 'completion callback count');
                            assert.equal(replies[0].type, 'json');
                            const data = JSON.parse(replies[0].data);
                            assert.ok(Array.isArray(data));
                            const expected = ids.filter(function (id) { return visible[id]; });
                            assert.deepEqual(data.map(function (r) { return r.node._id; }).sort(), expected.slice().sort());
                            data.forEach(function (r) { if (visibility === 'no-sysinfo') { assert.equal(r.sys, null); assert.equal(r.net, null); } });
                            assert.deepEqual(f.errors, []);
                        } finally { f.close(); }
                    });
                }
            }
        }
    }
});

test('chunk-frame', function () {
    const sent = [];
    const parent = { lastOperation: 0, webCookies: {}, parent: { parent: { debug: function () { } } } };
    const relay = require('../apprelays.js').CreateWebRelay(parent, {}, {}, { id: '' }, 1);
    relay.relayActive = true;
    relay.wsClient = { send: function (d) { sent.push(Buffer.from(d)); } };
    const req = new EventEmitter();
    req.headers = { 'transfer-encoding': 'chunked', host: 'x' };
    req.method = 'POST'; req.url = '/up'; req.httpVersion = '1.1';
    const res = { socket: new EventEmitter(), end: function () { } };
    relay.processRequest(req, res);
    assert.equal(sent.length, 1, 'request header only');
    assert.ok(sent[0].toString().startsWith('POST /up HTTP/1.1\r\n'));

    const payloads = [Buffer.from([0, 1, 2, 255, 13, 10]), Buffer.alloc(300, 0xAB), Buffer.from('x')];
    for (const p of payloads) {
        const before = sent.length;
        req.emit('data', p);
        assert.equal(sent.length, before + 1, 'one send per chunk');
        assert.deepEqual(sent[before], Buffer.concat([Buffer.from(p.length.toString(16) + '\r\n'), p, Buffer.from('\r\n')]));
    }
    const before = sent.length;
    req.emit('end');
    assert.equal(sent.length, before + 1);
    assert.deepEqual(sent[before], Buffer.from('0\r\n\r\n'));
});

test('hello-buffer', async function (t) {
    const net = require('node:net');
    let onConnection = null;
    t.mock.method(net, 'createServer', function (fn) { onConnection = fn; return { listen: function () { } }; });
    t.mock.method(console, 'log', function () { });
    const parent = {
        debug: function () { },
        certificates: { root: { cert: 'synthetic' } },
        certificateOperations: { forge: { pki: { certificateFromPem: function () { return { subject: { getField: function () { return { value: 'CN' }; } } }; } } } }
    };
    const server = require('../amtprovisioningserver.js').CreateAmtProvisioningServer(parent, { devicegroup: 'mesh//g', newmebxpassword: 'P@ssw0rd1' });
    assert.ok(server != null && onConnection != null);

    function connect() {
        const s = new EventEmitter();
        s.remoteAddress = '192.0.2.1';
        s.ends = [];
        s.end = function (x) { s.ends.push(x); };
        onConnection(s);
        return s;
    }
    const header = 'GET / HTTP/1.1\r\nHost: amt\r\n\r\n';
    const splits = { 'two pieces': [12, header.length], 'three pieces': [5, 20, header.length], 'split CRLF terminator': [header.length - 2, header.length - 1, header.length] };
    for (const name of Object.keys(splits)) {
        await t.test(name, function () {
            const s = connect();
            let at = 0;
            for (const cut of splits[name]) {
                s.emit('data', Buffer.from(header.slice(at, cut)));
                at = cut;
                if (at < header.length) { assert.deepEqual(s.ends, []); assert.equal(s.data.toString(), header.slice(0, at), 'accumulated bytes'); }
            }
            assert.equal(s.ends.length, 1, 'exactly one response');
            assert.ok(s.ends[0].startsWith('HTTP/1.1 200 OK\r\n'));
        });
    }
    await t.test('size guard', function () {
        const s = connect();
        s.emit('data', Buffer.from('GET ' + 'a'.repeat(8000)));
        assert.deepEqual(s.ends, []);
        s.emit('data', Buffer.from('b'.repeat(8100)));
        assert.equal(s.ends.length, 1);
        assert.equal(s.ends[0], undefined);
    });
});

function emailFixture(extra) {
    const calls = { rendered: [], redirected: 0, mail: [], setUser: [] };
    const bindings = Object.assign({
        calls: calls,
        checkUserIpAddress: function () { return bindings.domain; },
        parent: { debug: function () { }, DispatchEvent: function () { } },
        checkEmail: function () { return true; },
        handleRootRequestEx: function () { calls.redirected++; },
        getQueryPortion: function () { return ''; },
        db: { SetUser: function (u) { calls.setUser.push(u); }, changeStream: false },
        EscapeHtml: function (x) { return x; }
    }, extra);
    return bindings;
}

test('email-request', async function (t) {
    const code = extractFunction('webserver.js', 'function handleCheckAccountEmailRequest(');
    const me = { _id: 'user//me', name: 'me', email: 'old@example.invalid' };
    const other = { _id: 'user//other', name: 'other' };
    const cases = [
        { name: 'empty docs', err: null, docs: [], rejected: false },
        { name: 'current account present', err: null, docs: [{ _id: 'user//me' }], rejected: false },
        { name: 'different account only', err: null, docs: [{ _id: 'user//other' }], rejected: true },
        { name: 'db error', err: new Error('db'), docs: [], rejected: true }
    ];
    for (const c of cases) {
        await t.test(c.name, function () {
            const calls = { sendMail: 0, setUser: 0 };
            const users = { 'user//me': Object.assign({}, me), 'user//other': other };
            const domain = { id: '', url: '/', mailserver: { sendAccountCheckMail: function () { calls.sendMail++; } } };
            const b = emailFixture({
                domain: domain,
                obj: { users: users, common: common, db: { GetUserWithVerifiedEmail: function (d, e, cb) { cb(c.err, c.docs); } }, CloneSafeUser: function (u) { return u; }, getLanguageCodes: function () { return 'en'; } }
            });
            b.db.SetUser = function () { calls.setUser++; };
            const fn = compileFunction(code, b);
            const req = { session: { cuserid: 'user//me' }, query: {}, body: { email: 'New@Example.invalid' }, headers: {} };
            fn(req, { sendStatus: function () { assert.fail('unexpected status'); } }, true);
            assert.equal(b.calls.redirected, 1);
            assert.equal(req.session.messageid, c.rejected ? 102 : 2);
            assert.equal(calls.sendMail, c.rejected ? 0 : 1);
            assert.equal(calls.setUser, c.rejected ? 0 : 1);
        });
    }
});

test('email-verification', async function (t) {
    const code = extractFunction('webserver.js', 'function handleCheckMailRequest(');
    const cases = [
        { name: 'empty docs', docs: [], msgid: 6 },
        { name: 'current user present', docs: [{ _id: 'user//me' }], msgid: 6 },
        { name: 'another user only', docs: [{ _id: 'user//other' }], msgid: 5 }
    ];
    for (const c of cases) {
        await t.test(c.name, function () {
            const user = { _id: 'user//me', name: 'me', email: 'me@example.invalid' };
            const rendered = [];
            const domain = { id: '', url: '/', mailserver: { mailCookieEncryptionKey: 'k' } };
            const b = emailFixture({
                domain: domain,
                render: function (req, res, page, args) { rendered.push(args); },
                getRenderPage: function () { return 'page'; },
                getRenderArgs: function (a) { return a; },
                obj: {
                    users: { 'user//me': user },
                    parent: { decodeCookie: function () { return { u: 'user//me', e: 'me@example.invalid', a: 1 }; }, DispatchEvent: function () { }, authLog: function () { } },
                    db: { Get: function (id, cb) { cb(null, [Object.assign({}, user)]); }, GetUserWithVerifiedEmail: function (d, e, cb) { cb(null, c.docs); }, SetUser: function () { }, changeStream: false },
                    CloneSafeUser: function (u) { return u; }
                }
            });
            const fn = compileFunction(code, b);
            fn({ query: { c: 'cookie' }, headers: {}, session: {} }, {});
            assert.equal(rendered.length >= 1, true);
            assert.equal(rendered[0].msgid, c.msgid);
            assert.equal(user.emailVerified === true, c.msgid === 6);
        });
    }
});

test('reset-closure', async function (t) {
    const code = extractFunction('webserver.js', 'function handleResetAccountRequest(');

    function setup(token) {
        const docs = [
            { _id: 'user//a', name: 'a', email: 'x@example.invalid', phone: '+1 555 0100' },
            { _id: 'user//b', name: 'b', email: 'x@example.invalid', phone: '+1 555 0101' }
        ];
        const held = [], mails = [], sms = [], setUsers = [];
        const domain = {
            id: '', url: '/',
            mailserver: { sendAccountResetMail: function (d, name, id) { mails.push(name); } }
        };
        const b = emailFixture({
            domain: domain,
            obj: {
                args: {}, parent: { certificates: { CommonName: 'host.example.invalid' } },
                users: {}, common: common, crypto: require('node:crypto'),
                db: { GetUserWithVerifiedEmail: function (d, e, cb) { cb(null, docs); }, SetUser: function (u) { setUsers.push(u); } },
                checkAllow2Fa: function () { return true; },
                getLanguageCodes: function () { return 'en'; }
            },
            parent: { debug: function () { }, smsserver: { sendToken: function (d, phone) { sms.push(phone); } } },
            checkUserOneTimePasswordRequired: function () { return true; },
            checkUserOneTimePassword: function (req, d, user, tok, hw, cb) { held.push({ user: user, cb: cb }); },
            getRandomSixDigitInteger: function () { return 123456; }
        });
        const fn = compileFunction(code, b);
        const req = { session: {}, query: {}, body: { email: 'X@Example.invalid', hwtoken: token }, headers: {} };
        fn(req, { sendStatus: function () { assert.fail('unexpected status'); } }, true);
        return { docs: docs, held: held, mails: mails, sms: sms, setUsers: setUsers, calls: b.calls, req: req };
    }

    await t.test('reverse release, both succeed', function () {
        const s = setup(undefined);
        assert.equal(s.held.length, 2);
        assert.deepEqual(s.held.map(function (h) { return h.user._id; }), ['user//a', 'user//b']);
        s.held[1].cb(true, {});
        assert.equal(s.calls.redirected, 0, 'only index zero responds');
        s.held[0].cb(true, {});
        assert.deepEqual(s.mails, ['b', 'a']);
        assert.equal(s.calls.redirected, 1);
        assert.equal(s.req.session.messageid, 1);
    });

    await t.test('first account fails, later account succeeds', function () {
        const s = setup(undefined);
        s.held[1].cb(true, {});
        assert.deepEqual(s.mails, ['b']);
        assert.equal(s.calls.redirected, 0);
        s.held[0].cb(false, {});
        assert.equal(s.calls.redirected, 1);
        assert.equal(s.req.session.loginmode, 5);
        assert.deepEqual(s.mails, ['b']);
    });

    await t.test('2FA token update targets the failing account', function () {
        const s = setup('**sms**');
        s.held[1].cb(true, {});
        s.held[0].cb(false, {});
        assert.ok(s.docs[0].otpsms != null, 'account a has token');
        assert.equal(s.docs[1].otpsms, undefined, 'account b untouched');
        assert.deepEqual(s.setUsers, [s.docs[0]]);
        assert.deepEqual(s.sms, ['+1 555 0100']);
    });
});

test('amt-port', async function () {
    const seg = extractBetween('amtmanager.js', 'var dotls = -1;', 'removeAmtDevice(dev, 10); return; }');
    const cases = [
        { name: 'empty ports', ports: [], expect: 'removed' },
        { name: '16992 at index zero', ports: ['16992'], expect: 0 },
        { name: '16993 at index zero', ports: ['16993'], expect: 1 },
        { name: 'both ports', ports: ['16993', '16992'], expect: 0 },
        { name: 'unrelated ports', ports: ['80', '443'], expect: 'removed' }
    ];
    for (const c of cases) {
        const removed = [];
        const ctx = vm.createContext({ removeAmtDevice: function (dev, code) { removed.push(code); } });
        const fn = vm.runInContext('(function (ciraconn, dev) {' + seg + '\nreturn dotls; })', ctx);
        const result = fn({ tag: { boundPorts: c.ports } }, {});
        if (c.expect === 'removed') { assert.equal(result, undefined, c.name); assert.deepEqual(removed, [10], c.name); }
        else { assert.equal(result, c.expect, c.name); assert.deepEqual(removed, [], c.name); }
    }
});

test('kvm-path', async function (t) {
    const nid = 'a'.repeat(64);
    const calls = [];
    const parent = {
        crypto: require('node:crypto'),
        AddEventDispatch: function () { },
        webserver: { users: { u1: { name: 'u1' } }, GetNodeRights: function () { return 8; } }
    };
    const mgr = require('../meshipkvm.js').CreateIPKVMManager(parent);
    mgr.managedPorts['node//' + nid] = { meshid: 'mesh//g' };
    mgr.managedGroups['mesh//g'] = { handleIpKvmGet: function (domain, reqinfo) { calls.push(reqinfo); } };
    mgr.managedPorts['node/d1/' + nid] = { meshid: 'mesh//g' };

    function get(domainid, url) {
        calls.length = 0;
        let nexts = 0;
        mgr.handleIpKvmGet({ id: domainid }, { url: url, session: { userid: 'u1' } }, {}, function () { nexts++; });
        return { reqinfo: calls[0], nexts: nexts };
    }
    await t.test('root domain', function () {
        const r = get('', '/ipkvm.ashx/' + nid + '/x/y.js?a=1&b=2');
        assert.equal(r.nexts, 0);
        assert.equal(r.reqinfo.preurl, '/ipkvm.ashx/' + nid);
        assert.equal(r.reqinfo.relurl, '/x/y.js');
    });
    await t.test('domain prefixed', function () {
        const r = get('d1', '/d1/ipkvm.ashx/' + nid + '/page?q=1');
        assert.equal(r.nexts, 0);
        assert.equal(r.reqinfo.preurl, '/d1/ipkvm.ashx/' + nid);
        assert.equal(r.reqinfo.relurl, '/page');
        assert.equal(r.reqinfo.nodeid, 'node/d1/' + nid);
    });
    await t.test('unknown port and malformed id', function () {
        assert.equal(get('', '/ipkvm.ashx/' + 'b'.repeat(64) + '/x').reqinfo, undefined);
        assert.equal(get('', '/ipkvm.ashx/' + 'b'.repeat(64) + '/x').nexts, 1);
        assert.equal(get('', '/ipkvm.ashx/short/x').nexts, 1);
        assert.equal(get('', '/other/path').nexts, 1);
    });
});

test('file-command', async function (t) {
    const parent = { parent: { decodeCookie: function () { return { ruserid: 'u' }; }, loginCookieEncryptionKey: 'k', debug: function () { } }, relaySessionCount: 0, relaySessionErrorCount: 0, wsrelays: {} };
    function build() {
        const headers = [], statuses = [], writes = [];
        const res = { set: function (h) { headers.push(h); }, sendStatus: function (c) { statuses.push(c); }, write: function (d) { writes.push(d); }, end: function () { } };
        const ws = new EventEmitter();
        ws._socket = { setKeepAlive: function () { }, pause: function () { }, resume: function () { } };
        ws.close = function () { };
        const req = { query: { id: 'relay-' + Math.random(), rauth: 'x', f: 'name.txt' }, clientIp: '127.0.0.1' };
        require('../meshdevicefile.js').CreateMeshDeviceFile(parent, ws, res, req, { id: '' }, null, 'mesh//m', 'node//n', null);
        const relay = parent.wsrelays[req.query.id];
        clearTimeout(relay.timeout);
        ws.res = res; ws.file = 'name.txt';
        return { ws: ws, headers: headers, statuses: statuses };
    }
    for (const bad of ['not json{', 'null', '{}', '"str"', '42', '{"op":5}']) {
        await t.test('ignored: ' + bad, function () {
            const b = build();
            assert.doesNotThrow(function () { b.ws.emit('message', bad); });
            assert.deepEqual(b.headers, []);
            assert.deepEqual(b.statuses, []);
        });
    }
    await t.test('ok with size', function () {
        const b = build();
        b.ws.emit('message', JSON.stringify({ op: 'ok', size: 1234 }));
        assert.equal(b.headers.length, 1);
        assert.equal(b.headers[0]['Content-Length'], 1234);
        assert.deepEqual(b.statuses, []);
    });
    await t.test('other op', function () {
        const b = build();
        b.ws.emit('message', JSON.stringify({ op: 'cancel' }));
        assert.deepEqual(b.statuses, [401]);
        assert.deepEqual(b.headers, []);
    });
});

test('restore-user', async function (t) {
    const code = extractFunction('webserver.js', 'function handleRestoreRequest(');
    const cookies = {
        good: { userid: 'user//admin', domainid: '' },
        wrongdomain: { userid: 'user//admin', domainid: 'other' },
        norights: { userid: 'user//plain', domainid: '' },
        badbinding: { userid: 'user//admin', domainid: '' }
    };
    function run(opts) {
        const out = { status: [], ended: 0, stopped: [] };
        const domain = { id: '', url: '/' };
        const users = { 'user//admin': { siteadmin: 4 }, 'user//plain': { siteadmin: 0 } };
        const bindings = {
            checkUserIpAddress: function () { return domain; },
            obj: {
                users: users,
                parent: { decodeCookie: function (c) { return cookies[c] || null; }, loginCookieEncryptionKey: 'k' }
            },
            parent: { Stop: function (p) { out.stopped.push(p); } },
            checkAuthCookie: function (cookie) { return cookie !== cookies.badbinding; },
            require: function (name) {
                assert.equal(name, 'multiparty');
                return { Form: function () { return { parse: function (req, cb) { cb(null, opts.fields || {}, { datafile: [{ path: '/tmp/restore.zip' }] }); } }; } };
            }
        };
        const fn = compileFunction(code, bindings);
        const req = { query: {}, session: opts.session, protocol: 'https', get: function () { return 'host'; } };
        fn(req, { sendStatus: function (c) { out.status.push(c); }, set: function () { }, end: function () { out.ended++; } });
        return out;
    }
    await t.test('form cookie without session', function () {
        const o = run({ session: {}, fields: { auth: ['good'] } });
        assert.deepEqual(o.status, []);
        assert.deepEqual(o.stopped, ['/tmp/restore.zip']);
    });
    await t.test('session alone', function () {
        const o = run({ session: { userid: 'user//admin' } });
        assert.deepEqual(o.stopped, ['/tmp/restore.zip']);
    });
    for (const [name, opts] of [
        ['invalid or expired cookie without session', { session: {}, fields: { auth: ['nosuch'] } }],
        ['wrong-domain cookie', { session: {}, fields: { auth: ['wrongdomain'] } }],
        ['cookie failing session binding', { session: {}, fields: { auth: ['badbinding'] } }],
        ['authenticated user without restore rights', { session: { userid: 'user//plain' } }],
        ['cookie of user without restore rights', { session: {}, fields: { auth: ['norights'] } }]
    ]) {
        await t.test(name, function () {
            const o = run(opts);
            assert.deepEqual(o.status, [401]);
            assert.deepEqual(o.stopped, []);
        });
    }
});

test('mail-error', async function (t) {
    const original = Module._load;
    const sendCalls = [];
    let failuresLeft = 3;
    const fakeSendGrid = {
        setApiKey: function () { },
        send: function (mail) { sendCalls.push(mail.subject); if ((mail.subject === 'first') && (failuresLeft-- > 0)) { return Promise.reject({ reason: 'rejected' }); } return Promise.resolve(); }
    };
    t.mock.method(Module, '_load', function (request, parentModule, isMain) { if (request === '@sendgrid/mail') { return fakeSendGrid; } return original.call(this, request, parentModule, isMain); });
    const logs = [];
    t.mock.method(console, 'log', function (m) { logs.push(String(m)); });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const parent = { crypto: require('node:crypto'), debug: function () { }, config: {}, db: { Get: function (key, cb) { cb(null, [{ key: '00' }]); } } };
        const mail = require('../meshmail.js').CreateMeshMail(parent, { sendgrid: { apikey: 'k', from: 'from@example.invalid' } });
        mail.sendMail('a@example.invalid', 'first', 't', 'h');
        mail.sendMail('b@example.invalid', 'second', 't', 'h');
        await tick();
        assert.equal(mail.retry, 1);
        t.mock.timers.tick(10000);
        await tick();
        assert.equal(mail.retry, 2);
        t.mock.timers.tick(10000);
        await tick();
        await tick();
        assert.deepEqual(sendCalls, ['first', 'first', 'first', 'second']);
        assert.equal(mail.retry, 0);
        assert.equal(mail.pendingMails.length, 0);
        assert.equal(mail.sendingMail, false);
        assert.equal(logs.filter(function (l) { return l.startsWith('SendGrid server failed (Skipping): '); }).length, 1);
        assert.ok(logs.some(function (l) { return l.indexOf('rejected') >= 0; }), 'logs the rejection');
    } finally { t.mock.timers.reset(); }
});

test('batch-limit', async function (t) {
    const cases = [
        { name: '8/2 allowed', existing: 8, requested: 2, max: 10, threshold: 8, reject: false },
        { name: '9/2 rejected', existing: 9, requested: 2, max: 10, threshold: 8, reject: true },
        { name: '10/1 rejected', existing: 10, requested: 1, max: 10, threshold: 9, reject: true },
        { name: '0/11 rejected', existing: 0, requested: 11, max: 10, threshold: -1, reject: true },
        { name: '0/0 allowed', existing: 0, requested: 0, max: 10, threshold: 10, reject: false },
        { name: 'null limit unlimited', existing: 1000, requested: 3, max: null, threshold: null, reject: false },
        { name: 'undefined limit unlimited', existing: 1000, requested: 3, max: undefined, threshold: null, reject: false }
    ];
    for (const c of cases) {
        await t.test(c.name, async function () {
            const f = await createMeshUserFixture({ user: { siteadmin: 0xFFFFFFFF } });
            try {
                const thresholds = [], notices = [];
                f.domain.limits = (c.max === undefined) ? {} : { maxuseraccounts: c.max };
                f.db.isMaxType = function (max, type, domainid, cb) { thresholds.push(max); if (max == null) { cb(false); } else { cb(c.existing > max); } };
                f.db.RemoveAllUserEvents = function () { };
                f.parent.wssessions[f.user._id] = [{ domainid: f.domain.id, send: function (m) { notices.push(JSON.parse(m)); } }];
                const users = [];
                for (let i = 0; i < c.requested; i++) { users.push({ user: 'batchuser' + i, pass: 'Passw0rd!x' + i }); }
                f.clearCaptures();
                f.ws.emit('message', Buffer.from(JSON.stringify({ action: 'adduserbatch', users: users })));
                assert.deepEqual(thresholds, [c.threshold], 'threshold passed to the database');
                assert.equal(notices.length, c.reject ? 1 : 0);
                if (c.reject) { assert.equal(notices[0].msgid, 10); }
                if (!c.reject) { await until(function () { return f.dbUsers.length === c.requested; }, 'created users'); }
                assert.equal(f.dbUsers.length, c.reject ? 0 : c.requested);
                assert.deepEqual(f.errors, []);
            } finally { f.close(); }
        });
    }
});

test('new-user-fields', async function (t) {
    const cases = [
        { name: 'zero consent, empty phone', consent: 0, phone: '', hasConsent: false, hasPhone: false },
        { name: 'nonzero consent, valid phone', consent: 5, phone: '+1 555-0100', hasConsent: true, hasPhone: true },
        { name: 'omitted fields', consent: undefined, phone: undefined, hasConsent: false, hasPhone: false }
    ];
    for (const c of cases) {
        await t.test(c.name, async function () {
            const f = await createMeshUserFixture({ user: { siteadmin: 0xFFFFFFFF } });
            try {
                f.db.isMaxType = function (max, type, domainid, cb) { cb(false); };
                f.db.RemoveAllUserEvents = function () { };
                const command = { action: 'adduser', username: 'newbie', pass: 'Passw0rd!x' };
                if (c.consent !== undefined) { command.consent = c.consent; }
                if (c.phone !== undefined) { command.phone = c.phone; }
                f.clearCaptures();
                f.ws.emit('message', Buffer.from(JSON.stringify(command)));
                await until(function () { return f.dbUsers.length === 1; }, 'new user persisted');
                const u = f.dbUsers[0];
                assert.equal(u._id, 'user//newbie');
                assert.ok(f.parent.users['user//newbie'] === u, 'persisted object is the new user');
                assert.equal('consent' in u, c.hasConsent);
                if (c.hasConsent) { assert.equal(u.consent, c.consent); }
                assert.equal('phone' in u, c.hasPhone);
                if (c.hasPhone) { assert.equal(u.phone, c.phone); }
                assert.deepEqual(f.errors, []);
                assert.equal(typeof globalThis.change, 'undefined');
                assert.equal(typeof globalThis.chguser, 'undefined');
            } finally { f.close(); }
        });
    }
});

test('agent-flow', async function (t) {
    const mux = loadWithExports('meshdesktopmultiplex.js', ['CreateDesktopMultiplexor']).CreateDesktopMultiplexor;
    function build() {
        const parent = { trafficStats: { desktopMultiplex: { sessions: 0 } }, parent: { debug: function () { } }, db: { Get: function (id, cb) { cb(new Error('no node'), null); } } };
        const m = mux(parent, { id: '' }, 'node//n', 'sess', function () { });
        const sent = [], callbacks = [];
        m.agent = { ws: { send: function (d, cb) { sent.push(d); callbacks.push(cb); } }, sending: false, overflow: false, sendQueue: [], paused: false };
        const viewers = [0, 1].map(function () {
            const v = { paused: false, pauses: 0, resumes: 0 };
            v.ws = { _socket: { pause: function () { v.pauses++; }, resume: function () { v.resumes++; } } };
            return v;
        });
        m.viewers = viewers;
        return { m: m, sent: sent, callbacks: callbacks, viewers: viewers };
    }
    await t.test('queue, pause, FIFO drain, resume', function () {
        const b = build();
        b.m.sendToAgent('m0');
        assert.deepEqual(b.sent, ['m0']);
        assert.equal(b.m.agent.sending, true);
        for (let i = 1; i <= 12; i++) { b.m.sendToAgent('m' + i); }
        assert.deepEqual(b.sent, ['m0'], 'only one send in flight');
        assert.equal(b.m.agent.sendQueue.length, 12);
        b.viewers.forEach(function (v) { assert.equal(v.pauses, 1); assert.equal(v.paused, true); assert.equal(v.resumes, 0); });
        for (let i = 0; i < 13; i++) {
            assert.equal(b.callbacks.length, i + 1);
            b.callbacks[i]();
            assert.equal(b.m.agent.sending, i < 12, 'sending stays true while draining');
        }
        assert.deepEqual(b.sent, Array.from({ length: 13 }, function (x, i) { return 'm' + i; }));
        assert.equal(b.m.agent.sending, false);
        b.viewers.forEach(function (v) { assert.equal(v.resumes, 1); assert.equal(v.paused, false); assert.equal(v.pauses, 1); });
    });
    await t.test('disconnect during pending send', function () {
        const b = build();
        b.m.sendToAgent('m0');
        b.m.sendToAgent('m1');
        b.m.agent = null;
        assert.doesNotThrow(function () { b.callbacks[0](); });
        assert.deepEqual(b.sent, ['m0']);
        const b2 = build();
        b2.m.sendToAgent('m0');
        b2.m.viewers = null;
        assert.doesNotThrow(function () { b2.callbacks[0](); });
        assert.doesNotThrow(function () { b2.m.sendToAgent('late'); });
    });
});

test('relay-timer', async function () {
    const seg = extractBetween('webserver.js', 'relaySession.onclose = function (sessionId) {', 'setInterval(checkWebRelaySessionsTimeout, 10000); }');
    const created = [], cleared = [];
    const ctx = vm.createContext({
        Object: Object,
        webRelaySessions: {},
        webRelayCleanupTimer: null,
        checkWebRelaySessionsTimeout: function () { },
        setInterval: function (fn, ms) { assert.equal(ms, 10000); assert.equal(fn, ctx.checkWebRelaySessionsTimeout); const h = { id: created.length }; created.push(h); return h; },
        clearInterval: function (h) { cleared.push(h); },
        xrelaySessionId: null,
        relaySession: null
    });
    function open(id) {
        ctx.xrelaySessionId = id;
        ctx.relaySession = {};
        vm.runInContext(seg, ctx);
        return ctx.relaySession;
    }
    const s1 = open('s/h1');
    const s2 = open('s/h2');
    assert.equal(created.length, 1, 'one interval for two sessions');
    s1.onclose('s/h1');
    assert.deepEqual(cleared, [], 'no clear while a session remains');
    assert.ok(ctx.webRelayCleanupTimer === created[0]);
    s2.onclose('s/h2');
    assert.equal(cleared.length, 1);
    assert.ok(cleared[0] === created[0], 'clears the created handle');
    assert.equal(ctx.webRelayCleanupTimer, null);
    open('s/h3');
    assert.equal(created.length, 2, 'new session starts exactly one new interval');
    assert.ok(ctx.webRelayCleanupTimer === created[1]);
});
