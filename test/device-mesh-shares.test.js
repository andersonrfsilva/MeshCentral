'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

const DOMAIN = 'test';
const SHORT = 'abcdefgh';
const FULL = 'mesh/' + DOMAIN + '/' + SHORT;

// Runs one deviceMeshShares command through the real message listener.
// rights: value returned by GetMeshRights; mesh: whether parent.meshes[FULL] exists.
async function run(command, options) {
    const f = await createMeshUserFixture({ domain: { id: DOMAIN, limits: {} }, user: { _id: 'user/' + DOMAIN + '/alice', name: 'alice' } });
    const rightsCalls = [], dbCalls = [];
    const mesh = { _id: FULL, name: 'm' };
    if (options.mesh !== false) { f.parent.meshes[FULL] = mesh; }
    f.parent.GetMeshRights = function (u, m) { rightsCalls.push(m); return options.rights; };
    f.db.GetAllTypeNoTypeField = function (type, domainid, cb) { dbCalls.push([type, domainid]); cb(null, []); };
    f.clearCaptures();
    try {
        assert.strictEqual(f.ws.listenerCount('message'), 1);
        f.ws.emit('message', Buffer.from(JSON.stringify(Object.assign({ action: 'deviceMeshShares' }, command))));
        return { sent: f.sent.map(function (s) { return JSON.parse(s); }), rightsCalls: rightsCalls, dbCalls: dbCalls, mesh: mesh, errors: f.errors };
    } finally { f.close(); }
}

function assertDenied(r, message, responseid) {
    assert.strictEqual(r.dbCalls.length, 0);
    assert.deepStrictEqual(r.sent, [{ action: 'deviceShares', responseid: responseid, result: message }]);
}

function assertAllowed(r, meshid) {
    assert.strictEqual(r.rightsCalls.length, 1);
    assert.strictEqual(r.rightsCalls[0], r.mesh);
    assert.deepStrictEqual(r.dbCalls, [['deviceshare', DOMAIN]]);
    assert.deepStrictEqual(r.sent, [{ action: 'deviceMeshShares', meshid: meshid, deviceShares: [] }]);
}

test('full id with rights lists shares', async function () {
    assertAllowed(await run({ meshid: FULL, responseid: 'r' }, { rights: 1 }), FULL);
});

test('full id without rights is denied before the database read', async function () {
    assertDenied(await run({ meshid: FULL, responseid: 'r' }, { rights: 0 }), 'Access denied', 'r');
});

test('short id with rights lists shares under the canonical id', async function () {
    assertAllowed(await run({ meshid: SHORT, responseid: 'r' }, { rights: 1 }), FULL);
});

test('short id without rights is denied before the database read', async function () {
    const r = await run({ meshid: SHORT, responseid: 'r' }, { rights: 0 });
    assert.strictEqual(r.rightsCalls.length, 1);
    assertDenied(r, 'Access denied', 'r');
});

test('short id for a missing mesh is rejected before the database read', async function () {
    const r = await run({ meshid: SHORT, responseid: 'r' }, { rights: 1, mesh: false });
    assert.strictEqual(r.rightsCalls.length, 0);
    assertDenied(r, 'Invalid device group id', 'r');
});

test('full id from another domain is rejected before the database read', async function () {
    const r = await run({ meshid: 'mesh/other/' + SHORT, responseid: 'r' }, { rights: 1 });
    assert.strictEqual(r.rightsCalls.length, 0);
    assertDenied(r, 'Invalid domain', 'r');
});

test('malformed ids are rejected before the database read', async function () {
    const cases = [
        [undefined, 'Invalid device group id'], [null, 'Invalid device group id'], [12345678, 'Invalid device group id'],
        [{ a: 1 }, 'Invalid device group id'], ['short', 'Invalid device group id'], ['x'.repeat(135), 'Invalid device group id'],
        ['mesh/' + DOMAIN + '/a/b', 'Invalid domain'], ['mesh/' + DOMAIN, 'Invalid domain']
    ];
    for (const [meshid, message] of cases) {
        const r = await run({ meshid: meshid, responseid: 'r' }, { rights: 1 });
        assert.strictEqual(r.rightsCalls.length, 0, String(meshid));
        assertDenied(r, message, 'r');
    }
});

test('denied request without responseid sends nothing and skips the database', async function () {
    for (const meshid of [SHORT, FULL]) {
        const r = await run({ meshid: meshid }, { rights: 0 });
        assert.strictEqual(r.dbCalls.length, 0);
        assert.deepStrictEqual(r.sent, []);
    }
});
