'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const yauzl = require('yauzl');
const pluginModule = require('../pluginHandler.js');
const { safePluginEntryPath, isValidPluginId } = pluginModule;

const tick = function () { return new Promise(function (resolve) { setTimeout(resolve, 25); }); };
const symlinkAttrs = (0o120777 << 16) >>> 0;
const fileAttrs = function (mode) { return ((0o100000 | mode) << 16) >>> 0; };

const DEMO_SRC = "module.exports.demo = function (parent) { globalThis.__pluginTestLog.push('load'); return { exports: [], server_startup: function () { globalThis.__pluginTestLog.push('startup'); } }; };";

// Builds a real pluginHandler over a temporary data path with https.get, yauzl.open and plugin-directory writes under test control.
// cfg.responses(opts, n): { statusCode, headers } for the nth https request (default 200).
// cfg.entries: [{ fileName, data, externalFileAttributes }]. cfg.hold: 'hold' withholds every plugin file 'finish' until released.
function setup(t, cfg) {
    cfg = cfg || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-test-'));
    t.after(function () {
        Object.keys(require.cache).forEach(function (k) { if (k.startsWith(dir)) delete require.cache[k]; });
        fs.rmSync(dir, { recursive: true, force: true });
    });
    t.mock.method(console, 'log', function () { });
    globalThis.__pluginTestLog = [];

    const plugin = Object.assign({ _id: 'plugin/1', shortName: 'demo', repository: { type: 'git' }, downloadUrl: 'https://example.com/dl/demo.zip' }, cfg.plugin);
    const h = { dir: dir, gets: [], created: [], held: [], status: [], updates: [], deleted: 0, cbCalls: [], zipEnded: false, zipClosed: false, hold: cfg.hold, log: globalThis.__pluginTestLog };
    const parent = {
        path: path,
        datapath: dir,
        config: { settings: { plugins: { list: [] } } },
        updateMeshCore: function () { },
        db: {
            getPlugin: function (id, cb) { cb(null, [plugin]); },
            setPluginStatus: function (id, s, cb) { h.status.push(s); if (cb) cb(); },
            updatePlugin: function (id, conf, cb) { h.updates.push(conf); if (cb) cb(); },
            deletePlugin: function (id, cb) { h.deleted++; if (cb) cb(); }
        }
    };
    h.obj = pluginModule.pluginHandler(parent);
    h.pluginDir = path.join(dir, 'plugins', plugin.shortName);

    h.obj.fs = Object.assign({}, fs, {
        createWriteStream: function (p, o) {
            if (!p.startsWith(h.pluginDir + path.sep)) return fs.createWriteStream(p, o);
            h.created.push({ path: p, options: o });
            const bufs = [];
            return new Writable({
                write: function (chunk, enc, cb) { bufs.push(chunk); cb(); },
                final: function (cb) {
                    const done = function (e) { if (e) return cb(e); fs.writeFileSync(p, Buffer.concat(bufs)); cb(); };
                    if (h.hold) h.held.push(done); else done();
                }
            });
        }
    });

    t.mock.method(https, 'get', function (opts, cb) {
        h.gets.push(opts);
        const n = h.gets.length;
        const spec = Object.assign({ statusCode: 200, headers: {} }, cfg.responses ? cfg.responses(opts, n) : {});
        const req = new EventEmitter();
        req.setTimeout = function () { };
        req.destroy = function () { };
        process.nextTick(function () {
            const res = new PassThrough();
            res.statusCode = spec.statusCode;
            res.headers = spec.headers;
            cb(res);
            res.end('not-a-real-zip');
        });
        return req;
    });

    t.mock.method(yauzl, 'open', function (fileName, opts, cb) {
        const zip = new EventEmitter();
        const entries = (cfg.entries || []).slice();
        let i = 0;
        zip.readEntry = function () {
            setImmediate(function () {
                if (i < entries.length) { zip.emit('entry', entries[i++]); } else { h.zipEnded = true; zip.emit('end'); }
            });
        };
        zip.openReadStream = function (entry, cb2) {
            const rs = new PassThrough();
            rs.end(entry.data == null ? '' : entry.data);
            cb2(null, rs);
        };
        zip.close = function () { if (h.zipClosed) return; h.zipClosed = true; setImmediate(function () { zip.emit('close'); }); };
        h.zip = zip;
        if (cfg.openError) return cb(new Error('bad zip'));
        cb(null, zip);
    });

    h.install = function (versionOnly, forceUrl) {
        return new Promise(function (resolve) {
            h.obj.installPlugin('plugin/1', versionOnly, forceUrl, function (err) { h.cbCalls.push(err); resolve(err); });
        });
    };
    return h;
}

const goodEntries = [
    { fileName: 'repo/', externalFileAttributes: 0 },
    { fileName: 'repo/demo.js', data: DEMO_SRC, externalFileAttributes: fileAttrs(0o755) },
    { fileName: 'repo/lib/', externalFileAttributes: 0 },
    { fileName: 'repo/lib/x.txt', data: 'x', externalFileAttributes: 0 },
    { fileName: 'repo/config.json', data: '{"name":"Demo"}', externalFileAttributes: 0 }
];

test('safePluginEntryPath keeps contained paths and strips one wrapper directory', function () {
    const root = path.resolve('/srv/plugins/demo');
    assert.strictEqual(safePluginEntryPath(root, 'repo/demo.js'), path.join(root, 'demo.js'));
    assert.strictEqual(safePluginEntryPath(root, 'repo/views/a/b.html'), path.join(root, 'views', 'a', 'b.html'));
    assert.strictEqual(safePluginEntryPath(root, 'config.json'), path.join(root, 'config.json'));
    assert.strictEqual(safePluginEntryPath(root, 'repo/'), root);
    assert.strictEqual(safePluginEntryPath(root, 'repo/sub/'), path.join(root, 'sub'));
    assert.strictEqual(safePluginEntryPath(root, 'repo/a..b/c'), path.join(root, 'a..b', 'c'));
});

test('safePluginEntryPath rejects unsafe names', function () {
    const root = path.resolve('/srv/plugins/demo');
    [
        '../x', 'repo/../../x', 'repo/..', '..', 'a/b/../../../x',
        '/etc/passwd', '//server/share/x', 'C:/x', 'c:\\x', 'C:x',
        'repo\\..\\x', 'repo\\x', '\\\\server\\share\\x', 'repo/a\0b', '', null, undefined
    ].forEach(function (name) {
        assert.throws(function () { safePluginEntryPath(root, name); }, Error, 'should reject ' + JSON.stringify(name));
    });
});

test('isValidPluginId accepts only 1-64 safe characters', function () {
    ['demo', 'Demo_Plugin-2', 'a', 'A'.repeat(64)].forEach(function (n) { assert.strictEqual(isValidPluginId(n), true, n); });
    ['', 'A'.repeat(65), '../x', 'a/b', 'a.b', 'a b', 'a\0', 'a\\b', null, undefined, 5, {}].forEach(function (n) { assert.strictEqual(isValidPluginId(n), false, String(n)); });
});

test('isValidConfig rejects malformed config and bad identifiers without throwing', function (t) {
    const h = setup(t);
    const good = { name: 'n', shortName: 'demo', version: '1', description: 'd', hasAdminPanel: false, homepage: 'h', changelogUrl: 'c', configUrl: 'u', repository: { type: 'git', url: 'x' }, meshCentralCompat: '>0', downloadUrl: 'https://example.com/a.zip' };
    assert.strictEqual(h.obj.isValidConfig(good), true);
    assert.strictEqual(h.obj.isValidConfig(Object.assign({}, good, { shortName: '../x' })), false);
    assert.strictEqual(h.obj.isValidConfig(Object.assign({}, good, { repository: null })), false);
    assert.strictEqual(h.obj.isValidConfig({}), false);
    assert.strictEqual(h.obj.isValidConfig(null), false);
});

test('install extracts nested files, honors modes, loads once after every finish', async function (t) {
    const h = setup(t, { entries: goodEntries });
    const err = await h.install(null, null);
    assert.strictEqual(err, null);
    await tick();
    assert.strictEqual(h.cbCalls.length, 1);
    assert.deepStrictEqual(h.log, ['load', 'startup']);
    assert.strictEqual(fs.readFileSync(path.join(h.pluginDir, 'lib', 'x.txt'), 'utf8'), 'x');
    assert.deepStrictEqual(h.status, [1]);
    if (process.platform != 'win32') {
        assert.strictEqual(h.created.find(function (c) { return c.path.endsWith('demo.js'); }).options.mode, 0o755);
        assert.strictEqual(h.created.find(function (c) { return c.path.endsWith('x.txt'); }).options.mode, 0o644);
    }
    assert.ok(h.updates.some(function (u) { return u.name === 'Demo'; }), 'config.json pushed to db');
});

test('install with a version records the version', async function (t) {
    const h = setup(t, { entries: goodEntries });
    const err = await h.install({ url: 'https://example.com/v.zip', name: '2.0' }, null);
    assert.strictEqual(err, null);
    assert.ok(h.updates.some(function (u) { return u.status === 1 && u.version === '2.0'; }));
    assert.strictEqual(h.gets[0].path, '/v.zip');
});

test('ZIP end alone does not load: withheld finish blocks completion until released', async function (t) {
    const h = setup(t, { entries: goodEntries, hold: 'hold' });
    const p = h.install(null, null);
    while (!h.zipEnded) await tick();
    await tick();
    assert.ok(h.held.length >= 2, 'destination streams are still finishing');
    assert.deepStrictEqual(h.log, []);
    assert.deepStrictEqual(h.status, []);
    assert.strictEqual(h.cbCalls.length, 0);
    h.held.splice(0, h.held.length - 1).forEach(function (done) { done(); });
    await tick();
    assert.deepStrictEqual(h.log, [], 'one stream still pending');
    assert.strictEqual(h.cbCalls.length, 0);
    h.held.pop()();
    assert.strictEqual(await p, null);
    await tick();
    assert.strictEqual(h.cbCalls.length, 1);
    assert.deepStrictEqual(h.log, ['load', 'startup']);
});

test('a write error after ZIP end never loads or reports success', async function (t) {
    const h = setup(t, { entries: goodEntries, hold: 'hold' });
    const p = h.install(null, null);
    while (!h.zipEnded) await tick();
    await tick();
    const pending = h.held.slice();
    h.held.length = 0;
    pending[0](new Error('disk full'));
    const err = await p;
    assert.match(err.message, /disk full/);
    pending.slice(1).forEach(function (done) { try { done(); } catch (e) { } });
    await tick();
    assert.strictEqual(h.cbCalls.length, 1);
    assert.deepStrictEqual(h.log, []);
    assert.deepStrictEqual(h.status, []);
});

test('archive read error fails once without loading', async function (t) {
    const h = setup(t, { entries: goodEntries, hold: 'hold' });
    const p = h.install(null, null);
    while (!h.zipEnded) await tick();
    h.zip.emit('error', new Error('corrupt zip'));
    h.zip.emit('error', new Error('again'));
    const err = await p;
    assert.match(err.message, /corrupt zip/);
    await tick();
    assert.strictEqual(h.cbCalls.length, 1);
    assert.deepStrictEqual(h.log, []);
    assert.deepStrictEqual(h.status, []);
});

test('yauzl open failure fails once', async function (t) {
    const h = setup(t, { openError: true });
    const err = await h.install(null, null);
    assert.match(err.message, /bad zip/);
    await tick();
    assert.strictEqual(h.cbCalls.length, 1);
    assert.deepStrictEqual(h.status, []);
});

const hostile = [
    ['parent traversal', 'repo/../../evil.js', 0],
    ['bare traversal', '../evil.js', 0],
    ['absolute path', '/tmp/evil.js', 0],
    ['windows drive', 'C:/evil.js', 0],
    ['windows UNC', '\\\\server\\share\\evil.js', 0],
    ['backslash traversal', 'repo\\..\\..\\evil.js', 0],
    ['NUL byte', 'repo/ev\0il.js', 0],
    ['symlink entry', 'repo/link', symlinkAttrs],
    ['file mapped to plugin root', 'repo/.', 0]
];
hostile.forEach(function (c) {
    test('extraction rejects ' + c[0] + ' with one failure and no writes outside the root', async function (t) {
        const h = setup(t, { entries: [{ fileName: 'repo/', externalFileAttributes: 0 }, { fileName: 'repo/ok.js', data: DEMO_SRC, externalFileAttributes: 0 }, { fileName: c[1], data: 'evil', externalFileAttributes: c[2] }] });
        const err = await h.install(null, null);
        assert.ok(err instanceof Error);
        await tick();
        assert.strictEqual(h.cbCalls.length, 1);
        assert.deepStrictEqual(h.log, []);
        assert.deepStrictEqual(h.status, []);
        assert.ok(h.created.every(function (w) { return w.path.startsWith(h.pluginDir + path.sep); }));
        assert.ok(!h.created.some(function (w) { return /evil/.test(w.path) || /link$/.test(w.path); }));
        assert.ok(!fs.existsSync(path.join(h.dir, 'evil.js')));
        assert.ok(!fs.existsSync(path.join(h.dir, 'plugins', 'evil.js')));
        assert.ok(!fs.existsSync(path.join(path.dirname(h.dir), 'evil.js')));
    });
});

test('extraction rejects a symlink entry even with a harmless name', async function (t) {
    const h = setup(t, { entries: [{ fileName: 'repo/harmless.txt', data: 'x', externalFileAttributes: symlinkAttrs }] });
    const err = await h.install(null, null);
    assert.match(err.message, /[Ss]ymlink/);
    assert.strictEqual(h.created.length, 0);
});

test('install rejects an invalid stored identifier before any request', async function (t) {
    const h = setup(t, { plugin: { shortName: '../escape' }, entries: goodEntries });
    const err = await h.install(null, null);
    assert.match(err.message, /identifier/);
    assert.strictEqual(h.gets.length, 0);
    assert.strictEqual(h.cbCalls.length, 1);
});

test('removePlugin rejects invalid identifiers before rmSync or deletePlugin', function (t) {
    ['../../etc', '..', '', 'a/b', 'a\\b', 'x'.repeat(65)].forEach(function (name) {
        const h = setup(t, { plugin: { shortName: name } });
        const rm = t.mock.method(h.obj.fs, 'rmSync', function () { });
        let got;
        h.obj.removePlugin('plugin/1', function (e) { got = e; });
        assert.ok(got instanceof Error, JSON.stringify(name));
        assert.strictEqual(rm.mock.callCount(), 0);
        assert.strictEqual(h.deleted, 0);
    });
});

test('removePlugin removes a valid plugin directory and record', function (t) {
    const h = setup(t);
    fs.mkdirSync(h.pluginDir, { recursive: true });
    fs.writeFileSync(path.join(h.pluginDir, 'a.js'), 'x');
    h.obj.removePlugin('plugin/1', function () { });
    assert.ok(!fs.existsSync(h.pluginDir));
    assert.strictEqual(h.deleted, 1);
});

test('install refuses a non-HTTPS initial URL without a request', async function (t) {
    const h = setup(t, { entries: goodEntries });
    const err = await h.install(null, 'http://example.com/a.zip');
    assert.match(err.message, /HTTPS/);
    assert.strictEqual(h.gets.length, 0);
    const h2 = setup(t, { entries: goodEntries });
    assert.ok(await h2.install(null, 'not a url') instanceof Error);
    assert.strictEqual(h2.gets.length, 0);
});

test('install preserves the query string on the request', async function (t) {
    const h = setup(t, { entries: goodEntries });
    await h.install(null, 'https://example.com:8443/dl/a.zip?token=a&b=c');
    assert.strictEqual(h.gets[0].path, '/dl/a.zip?token=a&b=c');
    assert.strictEqual(h.gets[0].host, 'example.com');
    assert.strictEqual(String(h.gets[0].port), '8443');
});

test('install follows a same-host relative redirect and keeps its query', async function (t) {
    const h = setup(t, {
        entries: goodEntries,
        responses: function (opts, n) { return n == 1 ? { statusCode: 302, headers: { location: '/real/a.zip?x=1' } } : {}; }
    });
    assert.strictEqual(await h.install(null, null), null);
    assert.strictEqual(h.gets.length, 2);
    assert.strictEqual(h.gets[1].path, '/real/a.zip?x=1');
    assert.strictEqual(h.gets[1].host, 'example.com');
});

[
    ['cross-host', 'https://evil.example.net/a.zip'],
    ['HTTPS to HTTP downgrade', 'http://example.com/a.zip'],
    ['cross-port', 'https://example.com:8443/a.zip'],
    ['malformed Location', 'https://[bad'],
    ['protocol-relative cross-host', '//evil.example.net/a.zip']
].forEach(function (c) {
    test('redirect rejected: ' + c[0], async function (t) {
        const h = setup(t, { entries: goodEntries, responses: function () { return { statusCode: 301, headers: { location: c[1] } }; } });
        const err = await h.install(null, null);
        assert.ok(err instanceof Error);
        assert.strictEqual(h.gets.length, 1, 'disallowed request must not be issued');
        assert.strictEqual(h.cbCalls.length, 1);
        assert.deepStrictEqual(h.log, []);
    });
});

test('redirect without Location fails', async function (t) {
    const h = setup(t, { responses: function () { return { statusCode: 302, headers: {} }; } });
    assert.ok(await h.install(null, null) instanceof Error);
    assert.strictEqual(h.gets.length, 1);
});

test('same-host redirect loop stops after five redirects', async function (t) {
    const h = setup(t, { entries: goodEntries, responses: function () { return { statusCode: 302, headers: { location: '/loop.zip' } }; } });
    const err = await h.install(null, null);
    assert.match(err.message, /redirect/i);
    assert.strictEqual(h.gets.length, 6);
    assert.strictEqual(h.cbCalls.length, 1);
});

test('non-success HTTP status fails without extracting', async function (t) {
    const h = setup(t, { entries: goodEntries, responses: function () { return { statusCode: 404 }; } });
    const err = await h.install(null, null);
    assert.match(err.message, /404/);
    assert.strictEqual(h.created.length, 0);
    assert.deepStrictEqual(h.status, []);
});

test('startup skips invalid identifiers from the database and the manual list', function (t) {
    t.mock.method(console, 'log', function () { });
    const probed = [];
    const real = fs.existsSync;
    t.mock.method(fs, 'existsSync', function (p) { probed.push(String(p)); return real(p); });
    const base = { path: path, datapath: '/nonexistent-mc-test', updateMeshCore: function () { } };

    pluginModule.pluginHandler(Object.assign({}, base, {
        config: { settings: { plugins: {} } },
        db: { getPluginPermissions: function (name, cb) { cb(null, []); }, getPlugins: function (cb) { cb(null, [{ _id: 'a', status: 1, shortName: '../../x' }, { _id: 'b', status: 1, shortName: 'a/b' }]); } }
    }));
    pluginModule.pluginHandler(Object.assign({}, base, { config: { settings: { plugins: { list: ['../../y', 5, null] } } }, db: { getPluginPermissions: function (name, cb) { cb(null, []); } } }));
    assert.deepStrictEqual(probed.filter(function (p) { return p.indexOf('nonexistent-mc-test') >= 0; }), []);
});
