'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

const NODEID = 'node/test/abcdefgh';

// Builds a real session, with a controlled rights helper and recording event-history DB.
async function setup(helperResult) {
    const f = await createMeshUserFixture({ domain: { id: 'test' }, user: { _id: 'user/test/alice', name: 'alice', domain: 'test', links: {}, siteadmin: 0 } });
    const reads = [];
    f.db.GetNodeEventsWithLimit = function (nodeid, domainid, limit, filter, func) {
        reads.push({ kind: 'general', nodeid: nodeid, domainid: domainid, limit: limit, filter: filter });
        func(null, [{ marker: 'general-event' }]);
    };
    f.db.GetNodeEventsSelfWithLimit = function (nodeid, domainid, userid, limit, filter, func) {
        reads.push({ kind: 'self', nodeid: nodeid, domainid: domainid, userid: userid, limit: limit, filter: filter });
        func(null, [{ marker: 'self-event' }]);
    };
    f.parent.GetNodeWithRights = function (domain, user, nodeid, func) {
        const r = helperResult(nodeid);
        func(r.node, r.rights, r.visible);
    };
    f.clearCaptures();
    return { f: f, reads: reads };
}

function sendEvents(f, extra) {
    assert.ok(f.ws.listenerCount('message') > 0, 'message listener registered');
    f.ws.emit('message', Buffer.from(JSON.stringify(Object.assign({ action: 'events', nodeid: NODEID, tag: 'test-tag' }, extra))));
    return f.sent.map(function (s) { return JSON.parse(s); }).filter(function (m) { return m.action == 'events'; });
}

async function run(result, extra) {
    const s = await setup(function () { return result; });
    try { return { out: sendEvents(s.f, extra), reads: s.reads }; } finally { s.f.close(); }
}

const denied = { action: 'events', events: [], nodeid: NODEID, tag: 'test-tag' };

test('missing node: empty response, no DB reads', async () => {
    const r = await run({ node: null, rights: 0, visible: false });
    assert.deepStrictEqual(r.out, [denied]);
    assert.strictEqual(r.reads.length, 0);
});

test('real node, rights 0, not visible: denied, no DB reads', async () => {
    const r = await run({ node: { _id: NODEID }, rights: 0, visible: false });
    assert.deepStrictEqual(r.out, [denied]);
    assert.strictEqual(r.reads.length, 0);
});

test('real node, nonzero rights, not visible: denied before either read', async () => {
    for (const rights of [0x00000008, 0x00002000, 0xFFFFFFFF]) {
        const r = await run({ node: { _id: NODEID }, rights: rights, visible: false });
        assert.deepStrictEqual(r.out, [denied]);
        assert.strictEqual(r.reads.length, 0);
    }
});

test('visible node, ordinary rights: general query only', async () => {
    const r = await run({ node: { _id: NODEID }, rights: 0x00000008, visible: true }, { limit: 25, filter: 'agentlog' });
    assert.deepStrictEqual(r.reads, [{ kind: 'general', nodeid: NODEID, domainid: 'test', limit: 25, filter: 'agentlog' }]);
    assert.deepStrictEqual(r.out, [{ action: 'events', events: [{ marker: 'general-event' }], nodeid: NODEID, tag: 'test-tag' }]);
});

test('visible node, rights 0: general query', async () => {
    const r = await run({ node: { _id: NODEID }, rights: 0, visible: true });
    assert.deepStrictEqual(r.reads, [{ kind: 'general', nodeid: NODEID, domainid: 'test', limit: 10000, filter: null }]);
    assert.strictEqual(r.out[0].events[0].marker, 'general-event');
});

test('visible node, LIMITEVENTS: self query only with user id', async () => {
    const r = await run({ node: { _id: NODEID }, rights: 0x00002000, visible: true }, { limit: 5, filter: 'manual' });
    assert.deepStrictEqual(r.reads, [{ kind: 'self', nodeid: NODEID, domainid: 'test', userid: 'user/test/alice', limit: 5, filter: 'manual' }]);
    assert.deepStrictEqual(r.out, [{ action: 'events', events: [{ marker: 'self-event' }], nodeid: NODEID, tag: 'test-tag' }]);
});

test('visible full admin: general query despite limit bit', async () => {
    const r = await run({ node: { _id: NODEID }, rights: 0xFFFFFFFF, visible: true });
    assert.deepStrictEqual(r.reads.map(function (x) { return x.kind; }), ['general']);
});

test('short node id is normalized to the domain node id', async () => {
    const seen = [];
    const s = await setup(function (nodeid) { seen.push(nodeid); return { node: null, rights: 0, visible: false }; });
    try {
        const out = sendEvents(s.f, { nodeid: 'abcdefgh' });
        assert.deepStrictEqual(seen, [NODEID]);
        assert.strictEqual(out[0].nodeid, NODEID);
    } finally { s.f.close(); }
});
