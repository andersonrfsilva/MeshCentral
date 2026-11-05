'use strict';

// Integration TLS policy: Firebase relay, URL SMS gateway and IP KVM (appliance + MeshCentral loopback).
// Runtime tests replace the https/http request functions and the 'ws' module with fakes and inspect the
// options the real module code builds. No network, no real configuration.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const firebase = require('../firebase.js');
const meshsms = require('../meshsms.js');
const meshipkvm = require('../meshipkvm.js');

const PEM = '-----BEGIN CERTIFICATE-----\nc3ludGhldGljLWNhLWJ5dGVz\n-----END CERTIFICATE-----\n';
const restores = [];
const tmpDirs = [];

test.afterEach(function () {
    while (restores.length) { restores.pop()(); }
    while (tmpDirs.length) { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); }
});

function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc015-'));
    tmpDirs.push(d);
    return d;
}

function patch(target, key, value) {
    const original = target[key];
    target[key] = value;
    restores.push(function () { target[key] = original; });
}

// Capture console.log so configuration diagnostics stay out of the test output and can be inspected.
function captureConsole() {
    const lines = [];
    patch(console, 'log', function () { lines.push(Array.from(arguments).join(' ')); });
    return lines;
}

// Fake request object returned by the faked https/http request functions.
function fakeRequest() {
    const req = new EventEmitter();
    req.write = function () { };
    req.end = function () { };
    return req;
}

function fakeRequests(mod) {
    const calls = [];
    patch(mod, 'request', function (options) { calls.push(options); return fakeRequest(); });
    return calls;
}

// Replace the 'ws' module with a recording constructor.
function fakeWs() {
    const calls = [];
    class FakeWebSocket extends EventEmitter {
        constructor(url, options) { super(); this.url = url; this.options = options; calls.push({ url: url, options: options }); }
        send() { }
        close() { }
    }
    const key = require.resolve('ws');
    const original = require.cache[key];
    require.cache[key] = { id: key, filename: key, loaded: true, exports: FakeWebSocket };
    restores.push(function () { require.cache[key] = original; });
    return calls;
}

function cert(commonName, altnames) {
    const c = { subject: { CN: commonName } };
    if (altnames) { c.subjectaltname = altnames; }
    return c;
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const schema = JSON.parse(fs.readFileSync(path.join(root, 'meshcentral-config-schema.json'), 'utf8'));

test('schema: firebaserelay declares url, key, log, tlsverify (default true) and ca', function () {
    const p = schema.properties.firebaserelay.properties;
    assert.equal(p.url.type, 'string');
    assert.equal(p.key.type, 'string');
    assert.equal(p.log.type, 'boolean');
    assert.equal(p.tlsverify.type, 'boolean');
    assert.equal(p.tlsverify.default, true);
    assert.equal(p.ca.type, 'string');
});

test('schema: SMS url variant declares tlsverify (default true) and ca, SDK providers do not', function () {
    const variants = schema.properties.sms.anyOf || schema.properties.sms.oneOf;
    const urlVariant = variants.find(function (v) { return v.properties.provider.enum[0] == 'url'; });
    assert.equal(urlVariant.properties.tlsverify.type, 'boolean');
    assert.equal(urlVariant.properties.tlsverify.default, true);
    assert.equal(urlVariant.properties.ca.type, 'string');
    for (const v of variants) { if (v !== urlVariant) { assert.equal(v.properties.tlsverify, undefined); assert.equal(v.properties.ca, undefined); } }
});

test('schema: domain ipkvm accepts boolean (default false) or an object with tlsverify and ca', function () {
    const domainProps = findIpkvm(schema);
    assert.deepEqual(domainProps.type.slice().sort(), ['boolean', 'object']);
    assert.equal(domainProps.default, false);
    assert.equal(domainProps.properties.tlsverify.type, 'boolean');
    assert.equal(domainProps.properties.tlsverify.default, true);
    assert.equal(domainProps.properties.ca.type, 'string');
});

function findIpkvm(node) {
    if ((node == null) || (typeof node != 'object')) { return null; }
    if ((node.ipkvm != null) && (typeof node.ipkvm == 'object') && (node.ipkvm.type != null)) { return node.ipkvm; }
    for (const k of Object.keys(node)) { const r = findIpkvm(node[k]); if (r) { return r; } }
    return null;
}

test('meshcentral.js enables IP KVM for true or a non-null object only', function () {
    const src = fs.readFileSync(path.join(root, 'meshcentral.js'), 'utf8');
    const line = src.split('\n').find(function (l) { return l.indexOf('ipKvmSupport = true') >= 0; });
    assert.ok(line, 'enable check present');
    assert.match(line, /ipkvm === true/);
    assert.match(line, /typeof obj\.config\.domains\[i\]\.ipkvm == 'object'/);
    assert.match(line, /ipkvm !== null/);
});

// ---------------------------------------------------------------------------------------------
// Policy resolution (same contract in each integration module)
// ---------------------------------------------------------------------------------------------

for (const [name, mod] of [['firebase', firebase], ['meshsms', meshsms], ['meshipkvm', meshipkvm]]) {
    test(name + ' getTlsOptions: verifies when unset, true, null or not a boolean', function () {
        for (const config of [undefined, null, {}, { tlsverify: true }, { tlsverify: null }, { tlsverify: 'false' }, { tlsverify: 0 }, { tlsverify: 'no' }]) {
            const o = mod.getTlsOptions(config, os.tmpdir());
            assert.equal(o.rejectUnauthorized, true, JSON.stringify(config));
            assert.equal(o.ca, undefined);
        }
    });

    test(name + ' getTlsOptions: only boolean false opts out', function () {
        assert.equal(mod.getTlsOptions({ tlsverify: false }, os.tmpdir()).rejectUnauthorized, false);
    });

    test(name + ' getTlsOptions: relative CA resolves against the data folder, absolute stays absolute', function () {
        const dir = tmpDir(), other = tmpDir();
        fs.writeFileSync(path.join(dir, 'ca.pem'), PEM);
        fs.writeFileSync(path.join(other, 'abs.pem'), PEM + PEM);
        const rel = mod.getTlsOptions({ ca: 'ca.pem' }, dir);
        assert.equal(rel.rejectUnauthorized, true); // A CA is never an opt-out
        assert.deepEqual(rel.ca, Buffer.from(PEM));
        const abs = mod.getTlsOptions({ ca: path.join(other, 'abs.pem') }, dir);
        assert.deepEqual(abs.ca, Buffer.from(PEM + PEM));
        assert.equal(mod.getTlsOptions({ ca: 'ca.pem', tlsverify: false }, dir).rejectUnauthorized, false);
    });

    test(name + ' getTlsOptions: unreadable or invalid CA throws a generic error', function () {
        const dir = tmpDir();
        for (const ca of ['missing-secret-name.pem', dir, '', 5, {}]) {
            assert.throws(function () { mod.getTlsOptions({ ca: ca }, dir); }, function (err) {
                assert.ok(err instanceof Error);
                assert.doesNotMatch(err.message, /missing-secret-name|ENOENT|EISDIR/);
                assert.doesNotMatch(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
                return true;
            });
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Firebase relay
// ---------------------------------------------------------------------------------------------

function firebaseParent(config, datapath) {
    return {
        config: { firebaserelay: config },
        datapath: datapath,
        path: path,
        fs: fs,
        debug: function () { },
        webserver: { agentCertificateHashBase64: 'hash' },
        db: { Get: function (id, f) { f(null, []); } }
    };
}

test('firebase wss relay: verifies by default and passes explicit false and CA bytes to ws', function () {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ca.pem'), PEM);
    const wsCalls = fakeWs();

    let relay = firebase.CreateFirebaseRelay(firebaseParent(undefined, dir), 'wss://relay.example.invalid/fb', 'k');
    assert.equal(wsCalls.length, 1);
    assert.equal(wsCalls[0].options.rejectUnauthorized, true);
    assert.equal(wsCalls[0].options.ca, undefined);
    assert.equal(wsCalls[0].url, 'wss://relay.example.invalid/fb?key=k');
    relay.wsclient.emit('close'); clearTimeout(relay.reconnectTimer);

    relay = firebase.CreateFirebaseRelay(firebaseParent({ tlsverify: false }, dir), 'wss://relay.example.invalid/fb');
    assert.equal(wsCalls[1].options.rejectUnauthorized, false);
    relay.wsclient.emit('close'); clearTimeout(relay.reconnectTimer);

    relay = firebase.CreateFirebaseRelay(firebaseParent({ ca: 'ca.pem' }, dir), 'wss://relay.example.invalid/fb');
    assert.equal(wsCalls[2].options.rejectUnauthorized, true);
    assert.deepEqual(wsCalls[2].options.ca, Buffer.from(PEM));
    relay.wsclient.emit('close'); clearTimeout(relay.reconnectTimer);
});

test('firebase wss relay: unreadable CA fails closed, no connection is created', function () {
    const dir = tmpDir();
    const wsCalls = fakeWs();
    const logs = captureConsole();
    const relay = firebase.CreateFirebaseRelay(firebaseParent({ ca: 'nope.pem', tlsverify: true }, dir), 'wss://relay.example.invalid/fb');
    relay.connectWebSocket();
    assert.equal(wsCalls.length, 0);
    assert.equal(relay.wsclient, undefined);
    let result = null;
    relay.sendToDevice({ _id: 'node//x', pmt: 'token' }, { data: {} }, {}, function (id, err) { result = err; });
    assert.equal(result, 'error');
    assert.ok(logs.some(function (l) { return l.indexOf('ERROR') >= 0; }));
    assert.ok(logs.every(function (l) { return l.indexOf(dir) < 0; }));
});

test('firebase https relay: POST honors default, explicit false, CA bytes, and fails closed on a bad CA', function () {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ca.pem'), PEM);
    const calls = fakeRequests(https);
    const send = function (relay) { relay.sendToDevice({ _id: 'node//x', pmt: 'token' }, { data: {} }, {}, function () { }); };

    send(firebase.CreateFirebaseRelay(firebaseParent(undefined, dir), 'https://relay.example.invalid/fb'));
    assert.equal(calls[0].rejectUnauthorized, true);
    send(firebase.CreateFirebaseRelay(firebaseParent({ tlsverify: false }, dir), 'https://relay.example.invalid/fb'));
    assert.equal(calls[1].rejectUnauthorized, false);
    send(firebase.CreateFirebaseRelay(firebaseParent({ ca: 'ca.pem' }, dir), 'https://relay.example.invalid/fb'));
    assert.equal(calls[2].rejectUnauthorized, true);
    assert.deepEqual(calls[2].ca, Buffer.from(PEM));

    captureConsole();
    let err = null;
    const bad = firebase.CreateFirebaseRelay(firebaseParent({ ca: 'nope.pem' }, dir), 'https://relay.example.invalid/fb');
    bad.sendToDevice({ _id: 'node//x', pmt: 'token' }, { data: {} }, {}, function (id, e) { err = e; });
    assert.equal(calls.length, 3);
    assert.equal(err, 'error');
});

// ---------------------------------------------------------------------------------------------
// SMS URL provider
// ---------------------------------------------------------------------------------------------

function smsParent(sms, datapath) {
    return { config: { sms: Object.assign({ provider: 'url', url: 'https://sms.example.invalid/send?to={{phone}}&m={{message}}' }, sms) }, datapath: datapath, debug: function () { } };
}

test('sms url provider: verifies by default, honors explicit false and CA bytes', function () {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'ca.pem'), PEM);
    const calls = fakeRequests(https);

    meshsms.CreateMeshSMS(smsParent({}, dir)).sendSMS('+15550100', 'hello', function () { });
    assert.equal(calls[0].rejectUnauthorized, true);
    assert.equal(calls[0].ca, undefined);
    assert.equal(calls[0].hostname, 'sms.example.invalid');

    meshsms.CreateMeshSMS(smsParent({ tlsverify: false }, dir)).sendSMS('+15550100', 'hello', function () { });
    assert.equal(calls[1].rejectUnauthorized, false);

    meshsms.CreateMeshSMS(smsParent({ ca: 'ca.pem' }, dir)).sendSMS('+15550100', 'hello', function () { });
    assert.equal(calls[2].rejectUnauthorized, true);
    assert.deepEqual(calls[2].ca, Buffer.from(PEM));
});

test('sms url provider: unreadable CA makes no request and reports failure', function () {
    const dir = tmpDir();
    const calls = fakeRequests(https);
    const logs = captureConsole();
    const sms = meshsms.CreateMeshSMS(smsParent({ ca: 'nope.pem' }, dir));
    assert.ok(sms, 'object is still created so callers keep working');
    let ok = null;
    sms.sendSMS('+15550100', 'hello', function (success) { ok = success; });
    assert.equal(calls.length, 0);
    assert.equal(ok, false);
    assert.ok(logs.some(function (l) { return l.indexOf('ERROR') >= 0; }));
});

test('sms url provider: plain http URL is unchanged', function () {
    const calls = fakeRequests(http);
    meshsms.CreateMeshSMS(smsParent({ url: 'http://sms.example.invalid/send?to={{phone}}&m={{message}}' }, os.tmpdir())).sendSMS('+15550100', 'hello', function () { });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rejectUnauthorized, undefined);
});

// ---------------------------------------------------------------------------------------------
// IP KVM
// ---------------------------------------------------------------------------------------------

function kvmParent(extra) {
    // "parent" of a manager is the IP KVM manager object, parent.parent is the MeshCentral server.
    const events = [];
    const server = {
        debug: function () { },
        DispatchEvent: function (a, b, e) { events.push(e); },
        encodeCookie: function () { return 'synthetic-cookie'; },
        loginCookieEncryptionKey: 'k',
        args: { port: 4430 },
        certificates: { CommonName: 'mesh.example.invalid' },
        config: { domains: { dom: { id: 'dom' } } }
    };
    Object.assign(server, extra);
    return { parent: server, events: events };
}

const policy = function (ca) { return { rejectUnauthorized: true, ca: ca }; };

function assertIdentity(options, expectedHost, otherHost) {
    assert.equal(typeof options.checkServerIdentity, 'function');
    assert.equal(options.checkServerIdentity('whatever', cert(expectedHost, 'DNS:' + expectedHost)), undefined);
    const mismatch = options.checkServerIdentity(expectedHost, cert(otherHost, 'DNS:' + otherHost));
    assert.ok(mismatch instanceof Error, 'mismatching certificate must return an Error');
}

test('ipkvm Raritan: connect and fetch verify the appliance hostname (direct) with SNI and CA', function () {
    const calls = fakeRequests(https);
    const ca = Buffer.from(PEM);
    const m = meshipkvm.CreateRaritanKX3Manager(kvmParent(), 'kvm.example.invalid', 443, 'user', 'pw', policy(ca));
    m.start();
    assert.equal(calls.length, 1); // POST /auth.asp
    const o = calls[0];
    assert.equal(o.rejectUnauthorized, true);
    assert.deepEqual(o.ca, ca);
    assert.equal(o.servername, 'kvm.example.invalid');
    assert.equal(o.hostname, 'kvm.example.invalid');
    assertIdentity(o, 'kvm.example.invalid', 'other.example.invalid');

    m.state = 2; // Connected, allow fetch
    m.fetch('/x', null, null, function () { });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].rejectUnauthorized, true);
    assert.deepEqual(calls[1].ca, ca);
    assert.equal(calls[1].servername, 'kvm.example.invalid');
    assertIdentity(calls[1], 'kvm.example.invalid', 'other.example.invalid');
    m.stop();
});

test('ipkvm Raritan: routed fetch connects to localhost but verifies the original appliance hostname', function () {
    const calls = fakeRequests(https);
    const m = meshipkvm.CreateRaritanKX3Manager(kvmParent(), 'kvm.example.invalid', 443, 'user', 'pw', policy());
    m.router = { tcpServerPort: 5555 };
    m.state = 2;
    m.fetch('/x', null, null, function () { });
    const o = calls[0];
    assert.equal(o.hostname, 'localhost');
    assert.equal(o.port, 5555);
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.servername, 'kvm.example.invalid');
    assertIdentity(o, 'kvm.example.invalid', 'localhost');
});

test('ipkvm Raritan: IP literal appliance omits SNI and verifies IP SANs', function () {
    const calls = fakeRequests(https);
    const m = meshipkvm.CreateRaritanKX3Manager(kvmParent(), '192.0.2.10', 443, 'user', 'pw', policy());
    m.start();
    assert.equal(calls[0].servername, '');
    assert.equal(calls[0].checkServerIdentity('192.0.2.10', { subject: { CN: 'x' }, subjectaltname: 'IP Address:192.0.2.10' }), undefined);
    assert.ok(calls[0].checkServerIdentity('192.0.2.10', { subject: { CN: 'x' }, subjectaltname: 'IP Address:192.0.2.11' }) instanceof Error);
    m.stop();
});

test('ipkvm Raritan: explicit opt-out reaches the request, a CA alone does not', function () {
    const calls = fakeRequests(https);
    const a = meshipkvm.CreateRaritanKX3Manager(kvmParent(), 'kvm.example.invalid', 443, 'u', 'p', { rejectUnauthorized: false });
    a.start();
    assert.equal(calls[0].rejectUnauthorized, false);
    a.stop();
    const b = meshipkvm.CreateRaritanKX3Manager(kvmParent(), 'kvm.example.invalid', 443, 'u', 'p', meshipkvm.getTlsOptions({ ca: 'x.pem' }, writeCaDir()));
    b.start();
    assert.equal(calls[1].rejectUnauthorized, true);
    b.stop();
});

function writeCaDir() {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'x.pem'), PEM);
    return dir;
}

test('ipkvm Raritan: appliance websocket verifies hostname, no hard-coded SNI', function () {
    const wsCalls = fakeWs();
    const ca = Buffer.from(PEM);
    const parent = kvmParent();
    const m = meshipkvm.CreateRaritanKX3Manager(parent, 'kvm.example.invalid', 443, 'user', 'pw', policy(ca));
    const clientWs = new EventEmitter();
    clientWs._socket = { pause: function () { } };
    clientWs.close = function () { };
    const reqinfo = { kvmport: { portid: 'p1', portNo: 1 }, domain: 'dom', userid: 'user//u', username: 'u', clientIp: '127.0.0.1', nodeid: 'node//n' };
    m.handleIpKvmWebSocket({ id: 'dom' }, reqinfo, clientWs, {});
    assert.equal(wsCalls.length, 1);
    assert.equal(wsCalls[0].url, 'wss://kvm.example.invalid:443/rfb');
    const o = wsCalls[0].options;
    assert.equal(o.rejectUnauthorized, true);
    assert.deepEqual(o.ca, ca);
    assert.equal(o.servername, 'kvm.example.invalid');
    assertIdentity(o, 'kvm.example.invalid', 'raritan');
});

test('ipkvm WebPowerSwitch: requests carry the same policy and appliance identity, routed or direct', function () {
    const calls = fakeRequests(http); // The WebPowerSwitch client module is plain http on port 80, options are applied for uniformity.
    const ca = Buffer.from(PEM);
    const m = meshipkvm.CreateWebPowerSwitch(kvmParent(), 'pdu.example.invalid', 80, 'user', 'pw', policy(ca));
    m.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rejectUnauthorized, true);
    assert.deepEqual(calls[0].ca, ca);
    assert.equal(calls[0].servername, 'pdu.example.invalid');
    assertIdentity(calls[0], 'pdu.example.invalid', 'other.example.invalid');
    m.router = { tcpServerPort: 6666, stop: function () { } };
    m.state = 2;
    m.fetch('/restapi/x', 'GET', null, null, function () { });
    assert.equal(calls[1].hostname, 'localhost');
    assertIdentity(calls[1], 'pdu.example.invalid', 'localhost');
    m.stop();
});

// MiniRouter: real loopback listener, fake websocket to MeshCentral.
function runRouter(parentExtra, tlsOptions, domainId) {
    const wsCalls = fakeWs();
    const parent = kvmParent(parentExtra);
    const router = meshipkvm.CreateMiniRouter(parent, 'node/' + (domainId || 'dom') + '/abc', 'kvm.example.invalid', 443, tlsOptions);
    return new Promise(function (resolve) {
        router.start(function (port) {
            const client = net.connect(port, 'localhost');
            client.on('error', function () { });
            // The server side 'connection' handler runs shortly after connect.
            const poll = setInterval(function () {
                if (wsCalls.length || router.tcpServer == null) { finish(); }
            }, 5);
            const timer = setTimeout(finish, 300);
            function finish() {
                clearInterval(poll); clearTimeout(timer);
                client.destroy();
                router.tcpServer.close(); // router.stop() is not used: it mishandles live connections.
                resolve(wsCalls);
            }
        });
    });
}

test('ipkvm MiniRouter: loopback websocket verifies the MeshCentral name (domain dns first), not the appliance', async function () {
    const ca = Buffer.from(PEM);
    const calls = await runRouter({ config: { domains: { dom: { id: 'dom', dns: 'dns.example.invalid' } } } }, policy(ca));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^wss:\/\/localhost:4430\/meshrelay\.ashx\?/);
    const o = calls[0].options;
    assert.equal(o.rejectUnauthorized, true);
    assert.deepEqual(o.ca, ca);
    assert.equal(o.servername, 'dns.example.invalid');
    assertIdentity(o, 'dns.example.invalid', 'kvm.example.invalid');
    assert.ok(o.checkServerIdentity('x', cert('localhost', 'DNS:localhost')) instanceof Error, 'localhost is not the identity');
});

test('ipkvm MiniRouter: loopback falls back to the server certificate CommonName', async function () {
    const calls = await runRouter({}, policy());
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^wss:\/\/localhost:4430\/dom\/meshrelay\.ashx\?/);
    assert.equal(calls[0].options.servername, 'mesh.example.invalid');
    assertIdentity(calls[0].options, 'mesh.example.invalid', 'kvm.example.invalid');
});

test('ipkvm MiniRouter: no determinable server name with verification on refuses to connect', async function () {
    const calls = await runRouter({ certificates: {} }, policy());
    assert.equal(calls.length, 0);
});

test('ipkvm MiniRouter: explicit opt-out connects without a name', async function () {
    const calls = await runRouter({ certificates: {} }, { rejectUnauthorized: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.rejectUnauthorized, false);
});

test('ipkvm MiniRouter: tlsoffload keeps the existing plain ws transport', async function () {
    const calls = await runRouter({ args: { port: 4430, tlsoffload: true } }, policy());
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^ws:\/\/localhost:4430\//);
});

// Manager level: the policy of the domain ipkvm setting flows to the real factories.
function runManager(ipkvm, datapath) {
    const calls = fakeRequests(https);
    const meshid = 'mesh/dom/abc';
    const mesh = { _id: meshid, mtype: 4, kvm: { host: 'kvm.example.invalid', model: 1, user: 'u', pass: 'p' } };
    const parent = {
        AddEventDispatch: function () { },
        datapath: datapath,
        config: { domains: { dom: { id: 'dom', ipkvm: ipkvm } } },
        webserver: { meshes: { [meshid]: mesh } },
        debug: function () { }
    };
    const manager = meshipkvm.CreateIPKVMManager(parent);
    const group = manager.managedGroups[meshid];
    if (group) { group.stop(); }
    return { calls: calls, group: group };
}

test('ipkvm manager: ipkvm true and an empty object both verify by default', function () {
    for (const ipkvm of [true, {}]) {
        const r = runManager(ipkvm, os.tmpdir());
        assert.ok(r.group);
        assert.equal(r.calls.length, 1);
        assert.equal(r.calls[0].rejectUnauthorized, true);
    }
});

test('ipkvm manager: object settings tlsverify false and relative ca reach the requests', function () {
    const off = runManager({ tlsverify: false }, os.tmpdir());
    assert.equal(off.calls[0].rejectUnauthorized, false);
    const dir = writeCaDir();
    const withCa = runManager({ ca: 'x.pem' }, dir);
    assert.equal(withCa.calls[0].rejectUnauthorized, true);
    assert.deepEqual(withCa.calls[0].ca, Buffer.from(PEM));
});

test('ipkvm manager: unreadable CA does not start the manager and never retries unverified', function () {
    const logs = captureConsole();
    const r = runManager({ ca: 'nope.pem' }, tmpDir());
    assert.equal(r.group, undefined);
    assert.equal(r.calls.length, 0);
    assert.ok(logs.some(function (l) { return l.indexOf('ERROR') >= 0; }));
});

// ---------------------------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------------------------

test('source: no certificate placeholder hook, no hard-coded raritan SNI, no verification bypass literal', function () {
    for (const f of ['meshipkvm.js', 'firebase.js', 'meshsms.js']) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        assert.doesNotMatch(src, /TODO: Certificate Check/, f);
        assert.doesNotMatch(src, /servername: 'raritan'/, f);
        assert.doesNotMatch(src, /rejectUnauthorized: false/, f);
    }
    const kvm = fs.readFileSync(path.join(root, 'meshipkvm.js'), 'utf8');
    assert.equal((kvm.match(/rejectUnauthorized: tlsOptions\.rejectUnauthorized/g) || []).length, 6); // 395, 423, 585, 663, 898 and the loopback
    assert.doesNotMatch(kvm, /function onCheckServerIdentity\(cert\)/);
});
