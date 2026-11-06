'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function createFixture(onReady, synchronousClose) {
    class Server extends EventEmitter {
        constructor() { super(); this.closeCalls = 0; }
        listen(port, host, callback) { setImmediate(callback); }
        address() { return { port: 12345 }; }
        close() { this.closeCalls++; }
    }
    class WebSocket extends EventEmitter {
        constructor() {
            super();
            this.closeCalls = 0;
            this.sendCalls = 0;
            this._socket = { pause: function () {}, resume: function () {} };
        }
        close() { this.closeCalls++; this.emit('close'); }
        send(data, callback) { this.sendCalls++; if (callback) { callback(); } }
    }
    const full = path.join(__dirname, '..', 'meshipkvm.js');
    const src = fs.readFileSync(full, 'utf8') + '\n;__x.CreateMiniRouter = CreateMiniRouter;';
    const wrapper = vm.runInThisContext('(function (module, exports, require, __x) {' + src + '\n})', { filename: full });
    const m = { exports: {} }, x = {};
    const localRequire = Module.createRequire(full);
    wrapper(m, m.exports, function (name) {
        if (name === 'net') { return { Server: Server }; }
        if (name === 'ws') { return WebSocket; }
        return localRequire(name);
    }, x);
    assert.deepEqual(Object.keys(m.exports), ['CreateIPKVMManager']);
    const parent = { parent: {
        debug: function () {},
        encodeCookie: function () { return 'test-cookie'; },
        loginCookieEncryptionKey: 'test-key',
        config: { domains: { '': { id: '' } } },
        args: { port: 443 }
    } };
    const router = x.CreateMiniRouter(parent, 'node//test', '127.0.0.1', 5900);
    router.start(function (port) {
        assert.equal(port, 12345);
        const server = router.tcpServer;
        const sockets = [], relays = [];
        for (let i = 0; i < 3; i++) {
            const socket = new EventEmitter();
            socket.calls = { pause: 0, resume: 0, write: 0, end: 0, destroy: 0 };
            socket.pause = function () { this.calls.pause++; };
            socket.resume = function () { this.calls.resume++; };
            socket.write = function (data, callback) { this.calls.write++; if (callback) { callback(); } };
            socket.end = function () { this.calls.end++; };
            socket.destroy = function () { this.calls.destroy++; if (synchronousClose) { this.emit('close'); } };
            server.emit('connection', socket);
            sockets.push(socket);
            relays.push(socket.relaySocket);
            assert.equal(socket.calls.pause, 1);
        }
        onReady({ router: router, server: server, sockets: sockets, relays: relays });
    });
}

function assertPair(fixture, index, ends, destroys, closes) {
    const socket = fixture.sockets[index], relay = fixture.relays[index];
    assert.equal(socket.calls.end, ends, 'end count for socket ' + index);
    assert.equal(socket.calls.destroy, destroys, 'destroy count for socket ' + index);
    assert.equal(relay.closeCalls, closes, 'close count for relay ' + index);
    if (closes) {
        assert.equal(socket.relaySocket, undefined);
        assert.equal(relay.tcpSocket, undefined);
    } else {
        assert.equal(socket.relaySocket, relay);
        assert.equal(relay.tcpSocket, socket);
    }
}

function assertStopped(fixture, earlyIndex) {
    assert.equal(fixture.server.closeCalls, 1);
    assert.equal(fixture.router.tcpServer, null);
    for (let i = 0; i < 3; i++) {
        assertPair(fixture, i, i === earlyIndex ? 1 : 0, i === earlyIndex ? 0 : 1, 1);
    }
}

test('MiniRouter stop destroys three distinct TCP sockets and closes every relay', function (t, done) {
    createFixture(function (fixture) {
        fixture.router.stop();
        assertStopped(fixture);
        done();
    });
});

test('MiniRouter early TCP end leaves the other two pairs tracked', function (t, done) {
    createFixture(function (fixture) {
        fixture.sockets[0].emit('end');
        assertPair(fixture, 0, 1, 0, 1);
        assertPair(fixture, 1, 0, 0, 0);
        assertPair(fixture, 2, 0, 0, 0);
        fixture.router.stop();
        assertStopped(fixture, 0);
        done();
    });
});

test('MiniRouter relay close cleans up only its own TCP socket', function (t, done) {
    createFixture(function (fixture) {
        fixture.relays[1].emit('close');
        assertPair(fixture, 0, 0, 0, 0);
        assertPair(fixture, 1, 1, 0, 1);
        assertPair(fixture, 2, 0, 0, 0);
        fixture.router.stop();
        assertStopped(fixture, 1);
        done();
    });
});

test('MiniRouter repeated TCP and relay close/error events do not affect another pair', function (t, done) {
    createFixture(function (fixture) {
        fixture.sockets[2].emit('error', new Error('test disconnect'));
        for (let i = 0; i < 2; i++) {
            fixture.sockets[2].emit('close');
            fixture.sockets[2].emit('end');
            fixture.sockets[2].emit('error', new Error('repeated disconnect'));
            fixture.relays[2].emit('close');
            fixture.relays[2].emit('error', new Error('repeated relay disconnect'));
        }
        assertPair(fixture, 0, 0, 0, 0);
        assertPair(fixture, 1, 0, 0, 0);
        assertPair(fixture, 2, 1, 0, 1);
        fixture.router.stop();
        assertStopped(fixture, 2);
        done();
    });
});

test('MiniRouter synchronous destroy close callbacks cannot duplicate cleanup', function (t, done) {
    createFixture(function (fixture) {
        fixture.router.stop();
        fixture.sockets.forEach(function (socket) { socket.emit('close'); });
        assertStopped(fixture);
        done();
    }, true);
});
