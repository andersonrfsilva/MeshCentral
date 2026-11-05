'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

const NODE = 'node/test/n1';
const TARGET = 'user/test/target';

// Rights are derived from the user passed to GetNodeWithRights, never from a fixed value.
async function setup(rightsByUser, relay) {
    const f = await createMeshUserFixture({ domain: { id: 'test' } });
    const lookups = [];
    f.parent.users[TARGET] = { _id: TARGET, name: 'target', domain: 'test' };
    f.parent.GetNodeWithRights = function (domainArg, userArg, nodeidArg, callback) {
        lookups.push({ domain: domainArg, user: userArg, nodeid: nodeidArg });
        callback({ _id: nodeidArg }, rightsByUser[userArg._id] || 0, true);
    };
    const closed = [];
    function viewer(userid, guestName) {
        const v = { user: { _id: userid }, guestName: guestName };
        v.close = function () {
            closed.push(v);
            const i = relay.viewers.indexOf(v);
            if (i >= 0) { relay.viewers.splice(i, 1); }
        };
        return v;
    }
    if (typeof relay === 'function') { relay = relay(viewer); }
    if (relay !== undefined) { f.parent.desktoprelays[NODE] = relay; }
    f.clearCaptures();
    return { f: f, lookups: lookups, closed: closed, relay: relay };
}

function send(f, command) { f.ws.emit('message', Buffer.from(JSON.stringify(command))); }
function endSessions(f) { return f.events.filter(function (e) { return e.event.action == 'endsession'; }); }
function makeRelay(viewers) { return function (viewer) { const r = { viewers: [] }; viewers.forEach(function (a) { r.viewers.push(viewer(a[0], a[1])); }); return r; }; }

test('requester without rights cannot close target viewers (target has full rights)', async function () {
    const s = await setup({ [TARGET]: 0xFFFFFFFF }, makeRelay([[TARGET]]));
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: TARGET });
    assert.strictEqual(s.lookups.length, 1);
    assert.strictEqual(s.lookups[0].user._id, s.f.user._id);
    assert.strictEqual(s.closed.length, 0);
    assert.strictEqual(endSessions(s.f).length, 0);
    s.f.close();
});

test('self disconnect is allowed without node rights', async function () {
    const s = await setup({}, makeRelay([[undefined]]));
    s.relay.viewers[0].user._id = s.f.user._id;
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: s.f.user._id });
    assert.strictEqual(s.lookups[0].user._id, s.f.user._id);
    assert.strictEqual(s.closed.length, 1);
    const ev = endSessions(s.f);
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].event.userid, s.f.user._id);
    s.f.close();
});

for (const [name, rights] of [['remote control bit', 0x08], ['full rights', 0xFFFFFFFF]]) {
    test('requester with ' + name + ' can close target viewers', async function () {
        const s = await setup({ ['user/test/testuser']: rights }, makeRelay([[TARGET]]));
        send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: TARGET });
        assert.strictEqual(s.lookups[0].user._id, s.f.user._id);
        assert.strictEqual(s.closed.length, 1);
        const ev = endSessions(s.f);
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].event.userid, s.f.user._id);
        assert.strictEqual(ev[0].event.xuserid, TARGET);
        assert.strictEqual(ev[0].source, s.f.obj);
        s.f.close();
    });
}

test('requester with only an unrelated right is denied', async function () {
    const s = await setup({ ['user/test/testuser']: 0x01 }, makeRelay([[TARGET]]));
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: TARGET });
    assert.strictEqual(s.closed.length, 0);
    assert.strictEqual(endSessions(s.f).length, 0);
    s.f.close();
});

test('missing or constructing relay closes nothing and does not throw', async function () {
    for (const relay of [undefined, 1]) {
        const s = await setup({ ['user/test/testuser']: 0xFFFFFFFF }, relay);
        send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: TARGET });
        assert.strictEqual(s.lookups.length, 1);
        assert.strictEqual(s.closed.length, 0);
        assert.strictEqual(endSessions(s.f).length, 0);
        assert.strictEqual(s.f.errors.length, 0);
        s.f.close();
    }
});

test('all matching viewers close even though close mutates the list', async function () {
    const s = await setup({ ['user/test/testuser']: 0x08 }, makeRelay([[TARGET], [TARGET], ['user/test/other'], [TARGET, 'guest']]));
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: TARGET });
    assert.strictEqual(s.closed.length, 2);
    assert.strictEqual(s.relay.viewers.length, 2);
    s.f.close();
});

test('guest name must match', async function () {
    const s = await setup({ ['user/test/testuser']: 0x08 }, makeRelay([[TARGET], [TARGET, 'guest'], [TARGET, 'other']]));
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: TARGET, guestname: 'guest' });
    assert.strictEqual(s.closed.length, 1);
    assert.strictEqual(s.closed[0].guestName, 'guest');
    assert.strictEqual(s.relay.viewers.length, 2);
    const ev = endSessions(s.f);
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].event.guestname, 'guest');
    s.f.close();
});

test('unknown and cross-domain targets are rejected before the rights lookup', async function () {
    const s = await setup({ ['user/test/testuser']: 0xFFFFFFFF }, makeRelay([[TARGET]]));
    s.f.parent.users['user/other/x'] = { _id: 'user/other/x', name: 'x', domain: 'other' };
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: 'user/test/missing', responseid: 'r1' });
    send(s.f, { action: 'endDesktopMultiplex', nodeid: NODE, xuserid: 'user/other/x', responseid: 'r2' });
    assert.strictEqual(s.lookups.length, 0);
    assert.strictEqual(s.closed.length, 0);
    assert.strictEqual(s.f.sent.length, 2);
    assert.strictEqual(JSON.parse(s.f.sent[0]).result, 'User does not exists');
    assert.strictEqual(JSON.parse(s.f.sent[1]).result, 'Invalid domain');
    s.f.close();
});
