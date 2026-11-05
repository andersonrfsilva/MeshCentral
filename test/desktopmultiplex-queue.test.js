'use strict';

// Tests for the per-viewer pending byte bound in meshdesktopmultiplex.js.
// The multiplexer factory is private, so the real source is evaluated in a VM context and the identifier is read back.
// Image tests parse real PNG data with the installed image-size module and are skipped when that module is not installed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');

const sourceFile = path.join(__dirname, '..', 'meshdesktopmultiplex.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const moduleRequire = createRequire(sourceFile);
const hasImageSize = (function () { try { moduleRequire.resolve('image-size'); return true; } catch (ex) { return false; } })();
const imageOpts = { skip: hasImageSize ? false : 'image-size is not installed' };
const DEFAULT_LIMIT = 8388608;
const LIMIT_REASON = 'DesktopRelay: viewer queue byte limit exceeded';

// ---- Wire format builders ----

function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c = (crc ^ buf[i]) & 0xFF;
        for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

// A valid 1-bit grayscale PNG of exactly "total" bytes (an ancillary text chunk is used as padding).
function makePng(w, h, total) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 1; // 1 bit, color type 0
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.alloc((Math.ceil(w / 8) + 1) * h)));
    const parts = [sig, pngChunk('IHDR', ihdr), idat, pngChunk('IEND', Buffer.alloc(0))];
    const base = Buffer.concat(parts).length;
    if (total != null) {
        assert.ok(total >= base + 14, 'png total too small, need ' + (base + 14));
        parts.splice(2, 0, pngChunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(total - base - 12 - 2, 0x61)])));
    }
    const out = Buffer.concat(parts);
    assert.ok((total == null) || (out.length == total));
    return out;
}

// Agent tile command (3): x, y in pixels, PNG at offset 8. "total" is the exact wire length.
function tile(x, y, w, h, total) {
    const png = makePng(w, h, total == null ? null : total - 8), b = Buffer.alloc(8 + png.length);
    b.writeUInt16BE(3, 0); b.writeUInt16BE(b.length, 2); b.writeUInt16BE(x, 4); b.writeUInt16BE(y, 6);
    png.copy(b, 8);
    return b;
}

function sizeCmd(w, h) { const b = Buffer.alloc(8); b.writeUInt16BE(7, 0); b.writeUInt16BE(8, 2); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6); return b; }

// Agent message (17) of "size" bytes carrying a sequence number.
function ctl(seq, size) { const b = Buffer.alloc(size || 100); b.writeUInt16BE(17, 0); b.writeUInt16BE(b.length, 2); b.writeUInt32BE(seq, 4); return b; }
function ctlSeq(data) { return (Buffer.isBuffer(data) && (data.length >= 8) && (data.readUInt16BE(0) == 17)) ? data.readUInt32BE(4) : null; }

// Jumbo wrapper: 8 byte header, the command, zero padding up to an 8 byte boundary.
function jumbo(inner) {
    const b = Buffer.alloc(Math.ceil((8 + inner.length) / 8) * 8);
    b.writeUInt16BE(27, 0); b.writeUInt16BE(8, 2); b.writeUInt32BE(inner.length, 4);
    inner.copy(b, 8);
    return b;
}

// ---- Fixture around the real factory ----

function byteLength(data) { return (typeof data == 'string') ? Buffer.byteLength(data, 'utf8') : data.length; }

function createFixture(opts) {
    opts = opts || {};
    const timers = [];
    let timerId = 0;
    const ctx = vm.createContext({
        module: { exports: {} }, exports: {}, Buffer: Buffer, console: { log: function () { } }, Date: Date, require: moduleRequire,
        setTimeout: function (fn, ms) { const t = { id: ++timerId, fn: fn, ms: ms, cleared: false, fired: false }; timers.push(t); return t; },
        clearTimeout: function (t) { if (t) { t.cleared = true; } }
    });
    vm.runInContext(source, ctx, { filename: sourceFile });
    const factory = vm.runInContext('CreateDesktopMultiplexor', ctx);
    assert.equal(typeof factory, 'function');
    assert.equal(typeof ctx.module.exports.CreateMeshRelay, 'function');

    const debugs = [], events = [];
    const parent = {
        trafficStats: { desktopMultiplex: { sessions: 0 } },
        db: { Get: function (id, cb) { cb(null, [{ _id: id, meshid: 'mesh/test/group', icon: 1, name: 'fixture' }]); } },
        users: {}, wsagents: {}, meshes: {}, userGroups: {},
        parent: { debug: function (category, message) { debugs.push({ category: category, message: message }); }, DispatchEvent: function (targets, source, event) { events.push(event); } }
    };
    const domain = { id: 'test', sessionrecording: false };
    if (opts.limit !== undefined) { domain.desktopmultiplex = (opts.limit === 'omit') ? {} : { maxviewerqueuebytes: opts.limit }; }
    if (opts.desktopmultiplex !== undefined) { domain.desktopmultiplex = opts.desktopmultiplex; }

    let mux = null;
    factory(parent, domain, 'node/test/device', 'test-session', function (m) { mux = m; });
    assert.ok(mux, 'factory callback runs synchronously with the fake db');

    const fx = { mux: mux, parent: parent, domain: domain, debugs: debugs, events: events, timers: timers, viewers: [], agent: null };

    function makeWs() {
        const ws = { sent: [], held: [], bufferedAmount: 0, mode: 'hold', throwOnSend: false, pauseCount: 0, resumeCount: 0 };
        ws._socket = { bytesRead: 0, bytesWritten: 0, pause: function () { ws.pauseCount++; }, resume: function () { ws.resumeCount++; } };
        ws.send = function (data, cb) {
            if (ws.throwOnSend) { throw new Error('send failed'); }
            ws.sent.push(data);
            if (ws.mode == 'sync') { cb(); } else { ws.held.push({ cb: cb, bytes: byteLength(data) }); }
        };
        ws.heldBytes = function () { return ws.held.reduce(function (a, h) { return a + h.bytes; }, 0); };
        // Complete held sends in order; n = how many, default all (including sends started by the completions).
        ws.pump = function (n, err) { let i = 0; while (ws.held.length && ((n == null) || (i < n))) { ws.held.shift().cb(err); i++; } return i; };
        return ws;
    }

    function makePeer(ws, query, user) {
        const peer = { req: { query: query }, ws: ws, viewOnly: false, closeCalls: 0, closed: false };
        if (user) { peer.user = user; }
        peer.close = function () { if (peer.closed) return; peer.closed = true; peer.closeCalls++; mux.removePeer(peer); };
        return peer;
    }

    // Viewers must be added before the agent. The join handshake is drained so tests start from an idle viewer.
    fx.addViewer = function (name, query, noDrain) {
        const ws = makeWs();
        const peer = makePeer(ws, Object.assign({ browser: 1 }, query), { _id: 'user/test/' + name, name: 'fixture' });
        peer.name = name;
        mux.addPeer(peer);
        fx.viewers.forEach(function (v) { v.ws.pump(); });
        if (!noDrain) { ws.pump(); }
        fx.viewers.push(peer);
        return peer;
    };
    fx.addAgent = function () {
        const ws = makeWs();
        ws.mode = 'sync';
        fx.agent = makePeer(ws, {}, null);
        mux.addPeer(fx.agent);
        return fx.agent;
    };
    fx.settle = function () { fx.viewers.forEach(function (v) { if (v.ws) { v.ws.pump(); } }); };
    fx.agentData = function (data) { mux.processAgentData(data); };
    fx.limitCloses = function () { return debugs.filter(function (d) { return d.message.indexOf(LIMIT_REASON) >= 0; }); };

    // Independent recomputation of what a viewer still owes: unsent queue entries, in-flight payloads, unsent shared images.
    fx.expectedPending = function (v) {
        let total = v.ws.heldBytes();
        for (let i = v.sendQueueHead; i < v.sendQueue.length; i++) { total += byteLength(v.sendQueue[i]); }
        for (let p = v.dataPtr; p != null; p = mux.images[p].next) { total += mux.images[p].data.length; }
        return total;
    };
    fx.assertAccounting = function (v) {
        assert.equal(v.pendingBytes, fx.expectedPending(v));
        assert.equal(v.pendingBytes, v.queueBytes + v.inflightBytes + v.linkedBytes);
    };
    return fx;
}

// Two viewers (or one) and an agent, all handshakes drained.
function createSession(opts, names) {
    const fx = createFixture(opts);
    (names || ['healthy', 'slow']).forEach(function (n) { fx.addViewer(n); });
    fx.addAgent();
    fx.settle();
    return fx;
}

// ---- Tests ----

describe('viewer-config', function () {
    test('default limit is 8388608 bytes', function () {
        assert.equal(createFixture().mux.maxViewerQueueBytes, DEFAULT_LIMIT);
        assert.equal(createFixture({ limit: 'omit' }).mux.maxViewerQueueBytes, DEFAULT_LIMIT);
    });
    test('domain override is used', function () {
        assert.equal(createFixture({ limit: 4096 }).mux.maxViewerQueueBytes, 4096);
        assert.equal(createFixture({ limit: 1 }).mux.maxViewerQueueBytes, 1);
    });
    test('invalid values fall back to the default', function () {
        [0, -1, -4096, 1.5, '4096', Number.MAX_SAFE_INTEGER + 1, 2 ** 64, NaN, Infinity, null, true, {}].forEach(function (bad) {
            assert.equal(createFixture({ limit: bad }).mux.maxViewerQueueBytes, DEFAULT_LIMIT, String(bad));
        });
        // A boolean domain flag (the existing way to enable the multiplexer for a domain) keeps the default.
        assert.equal(createFixture({ desktopmultiplex: true }).mux.maxViewerQueueBytes, DEFAULT_LIMIT);
    });
    test('limit is read once per multiplexer', function () {
        const fx = createFixture({ limit: 4096 });
        fx.domain.desktopmultiplex.maxviewerqueuebytes = 10;
        assert.equal(fx.mux.maxViewerQueueBytes, 4096);
    });
    test('schema documents the domain object', function () {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'meshcentral-config-schema.json'), 'utf8'));
        const entry = schema.properties.domains.additionalProperties.properties.desktopMultiplex;
        assert.ok(entry.type.indexOf('object') >= 0);
        const prop = entry.properties.maxViewerQueueBytes;
        assert.equal(prop.type, 'integer');
        assert.equal(prop.minimum, 1);
        assert.equal(prop.default, DEFAULT_LIMIT);
        assert.equal(schema.properties.settings.properties.desktopMultiplex.type, 'boolean'); // Server level switch unchanged
    });
});

describe('viewer-bytes', function () {
    test('exact boundary is accepted, one byte more is rejected', function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.mux.sendToViewer(v, Buffer.alloc(4096));
        assert.equal(v.pendingBytes, 4096);
        assert.equal(v.closeCalls, 0);
        fx.mux.sendToViewer(v, Buffer.alloc(1));
        assert.equal(v.closeCalls, 1);
        assert.equal(fx.limitCloses().length, 1);
    });
    test('oversized first payload is never retained or sent', function () {
        const fx = createSession({ limit: 4096 }, ['healthy', 'slow']);
        const slow = fx.viewers[1], sentBefore = slow.ws.sent.length;
        fx.mux.sendToViewer(slow, Buffer.alloc(4097));
        assert.equal(slow.closeCalls, 1);
        assert.equal(slow.ws.sent.length, sentBefore);
        assert.equal(slow.sendQueue, undefined);
        assert.equal(slow.pendingBytes, undefined);
        assert.equal(fx.viewers[0].closeCalls, 0);
    });
    test('strings count UTF-8 bytes', function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.mux.sendToViewer(v, '\u00e9'.repeat(2048)); // 2048 chars, 4096 bytes
        assert.equal(v.pendingBytes, 4096);
        assert.equal(v.closeCalls, 0);
        const fx2 = createSession({ limit: 4096 }, ['slow']);
        fx2.mux.sendToViewer(fx2.viewers[0], '\u00e9'.repeat(2049)); // 2049 chars, 4098 bytes
        assert.equal(fx2.viewers[0].closeCalls, 1);
        const fx3 = createSession({ limit: 4096 }, ['slow']);
        fx3.mux.sendToViewer(fx3.viewers[0], '\u20ac'.repeat(1366)); // 3 bytes each: 4098
        assert.equal(fx3.viewers[0].closeCalls, 1);
    });
    test('in-flight payload stays accounted until its callback', function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.mux.sendToViewer(v, Buffer.alloc(1000));
        assert.equal(v.inflightBytes, 1000);
        assert.equal(v.pendingBytes, 1000);
        fx.mux.sendToViewer(v, Buffer.alloc(500));
        assert.equal(v.queueBytes, 500);
        assert.equal(v.pendingBytes, 1500);
        fx.assertAccounting(v);
        v.ws.pump(1);
        assert.equal(v.inflightBytes, 500);
        assert.equal(v.queueBytes, 0);
        assert.equal(v.pendingBytes, 500);
        fx.assertAccounting(v);
        v.ws.pump();
        assert.equal(v.pendingBytes, 0);
        assert.equal(v.sending, false);
    });
    test('transport buffer and in-flight bytes overlap, they are not added', function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.mux.sendToViewer(v, Buffer.alloc(2000));
        v.ws.bufferedAmount = 2000; // the same bytes seen by the transport
        fx.mux.sendToViewer(v, Buffer.alloc(2000)); // max(2000, 2000) + 2000 = 4000: accepted
        assert.equal(v.closeCalls, 0);
        assert.equal(v.pendingBytes, 4000);
        fx.mux.sendToViewer(v, Buffer.alloc(96)); // exactly 4096
        assert.equal(v.closeCalls, 0);
        // A transport that holds more than we account for counts too.
        const fx2 = createSession({ limit: 4096 }, ['slow']);
        const w = fx2.viewers[0];
        w.ws.bufferedAmount = 3000;
        fx2.mux.sendToViewer(w, Buffer.alloc(1100));
        assert.equal(w.closeCalls, 1);
    });
    test('counters match an independent sum after every operation', function () {
        const fx = createSession({ limit: 65536 }, ['slow']);
        const v = fx.viewers[0];
        const ops = [Buffer.alloc(300), 'ab\u00e9', Buffer.alloc(70), '{"x":1}', Buffer.alloc(5)];
        ops.forEach(function (d) { fx.mux.sendToViewer(v, d); fx.assertAccounting(v); });
        while (v.ws.held.length) { v.ws.pump(1); fx.assertAccounting(v); }
        assert.equal(v.pendingBytes, 0);
    });
});

describe('viewer-isolation', function () {
    function run(order, bufferedGrows) {
        const fx = createFixture({ limit: 4096 });
        order.forEach(function (n) { fx.addViewer(n); });
        fx.addAgent();
        fx.settle();
        const healthy = fx.viewers.find(function (v) { return v.name == 'healthy'; });
        const slow = fx.viewers.find(function (v) { return v.name == 'slow'; });
        const admitted = [];
        let maxSlowPending = 0;
        for (let seq = 1; seq <= 60; seq++) {
            const before = slow.sendQueue ? slow.pendingBytes : null;
            fx.agentData(ctl(seq, 100));
            admitted.push(seq);
            if (slow.sendQueue) {
                maxSlowPending = Math.max(maxSlowPending, slow.pendingBytes);
                if (bufferedGrows) { slow.ws.bufferedAmount = slow.ws.heldBytes(); }
                fx.assertAccounting(slow);
            }
            healthy.ws.pump(); // the healthy viewer drains in between
        }
        assert.ok(maxSlowPending <= 4096);
        assert.equal(slow.closeCalls, 1);
        assert.equal(fx.limitCloses().length, 1);
        assert.equal(healthy.closeCalls, 0);
        const got = healthy.ws.sent.map(ctlSeq).filter(function (s) { return s != null; });
        assert.deepEqual(got, admitted); // healthy got every control, in order
        assert.equal(fx.agent.ws.pauseCount, 0);
        assert.equal(fx.mux.viewersOverflowCount, 0);
    }
    test('slow viewer first in the viewer array', function () { run(['slow', 'healthy'], true); });
    test('slow viewer last in the viewer array', function () { run(['healthy', 'slow'], true); });
    test('accumulating queue with an idle transport buffer', function () { run(['healthy', 'slow'], false); });
    test('healthy viewer with synchronous send callbacks', function () {
        const fx = createFixture({ limit: 4096 });
        fx.addViewer('healthy'); fx.addViewer('slow'); fx.addAgent();
        fx.viewers[0].ws.mode = 'sync';
        fx.settle();
        for (let seq = 1; seq <= 60; seq++) { fx.agentData(ctl(seq, 100)); }
        assert.equal(fx.viewers[1].closeCalls, 1);
        const got = fx.viewers[0].ws.sent.map(ctlSeq).filter(function (s) { return s != null; });
        assert.equal(got.length, 60);
        assert.equal(fx.agent.ws.pauseCount, 0);
    });
    test('control-only overflow disconnects after the cap, healthy viewer unaffected', function () {
        const fx = createSession({ limit: 4096 });
        const slow = fx.viewers[1];
        let seq = 0;
        while (slow.closeCalls == 0) { fx.agentData(ctl(++seq, 100)); fx.viewers[0].ws.pump(); assert.ok(seq < 100); }
        assert.equal(seq, 41); // 40 * 100 = 4000 fit, the 41st would make 4100
        assert.equal(fx.viewers[0].closeCalls, 0);
    });
});

describe('viewer-coalescing', function () {
    test('padded jumbo frames are classified by their body and counted by wire bytes', imageOpts, function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.agentData(sizeCmd(64, 32));
        const inner = tile(0, 0, 64, 32, 301); // 301 bytes: forces 3 bytes of padding
        const wire = jumbo(inner);
        assert.equal(wire.length, 312);
        v.ws.pump(); // head sent
        fx.agentData(wire);
        const entry = fx.mux.images[fx.mux.lastData];
        assert.equal(entry.full, true);
        assert.equal(entry.bytes, 312);
        assert.equal(entry.data, wire);
        fx.assertAccounting(v);
        v.ws.pump(1);
        assert.equal(v.ws.sent[v.ws.sent.length - 1], wire); // original wire buffer is sent
    });
    test('a partial tile is not a replacement, a viewer without one is disconnected', imageOpts, function () {
        const fx = createSession({ limit: 4096 }, ['healthy', 'slow']);
        fx.agentData(sizeCmd(64, 32));
        fx.viewers[0].ws.pump();
        const slow = fx.viewers[1];
        const spots = [[0, 0], [16, 0], [32, 0], [48, 0]];
        spots.forEach(function (s) { fx.agentData(tile(s[0], s[1], 16, 16, 1000)); fx.viewers[0].ws.pump(); });
        assert.equal(slow.closeCalls, 0); // 8 + 4000 = 4008
        fx.assertAccounting(slow);
        fx.agentData(tile(0, 16, 16, 16, 1000)); // 5008 > 4096, no full frame exists
        assert.equal(slow.closeCalls, 1);
        assert.equal(fx.viewers[0].closeCalls, 0);
        assert.equal(fx.agent.ws.pauseCount, 0);
    });
    test('only a tile at (0,0) with the exact screen size is full', imageOpts, function () {
        const fx = createSession({ limit: 8192 }, ['slow']);
        fx.agentData(sizeCmd(64, 32));
        const flags = [];
        [tile(0, 0, 64, 16, 200), tile(16, 0, 48, 32, 200), tile(0, 0, 64, 32, 200)].forEach(function (t) { fx.agentData(t); flags.push(fx.mux.images[fx.mux.lastData].full); });
        assert.deepEqual(flags, [false, false, true]);
        assert.equal(fx.mux.images[fx.mux.firstData].full, false); // screen size is not image data
    });
    test('shared pruning by a full frame adjusts the backlog exactly once', imageOpts, function () {
        const fx = createSession({ limit: 8192 }, ['slow']);
        const v = fx.viewers[0];
        fx.agentData(sizeCmd(64, 32)); // in flight
        fx.agentData(tile(0, 0, 16, 16, 500));
        fx.agentData(tile(16, 0, 16, 16, 500));
        assert.equal(v.linkedBytes, 1000);
        fx.assertAccounting(v);
        fx.agentData(tile(0, 0, 64, 32, 600)); // covers every tile: both older tiles leave the shared list
        assert.equal(v.linkedBytes, 600);
        fx.assertAccounting(v);
        v.ws.pump();
        assert.equal(v.pendingBytes, 0);
    });
    test('newest full frame replaces older pending images for that viewer only', imageOpts, function () {
        // 40x20 is not a multiple of 16: full frames never reach a zero tile counter, so the shared list keeps them.
        const fx = createSession({ limit: 4096 }, ['healthy', 'slow']);
        const healthy = fx.viewers[0], slow = fx.viewers[1];
        fx.agentData(sizeCmd(40, 20));
        healthy.ws.pump();
        const f1 = tile(0, 0, 40, 20, 1000), f2 = tile(0, 0, 40, 20, 1000), f3 = tile(0, 0, 40, 20, 1000);
        [f1, f2, f3].forEach(function (f) { fx.agentData(f); healthy.ws.pump(); fx.assertAccounting(slow); });
        assert.equal(slow.pendingBytes, 8 + 3000);
        const small = tile(16, 0, 16, 16, 300);
        const f4 = tile(0, 0, 40, 20, 1000);
        fx.agentData(f4); // 4008 pending, fits
        assert.equal(slow.pendingBytes, 4008);
        fx.agentData(small); // 4308 > 4096: coalesce to the newest full frame (f4)
        assert.equal(slow.closeCalls, 0);
        assert.ok(slow.pendingBytes <= 4096);
        assert.equal(slow.pendingBytes, 8 + 1000 + 300);
        fx.assertAccounting(slow);
        slow.ws.pump();
        assert.deepEqual(slow.ws.sent.slice(-2), [f4, small]);
        assert.equal(slow.ws.sent.indexOf(f1), -1);
        assert.equal(slow.ws.sent.indexOf(f3), -1);
        assert.equal(healthy.ws.sent.indexOf(f1) >= 0, true); // the healthy viewer saw them all
        assert.equal(healthy.ws.sent.indexOf(f3) >= 0, true);
        assert.equal(slow.pendingBytes, 0);
    });
    test('screen size command is kept and sent before the replacement when it is still unsent', imageOpts, function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.agentData(ctl(1, 100)); // in flight, so the screen size below waits in the shared list
        const size = sizeCmd(40, 20);
        fx.agentData(size);
        const f1 = tile(0, 0, 40, 20, 1500), f2 = tile(0, 0, 40, 20, 1500);
        fx.agentData(f1); fx.agentData(f2);
        assert.equal(v.pendingBytes, 100 + 8 + 3000);
        fx.agentData(ctl(2, 100));
        fx.agentData(ctl(3, 1000)); // 4308 > 4096
        assert.equal(v.closeCalls, 0);
        fx.assertAccounting(v);
        v.ws.pump();
        const order = v.ws.sent.slice(-5);
        assert.equal(ctlSeq(order[0]), 1);
        assert.equal(ctlSeq(order[1]), 2); // queued controls keep their order
        assert.equal(order[2], size); // the unsent screen size is queued behind them, then the replacement
        assert.equal(ctlSeq(order[3]), 3);
        assert.equal(order[4], f2);
        assert.equal(v.pendingBytes, 0);
    });
    test('a full frame larger than the cap disconnects instead of bypassing the limit', imageOpts, function () {
        const fx = createSession({ limit: 4096 }, ['slow']);
        const v = fx.viewers[0];
        fx.agentData(sizeCmd(64, 32));
        v.ws.pump();
        fx.agentData(tile(0, 0, 64, 32, 5000));
        assert.equal(v.closeCalls, 1);
        assert.equal(fx.limitCloses().length, 1);
    });
    test('resize resets the backlog to the screen size command', imageOpts, function () {
        const fx = createSession({ limit: 8192 }, ['slow']);
        const v = fx.viewers[0];
        fx.agentData(sizeCmd(64, 32)); // in flight
        fx.agentData(tile(0, 0, 16, 16, 700));
        fx.agentData(tile(16, 0, 16, 16, 700));
        assert.equal(v.linkedBytes, 1400);
        fx.agentData(sizeCmd(64, 48));
        assert.equal(v.linkedBytes, 8);
        fx.assertAccounting(v);
        const full = tile(0, 0, 64, 48, 400);
        fx.agentData(full);
        assert.equal(fx.mux.images[fx.mux.lastData].full, true);
        assert.equal(fx.mux.images[fx.mux.lastData].gen, fx.mux.lastScreenSizeCounter);
        fx.assertAccounting(v);
        v.ws.pump();
        assert.equal(v.pendingBytes, 0);
    });
    test('a viewer joining later is charged the whole current backlog', imageOpts, function () {
        const fx = createSession({ limit: 4096 }, ['first']);
        fx.agentData(sizeCmd(64, 32));
        fx.agentData(tile(0, 0, 64, 32, 900));
        fx.viewers[0].ws.pump();
        const late = fx.addViewer('late', null, true); // join handshake still in flight
        assert.equal(late.linkedBytes, 8 + 900);
        fx.assertAccounting(late);
        late.ws.pump();
        assert.equal(late.pendingBytes, 0);
        assert.equal(late.ws.sent.length, 4); // c, metadata, screen size, frame
    });
});

describe('viewer-cursor', function () {
    test('drains in order with a cursor, releases consumed slots and compacts', function () {
        const fx = createSession({ limit: 1 << 20 }, ['slow']);
        const v = fx.viewers[0];
        v.sendQueue.shift = function () { throw new Error('shift must not be used on the viewer queue'); };
        const sentBefore = v.ws.sent.length;
        fx.mux.sendToViewer(v, ctl(0, 8)); // in flight
        for (let i = 1; i <= 200; i++) { fx.mux.sendToViewer(v, ctl(i, 8)); }
        assert.equal(v.queueBytes, 200 * 8);
        let maxPhysical = 0;
        let compacted = false;
        for (let i = 0; i < 201; i++) {
            v.ws.pump(1);
            if (v.sendQueue != null) {
                maxPhysical = Math.max(maxPhysical, v.sendQueue.length);
                if (v.sendQueueHead > 0) { assert.equal(v.sendQueue[v.sendQueueHead - 1], undefined); }
                if (i > 0 && v.sendQueueHead == 0 && v.sendQueue.length > 0) { compacted = true; }
                assert.equal(v.queueBytes, v.sendQueue.slice(v.sendQueueHead).length * 8);
                fx.assertAccounting(v);
            }
        }
        assert.ok(maxPhysical <= 200);
        assert.ok(compacted, 'consumed prefix is compacted');
        assert.deepEqual(v.ws.sent.slice(sentBefore).map(ctlSeq), Array.from({ length: 201 }, function (_, i) { return i; }));
        assert.equal(v.sendQueue.length, 0);
        assert.equal(v.sendQueueHead, 0);
        assert.equal(v.pendingBytes, 0);
        assert.equal(v.sending, false);
    });
    test('repeated partial drains and refills keep FIFO order', function () {
        const fx = createSession({ limit: 1 << 20 }, ['slow']);
        const v = fx.viewers[0];
        const expected = [], seen = [];
        let seq = 0;
        for (let round = 0; round < 30; round++) {
            for (let i = 0; i < 7; i++) { fx.mux.sendToViewer(v, ctl(++seq, 8)); expected.push(seq); }
            v.ws.pump(5);
            fx.assertAccounting(v);
        }
        v.ws.pump();
        assert.deepEqual(v.ws.sent.map(ctlSeq).filter(function (s) { return s != null; }), expected);
        assert.equal(v.pendingBytes, 0);
    });
});

describe('viewer-lifecycle', function () {
    test('callback error disconnects once and clears state', function () {
        const fx = createSession({ limit: 4096 }, ['healthy', 'slow']);
        const slow = fx.viewers[1];
        fx.mux.sendToViewer(slow, Buffer.alloc(100));
        fx.mux.sendToViewer(slow, Buffer.alloc(100));
        slow.ws.pump(1, new Error('socket closed'));
        assert.equal(slow.closeCalls, 1);
        assert.equal(slow.pendingBytes, undefined);
        assert.equal(slow.sendQueue, undefined);
        slow.ws.pump(); // the remaining callbacks arrive late
        assert.equal(slow.closeCalls, 1);
        assert.equal(slow.ws.sent.length, 3); // c, metadata and the first 100 byte message only; nothing sent after the error
    });
    test('thrown send error disconnects instead of sticking in sending', function () {
        const fx = createSession({ limit: 4096 }, ['healthy', 'slow']);
        const slow = fx.viewers[1];
        slow.ws.throwOnSend = true;
        fx.mux.sendToViewer(slow, Buffer.alloc(100));
        assert.equal(slow.closeCalls, 1);
        assert.equal(slow.sending, undefined);
        assert.equal(fx.viewers[0].closeCalls, 0);
    });
    test('callback after disconnect sends nothing and recreates nothing', function () {
        const fx = createSession({ limit: 4096 }, ['healthy', 'slow']);
        const slow = fx.viewers[1];
        fx.mux.sendToViewer(slow, Buffer.alloc(100));
        fx.mux.sendToViewer(slow, Buffer.alloc(100));
        const late = slow.ws.held.slice();
        const sent = slow.ws.sent.length;
        slow.close();
        late.forEach(function (h) { h.cb(); h.cb(); });
        assert.equal(slow.ws.sent.length, sent);
        ['pendingBytes', 'queueBytes', 'inflightBytes', 'linkedBytes', 'sendQueue', 'sendQueueHead', 'sending', 'dataPtr', 'closing'].forEach(function (f) { assert.equal(f in slow, false, f); });
        fx.mux.sendToViewer(slow, Buffer.alloc(10)); // removed viewer: ignored
        assert.equal(slow.ws.sent.length, sent);
    });
    test('slowRelay uses a cancellable timer and keeps the payload accounted', function () {
        const fx = createFixture({ limit: 4096 });
        const v = fx.addViewer('slow', { slowrelay: 50 });
        assert.equal(v.slowRelay, 50);
        // The join message is delayed by one timer and stays accounted as in flight, nothing reached the socket yet.
        assert.equal(fx.timers.length, 1);
        assert.equal(fx.timers[0].ms, 50);
        assert.equal(v.inflightBytes, 1);
        assert.ok(v.pendingBytes >= 1);
        assert.equal(v.ws.sent.length, 0);
        const t = fx.timers[0];
        v.close();
        assert.equal(t.cleared, true);
        t.fn(); // even a timer callback that still runs does nothing after close
        assert.equal(v.ws.sent.length, 0);
    });
    test('slowRelay delayed send is delivered when its timer fires', function () {
        const fx = createFixture({ limit: 4096 });
        const v = fx.addViewer('slow', { slowrelay: 50 });
        fx.addAgent();
        // The join handshake used timers too: fire them until idle.
        for (let i = 0; i < 20; i++) { fx.timers.filter(function (t) { return !t.cleared && !t.fired; }).forEach(function (t) { t.fired = true; t.fn(); }); v.ws.pump(); }
        assert.equal(v.pendingBytes, 0);
        const data = Buffer.alloc(77);
        fx.mux.sendToViewer(v, data);
        assert.equal(v.ws.sent.indexOf(data), -1);
        const t = fx.timers[fx.timers.length - 1];
        t.fired = true; t.fn();
        assert.equal(v.ws.sent[v.ws.sent.length - 1], data);
        v.ws.pump();
        assert.equal(v.pendingBytes, 0);
    });
    test('last viewer closing disposes the session and closes the agent', function () {
        const fx = createSession({ limit: 4096 }, ['only']);
        fx.viewers[0].close();
        assert.equal(fx.agent.closeCalls, 1);
        assert.equal(fx.mux.viewers, undefined);
    });
    test('overflow counter follows removal and never pauses the agent for one slow viewer', function () {
        const fx = createSession({ limit: 1 << 20 });
        const slow = fx.viewers[1];
        for (let seq = 1; seq <= 8; seq++) { fx.agentData(ctl(seq, 20)); fx.viewers[0].ws.pump(); }
        assert.equal(slow.overflow, true);
        assert.equal(fx.mux.viewersOverflowCount, 1);
        assert.equal(fx.agent.ws.pauseCount, 0);
        slow.close();
        assert.equal(fx.mux.viewersOverflowCount, 0);
        assert.equal(fx.agent.ws.pauseCount, 0);
    });
    test('all viewers overflowing still pauses the agent and draining resumes it', function () {
        const fx = createSession({ limit: 1 << 20 }, ['slow']);
        for (let seq = 1; seq <= 8; seq++) { fx.agentData(ctl(seq, 20)); }
        assert.equal(fx.agent.ws.pauseCount, 1);
        fx.viewers[0].ws.pump();
        assert.equal(fx.agent.ws.resumeCount, 1);
        assert.equal(fx.mux.viewersOverflowCount, 0);
    });
    test('closing a viewer during a broadcast does not skip the next viewer', function () {
        const fx = createFixture({ limit: 4096 });
        ['a', 'slow', 'c'].forEach(function (n) { fx.addViewer(n); });
        fx.addAgent();
        fx.settle();
        const slow = fx.viewers[1];
        slow.ws.bufferedAmount = 5000; // over the cap for the next payload
        fx.agentData(ctl(1, 100));
        assert.equal(slow.closeCalls, 1);
        fx.settle(); // the removal metadata goes out first, the control follows it
        [0, 2].forEach(function (i) { assert.deepEqual(fx.viewers[i].ws.sent.map(ctlSeq).filter(function (s) { return s != null; }), [1]); });
    });
});
