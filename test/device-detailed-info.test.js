'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

function extractFunction(file, header) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = src.indexOf('\n    ' + header);
    assert.ok(start >= 0, 'extraction marker missing: ' + header);
    const end = src.indexOf('\n    }\n', start + 1);
    assert.ok(end > start, 'function end missing: ' + header);
    return src.slice(start + 1, end + 6);
}

function compileFunction(bindings) {
    const code = extractFunction('meshuser.js', 'function getDeviceDetailedInfo(nodeids, type, func)');
    return vm.runInContext('(' + code + ')', vm.createContext(bindings));
}

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

function makeScheduler(mode) {
    const queue = [];
    let pending = 0, count = 0;
    return {
        run: function (callback) {
            count++;
            if (mode === 'sync' || (mode === 'mixed' && count % 2 === 1)) { callback(); }
            else if (mode === 'reverse') { queue.push(callback); }
            else {
                pending++;
                setImmediate(function () { pending--; callback(); });
            }
        },
        drain: async function () {
            while (queue.length > 0) { queue.pop()(); }
            while (pending > 0) { await tick(); }
            await tick();
        }
    };
}

for (const mode of ['deferred', 'sync', 'reverse', 'mixed']) {
    for (const count of [0, 1, 3]) {
        test('explicit details/' + mode + '/' + count, async function () {
            const scheduler = makeScheduler(mode);
            const ids = ['node//a', 'node//b', 'node//c'].slice(0, count);
            const calls = [];
            const parent = {
                db: { Get: function (key, callback) { scheduler.run(function () { callback(null, [{ _id: key }]); }); } },
                GetNodeWithRights: function (domain, user, id, callback) {
                    scheduler.run(function () { callback({ _id: id }, 0xFFFFFFFF, true); });
                },
                CloneSafeNode: function (node) { return Object.assign({}, node); }
            };
            const getDetails = compileFunction({ parent: parent, db: parent.db, domain: {}, user: {}, getAllDeviceDetailedInfo: function () { assert.fail('unexpected delegation'); } });
            getDetails(ids, 'json', function (results, type) { calls.push({ results: results, type: type, count: results.length }); });
            await scheduler.drain();
            assert.equal(calls.length, 1, 'completion callback count');
            assert.equal(calls[0].type, 'json');
            assert.ok(Array.isArray(calls[0].results));
            assert.equal(calls[0].count, count, 'all records present at completion');
            assert.deepEqual(Array.from(calls[0].results, function (record) { return record.node._id; }).sort(), ids);
            calls[0].results.forEach(function (record) {
                assert.equal(record.sys._id, 'si' + record.node._id);
                assert.equal(record.net._id, 'if' + record.node._id);
            });
        });
    }
}

for (const mode of ['deferred', 'sync', 'reverse', 'mixed']) {
    for (const scenario of ['hidden', 'mixed-visible', 'missing', 'absent', 'error', 'multiple']) {
        test('explicit details/' + mode + '/' + scenario, async function () {
            const scheduler = makeScheduler(mode);
            const ids = ['node//a', 'node//b', 'node//c'];
            const reads = [], calls = [];
            const expected = ids.filter(function (id, index) {
                return scenario !== 'hidden' && (scenario !== 'mixed-visible' || index === 0) && (scenario !== 'missing' || index !== 1);
            });
            const parent = {
                db: { Get: function (key, callback) {
                    reads.push(key);
                    scheduler.run(function () {
                        if (scenario === 'error') { callback(new Error('database failure'), [{ _id: key }]); }
                        else if (scenario === 'absent') { callback(null, key.startsWith('si') ? [] : null); }
                        else if (scenario === 'multiple') { callback(null, [{ _id: key }, { _id: key }]); }
                        else { callback(null, [{ _id: key }]); }
                    });
                } },
                GetNodeWithRights: function (domain, user, id, callback) {
                    scheduler.run(function () {
                        callback(scenario === 'missing' && id === ids[1] ? null : { _id: id }, 0xFFFFFFFF, expected.includes(id));
                    });
                },
                CloneSafeNode: function (node) { return Object.assign({}, node); }
            };
            const getDetails = compileFunction({ parent: parent, db: parent.db, domain: {}, user: {}, getAllDeviceDetailedInfo: function () { assert.fail('unexpected delegation'); } });
            getDetails(ids, 'csv', function (results, type) { calls.push({ results: results, type: type, count: results.length }); });
            await scheduler.drain();
            assert.equal(calls.length, 1, 'completion callback count');
            assert.equal(calls[0].type, 'csv');
            assert.ok(Array.isArray(calls[0].results));
            assert.equal(calls[0].count, expected.length);
            assert.deepEqual(Array.from(calls[0].results, function (record) { return record.node._id; }).sort(), expected);
            assert.deepEqual(reads.sort(), expected.flatMap(function (id) { return ['si' + id, 'if' + id]; }).sort());
            if (['absent', 'error', 'multiple'].includes(scenario)) {
                calls[0].results.forEach(function (record) { assert.equal(record.sys, null); assert.equal(record.net, null); });
            }
        });
    }
}

test('null node list delegates once', function () {
    const parent = { db: {} };
    const calls = [];
    const callback = function () { };
    const getDetails = compileFunction({
        parent: parent, db: parent.db, domain: {}, user: {},
        getAllDeviceDetailedInfo: function (type, func) { calls.push({ type: type, func: func }); }
    });
    getDetails(null, 'json', callback);
    assert.deepEqual(calls, [{ type: 'json', func: callback }]);
});

test('explicit device details command replies once', async function () {
    const f = await createMeshUserFixture({ user: { siteadmin: 0xFFFFFFFF } });
    try {
        const ids = ['node//a', 'node//b', 'node//c'];
        const scheduler = makeScheduler('deferred');
        f.root.GetConnectivityState = function () { return null; };
        f.parent.GetAllMeshIdWithRights = function () { return []; };
        f.parent.cleanDevice = function () { };
        f.parent.CloneSafeNode = function (node) { return Object.assign({}, node); };
        f.parent.GetNodeRights = function () { return 0xFFFFFFFF; };
        f.parent.GetNodeWithRights = function (domain, user, id, callback) {
            scheduler.run(function () { callback({ _id: id, meshid: 'mesh//m' }, 0xFFFFFFFF, true); });
        };
        f.db.GetAllTypeNoTypeFieldMeshFiltered = function (links, extra, domainid, type, id, skip, limit, filter, callback) {
            callback(null, ids.map(function (nodeid) { return { _id: nodeid }; }));
        };
        f.db.GetAllIdsOfType = function (nodeids, domainid, type, callback) { callback(null, []); };
        f.parent.db.Get = function (key, callback) { scheduler.run(function () { callback(null, [{ _id: key }]); }); };
        f.clearCaptures();
        f.ws.emit('message', Buffer.from(JSON.stringify({ action: 'getDeviceDetails', type: 'json', nodeids: ids })));
        await scheduler.drain();
        const replies = f.sent.map(function (message) { return JSON.parse(message); }).filter(function (message) { return message.action === 'getDeviceDetails'; });
        assert.equal(replies.length, 1, 'completion callback count');
        assert.equal(replies[0].type, 'json');
        const data = JSON.parse(replies[0].data);
        assert.ok(Array.isArray(data));
        assert.equal(data.length, ids.length);
        assert.deepEqual(data.map(function (record) { return record.node._id; }).sort(), ids);
        assert.deepEqual(f.errors, []);
    } finally { f.close(); }
});
