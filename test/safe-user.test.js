'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CloneSafeUser } = require('../common.js');

const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

// Synthetic account; every secret is a placeholder.
function makeUser(extra) {
    return Object.assign({
        _id: 'user//alice', name: 'alice', email: 'alice@example.invalid', creation: 1, links: { 'mesh//x': { rights: 1 } },
        hash: 'HASH', salt: 'SALT', passhint: 'HINT', type: 'user', domain: '', subscriptions: {}, passtype: 2
    }, extra);
}

function deepFreeze(o) {
    if ((o != null) && (typeof o == 'object') && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
}

test('populated history is removed from clone', function () {
    const history = [{ salt: 'S1', hash: 'H1', start: 1, end: 2 }, { salt: 'S2', hash: 'H2', start: 2, end: 3 }];
    const user = deepFreeze(makeUser({ oldpasswords: history }));
    const r = CloneSafeUser(user);
    assert.strictEqual(has(r, 'oldpasswords'), false);
    assert.strictEqual(user.oldpasswords, history);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[1].hash, 'H2');
});

test('empty history is removed from clone', function () {
    const r = CloneSafeUser(makeUser({ oldpasswords: [] }));
    assert.strictEqual(has(r, 'oldpasswords'), false);
});

test('absent history leaves no property', function () {
    const r = CloneSafeUser(makeUser());
    assert.strictEqual(has(r, 'oldpasswords'), false);
});

test('non-array history is removed from clone', function () {
    [null, 'text', 5, { hash: 'H' }].forEach(function (v) {
        const r = CloneSafeUser(makeUser({ oldpasswords: v }));
        assert.strictEqual(has(r, 'oldpasswords'), false);
    });
});

test('current secrets are stripped and public fields kept', function () {
    const user = makeUser({ oldpasswords: [] });
    const r = CloneSafeUser(user);
    ['hash', 'salt', 'passhint', 'type', 'domain', 'subscriptions', 'passtype'].forEach(function (k) { assert.strictEqual(has(r, k), false, k); });
    assert.notStrictEqual(r, user);
    assert.strictEqual(r._id, 'user//alice');
    assert.strictEqual(r.name, 'alice');
    assert.strictEqual(r.email, 'alice@example.invalid');
    assert.strictEqual(r.creation, 1);
    assert.strictEqual(r.links, user.links);
});

test('frozen input is unchanged', function () {
    const user = deepFreeze(makeUser({ oldpasswords: [{ salt: 'S', hash: 'H', start: 1, end: 2 }], otpsecret: 'SECRET', otphkeys: [{ a: 1 }] }));
    const before = JSON.stringify(user);
    CloneSafeUser(user);
    assert.strictEqual(JSON.stringify(user), before);
    assert.strictEqual(user.hash, 'HASH');
    assert.strictEqual(user.salt, 'SALT');
});

test('2FA and webpush fields become indicators', function () {
    const user = deepFreeze(makeUser({
        otpsms: '+000', otpmsg: 'x', otpekey: { k: 1 }, otpduo: { d: 1 }, otpsecret: 'SECRET',
        otpkeys: { keys: [{ u: false }, { u: true }] }, otphkeys: [{}, {}], otpdev: 'dev', webpush: [{}, {}, {}]
    }));
    const r = CloneSafeUser(user);
    assert.strictEqual(has(r, 'otpsms'), false);
    assert.strictEqual(has(r, 'otpmsg'), false);
    assert.strictEqual(r.otpekey, 1);
    assert.strictEqual(r.otpduo, 1);
    assert.strictEqual(r.otpsecret, 1);
    assert.strictEqual(r.otpkeys, 1);
    assert.strictEqual(r.otphkeys, 2);
    assert.strictEqual(r.otpdev, 1);
    assert.strictEqual(r.webpush, 3);
    assert.strictEqual(CloneSafeUser(makeUser({ otpkeys: { keys: [{ u: false }] } })).otpkeys, 0);
});

test('primitives pass through', function () {
    assert.strictEqual(CloneSafeUser('x'), 'x');
    assert.strictEqual(CloneSafeUser(7), 7);
    assert.strictEqual(CloneSafeUser(undefined), undefined);
});

test('webserver binds the common implementation directly', function () {
    const src = fs.readFileSync(path.join(__dirname, '..', 'webserver.js'), 'utf8');
    assert.strictEqual(src.split('obj.CloneSafeUser = obj.common.CloneSafeUser;').length - 1, 1);
    assert.strictEqual(/obj\.CloneSafeUser\s*=\s*function/.test(src), false);
});
