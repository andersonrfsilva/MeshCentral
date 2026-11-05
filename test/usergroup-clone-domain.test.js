'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

const SRC = 'ugrp/other/source';

// Builds a session in domain 'test' (plus configured domain 'other' and default domain '') and dispatches one createusergroup command.
// Resolves with the response and the captured side effects once the server answers.
async function run(command, opts) {
    opts = opts || {};
    const f = await createMeshUserFixture({
        domain: { id: 'test' },
        user: { siteadmin: 256 },
        extraDomains: { other: { id: 'other', limits: {} }, '': { id: '', limits: {} } },
        managecrossdomain: opts.crossDomain ? ['user/test/testuser'] : undefined
    });
    const sets = [];
    f.db.Set = function (o) { sets.push(o); };
    f.parent.userGroups[SRC] = { type: 'ugrp', _id: SRC, domain: 'other', links: {} };
    f.parent.userGroups['ugrp/test/own'] = { type: 'ugrp', _id: 'ugrp/test/own', domain: 'test', links: {} };
    const groupsBefore = Object.keys(f.parent.userGroups).length;
    f.clearCaptures();
    const response = new Promise(function (resolve) {
        const orig = f.ws.send;
        f.ws.send = function (data) {
            orig(data);
            const m = JSON.parse(data);
            if (m.responseid === 'r1') { resolve(m); }
        };
    });
    f.ws.emit('message', Buffer.from(JSON.stringify(Object.assign({ action: 'createusergroup', name: 'Clone', responseid: 'r1' }, command))));
    const res = await response;
    const out = {
        res: res, sets: sets, events: f.events.slice(), dbUsers: f.dbUsers.slice(),
        newGroups: Object.keys(f.parent.userGroups).length - groupsBefore
    };
    f.close();
    return out;
}

function assertDenied(r, msg) {
    assert.notStrictEqual(r.res.result, 'ok', msg);
    assert.strictEqual(r.sets.length, 0);
    assert.strictEqual(r.dbUsers.length, 0);
    assert.strictEqual(r.newGroups, 0);
    assert.strictEqual(r.events.length, 0);
}

test('non-cross-domain admin cannot clone another domain group, whatever command.domain says', async function () {
    for (const d of [undefined, 'test', 'other']) {
        const command = { clone: SRC };
        if (d !== undefined) { command.domain = d; }
        assertDenied(await run(command), 'domain=' + d);
    }
});

test('own-domain clone allowed with domain absent or equal to own', async function () {
    for (const d of [undefined, 'test']) {
        const command = { clone: 'ugrp/test/own' };
        if (d !== undefined) { command.domain = d; }
        const r = await run(command);
        assert.strictEqual(r.res.result, 'ok', 'domain=' + d);
        assert.strictEqual(r.sets[0].domain, 'test');
        assert.ok(r.res.ugrpid.startsWith('ugrp/test/'));
    }
});

test('own-domain clone with explicit other domain is denied', async function () {
    assertDenied(await run({ clone: 'ugrp/test/own', domain: 'other' }));
});

test('non-clone creation in another domain is denied, not redirected', async function () {
    assertDenied(await run({ domain: 'other' }));
});

test('wrong-type, unknown and inherited domain values are denied', async function () {
    for (const d of [5, ['other'], { id: 'other' }, 'nonexistent', 'toString', '__proto__']) {
        assertDenied(await run({ domain: d }), JSON.stringify(d));
        assertDenied(await run({ clone: 'ugrp/test/own', domain: d }), JSON.stringify(d));
    }
});

test('default domain empty string accepted when configured, for a requester in that domain', async function () {
    const r = await run({ domain: '' }, { crossDomain: true });
    assert.strictEqual(r.res.result, 'ok');
    assert.strictEqual(r.sets[0].domain, '');
});

test('malformed or missing clone sources are denied', async function () {
    for (const c of ['ugrp/test', 'ugrp/test/a/b', 'mesh/test/own', 'ugrp/test/missing', 5]) {
        assertDenied(await run({ clone: c }), String(c));
    }
});

test('cross-domain admin clones other-domain group into the source domain', async function () {
    for (const d of [undefined, 'other', 'test']) {
        const command = { clone: SRC };
        if (d !== undefined) { command.domain = d; }
        const r = await run(command, { crossDomain: true });
        assert.strictEqual(r.res.result, 'ok', 'domain=' + d);
        assert.strictEqual(r.sets[0].domain, 'other');
        assert.ok(r.res.ugrpid.startsWith('ugrp/other/'));
    }
});

test('cross-domain admin creates a non-clone group in the requested domain', async function () {
    const r = await run({ domain: 'other' }, { crossDomain: true });
    assert.strictEqual(r.res.result, 'ok');
    assert.strictEqual(r.sets[0].domain, 'other');
    assert.ok(r.res.ugrpid.startsWith('ugrp/other/'));
});
