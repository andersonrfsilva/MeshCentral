'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { CreateMeshRelay } = require('../meshrelay.js');

// Builds a relay request whose node lookup is captured and released by the test.
function createFixture(rights, existingWaiter) {
    const fx = { callbacks: [], resumes: 0, closes: 0, rightsCalls: 0 };
    const parent = {
        parent: { debug: function () { }, args: {} },
        wsrelays: {},
        args: {},
        relaySessionCount: 0,
        relaySessionErrors: 0,
        trafficStats: { relayIn: {}, relayOut: {}, relayCount: {} },
        db: { Get: function (id, func) { fx.callbacks.push(func); } },
        GetNodeRights: function () { fx.rightsCalls++; return rights; }
    };
    const ws = new EventEmitter();
    ws.send = function () { };
    ws.close = function () { fx.closes++; }; // Does not emit 'close'.
    ws._socket = { setKeepAlive: function () { }, pause: function () { }, resume: function () { fx.resumes++; }, bytesRead: 0, bytesWritten: 0 };
    ws.protocolIndex = 0;
    const req = { query: { id: 'relay-test', nodeid: 'node/test/device', p: '2' }, clientIp: '127.0.0.1' };
    const domain = { id: 'test' };
    const user = { _id: 'user/test/alice' };

    if (existingWaiter) {
        fx.waiterResumes = 0;
        fx.waiter = { authenticated: true, user: user, ws: { _socket: { resume: function () { fx.waiterResumes++; } } }, req: { query: { p: '2' }, clientIp: '127.0.0.2' } };
        parent.wsrelays['relay-test'] = { peer1: fx.waiter, state: 1 };
    }

    fx.parent = parent;
    fx.ws = ws;
    fx.start = function () { CreateMeshRelay(parent, ws, req, domain, user, null); };
    fx.cleanup = function () {
        for (const id in parent.wsrelays) { clearTimeout(parent.wsrelays[id].timeout); }
    };
    return fx;
}

test('denied lookup never publishes the relay and closes the socket', function (t) {
    const fx = createFixture(0);
    t.after(fx.cleanup);
    fx.start();
    assert.strictEqual(fx.callbacks.length, 1);
    assert.deepStrictEqual(Object.keys(fx.parent.wsrelays), []);
    fx.callbacks[0](null, [{ _id: 'node/test/device', meshid: 'mesh/test/group' }]);
    assert.deepStrictEqual(Object.keys(fx.parent.wsrelays), []);
    assert.strictEqual(fx.closes, 1);
});

test('authorized lookup publishes the relay only after the callback', function (t) {
    const fx = createFixture(0xFFFFFFFF);
    t.after(fx.cleanup);
    fx.start();
    assert.deepStrictEqual(Object.keys(fx.parent.wsrelays), []);
    fx.callbacks[0](null, [{ _id: 'node/test/device', meshid: 'mesh/test/group' }]);
    const info = fx.parent.wsrelays['relay-test'];
    assert.ok(info);
    assert.strictEqual(info.state, 1);
    assert.strictEqual(info.peer1.nodeid, 'node/test/device');
    assert.strictEqual(info.peer1.meshid, 'mesh/test/group');
    assert.strictEqual(fx.closes, 0);
});

test('missing node closes the socket without publishing', function (t) {
    const fx = createFixture(0xFFFFFFFF);
    t.after(fx.cleanup);
    fx.start();
    fx.callbacks[0](null, []);
    assert.deepStrictEqual(Object.keys(fx.parent.wsrelays), []);
    assert.strictEqual(fx.closes, 1);
});

test('denied lookup cannot pair with an existing waiting peer', function (t) {
    const fx = createFixture(0, true);
    t.after(fx.cleanup);
    const waiting = fx.parent.wsrelays['relay-test'];
    fx.start();
    assert.strictEqual(waiting.state, 1);
    assert.strictEqual(waiting.peer2, undefined);
    assert.strictEqual(fx.resumes, 0);
    assert.strictEqual(fx.waiterResumes, 0);
    fx.callbacks[0](null, [{ _id: 'node/test/device', meshid: 'mesh/test/group' }]);
    assert.strictEqual(fx.parent.wsrelays['relay-test'], waiting);
    assert.strictEqual(waiting.state, 1);
    assert.strictEqual(waiting.peer2, undefined);
    assert.strictEqual(fx.waiter.peer, undefined);
    assert.strictEqual(fx.resumes, 0);
    assert.strictEqual(fx.waiterResumes, 0);
    assert.strictEqual(fx.closes, 1);
});
