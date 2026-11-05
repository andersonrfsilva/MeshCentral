'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDbParent } = require('./helpers/fake-parent.js');

// Calls a callback-style operation and captures every argument; fails if the callback fires more than once.
function call(fn) {
    return new Promise(function (resolve, reject) {
        let calls = 0;
        fn(function () {
            calls++;
            if (calls > 1) { reject(new Error('callback invoked more than once')); return; }
            const args = Array.prototype.slice.call(arguments);
            setImmediate(function () { if (calls == 1) { resolve(args); } });
        });
    });
}

// Runs body with a real NeDB-backed db in a unique temp directory. Stops compaction timers before disposal.
async function withDb(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcentral-test-'));
    let db = null;
    try {
        assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        const parent = createDbParent(dir);
        db = await new Promise(function (resolve) { require('../db.js').CreateDB(parent, resolve); });
        const stores = [db.file, db.eventsfile, db.powerfile, db.serverstatsfile];
        try { await body(db); }
        finally {
            // Drain initialization and queued operations on every store, then stop the timers.
            for (const store of stores) { await new Promise(function (resolve) { store.find({}, resolve); }); }
            for (const store of stores) { store.stopAutocompaction(); }
        }
    } finally {
        // Characterization: for NeDB, db.dispose() throws a TypeError on null members (e.g. newAutoBackupFile) in the current source.
        if (db != null) { try { db.dispose(); } catch (ex) { assert.ok(ex instanceof TypeError); } }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('Set, Get and overwrite keep a single row', function () {
    return withDb(async function (db) {
        let r = await call(function (cb) { db.Get('missing', cb); });
        assert.strictEqual(r.length, 2);
        assert.ok(r[0] == null);
        assert.deepStrictEqual(r[1], []);

        r = await call(function (cb) { db.Set({ _id: 'node//one', type: 'node', domain: 'test', name: 'a' }, cb); });
        assert.ok(r[0] == null);
        r = await call(function (cb) { db.Get('node//one', cb); });
        assert.ok(r[0] == null);
        assert.ok(Array.isArray(r[1]));
        assert.strictEqual(r[1].length, 1);
        assert.strictEqual(r[1][0].name, 'a');

        r = await call(function (cb) { db.Set({ _id: 'node//one', type: 'node', domain: 'test', name: 'b' }, cb); });
        assert.ok(r[0] == null);
        r = await call(function (cb) { db.Get('node//one', cb); });
        assert.strictEqual(r[1].length, 1);
        assert.strictEqual(r[1][0].name, 'b');
    });
});

test('Remove reports one removed row and Get then returns []', function () {
    return withDb(async function (db) {
        await call(function (cb) { db.Set({ _id: 'node//rm', type: 'node', domain: 'test' }, cb); });
        let r = await call(function (cb) { db.Remove('node//rm', cb); });
        assert.ok(r[0] == null);
        assert.strictEqual(r[1], 1);
        r = await call(function (cb) { db.Get('node//rm', cb); });
        assert.ok(r[0] == null);
        assert.deepStrictEqual(r[1], []);
    });
});

test('GetAllType returns every row of a type across domains', function () {
    return withDb(async function (db) {
        await call(function (cb) { db.Set({ _id: 'node/test/1', type: 'node', domain: 'test' }, cb); });
        await call(function (cb) { db.Set({ _id: 'node/test/2', type: 'node', domain: 'test' }, cb); });
        await call(function (cb) { db.Set({ _id: 'node/other/3', type: 'node', domain: 'other' }, cb); });
        await call(function (cb) { db.Set({ _id: 'mesh/test/4', type: 'mesh', domain: 'test' }, cb); });
        const r = await call(function (cb) { db.GetAllType('node', cb); });
        assert.ok(r[0] == null);
        assert.deepStrictEqual(r[1].map(function (d) { return d._id; }).sort(), ['node/other/3', 'node/test/1', 'node/test/2']);
        r[1].forEach(function (d) { assert.strictEqual(d.type, 'node'); });
    });
});

test('isMaxType callback is (exceeded, count), not error-first', function () {
    return withDb(async function (db) {
        let r = await call(function (cb) { db.isMaxType(null, 'node', 'test', cb); });
        assert.deepStrictEqual(r, [false]);

        r = await call(function (cb) { db.isMaxType(0, 'node', 'test', cb); });
        assert.deepStrictEqual(r, [false, 0]);

        await call(function (cb) { db.Set({ _id: 'node/test/1', type: 'node', domain: 'test' }, cb); });
        await call(function (cb) { db.Set({ _id: 'node/test/2', type: 'node', domain: 'test' }, cb); });
        await call(function (cb) { db.Set({ _id: 'node/other/3', type: 'node', domain: 'other' }, cb); });

        r = await call(function (cb) { db.isMaxType(2, 'node', 'test', cb); });
        assert.deepStrictEqual(r, [false, 2]); // count > max, not >=
        r = await call(function (cb) { db.isMaxType(1, 'node', 'test', cb); });
        assert.deepStrictEqual(r, [true, 2]);
    });
});
