'use strict';

// Characterizes the shared predicate only; this is not SQL integration coverage.
const { test } = require('node:test');
const assert = require('node:assert');
const common = require('../common.js');

test('filterVerifiedEmailUsers keeps strictly verified users', function () {
    const doc = { type: 'user', emailVerified: true, _id: 'user//a' };
    const out = common.filterVerifiedEmailUsers([doc]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0], doc);
});

test('filterVerifiedEmailUsers rejects non-strict verification flags', function () {
    [false, undefined, null, 0, 1, 'true'].forEach(function (flag) {
        const doc = { type: 'user' };
        if (flag !== undefined) { doc.emailVerified = flag; }
        assert.deepStrictEqual(common.filterVerifiedEmailUsers([doc]), [], 'flag ' + String(flag));
    });
});

test('filterVerifiedEmailUsers rejects non-user and missing type', function () {
    assert.deepStrictEqual(common.filterVerifiedEmailUsers([
        { type: 'mesh', emailVerified: true },
        { emailVerified: true }
    ]), []);
});

test('filterVerifiedEmailUsers keeps order and does not mutate input', function () {
    const a = { type: 'user', emailVerified: true, _id: 'a', links: { 'x%2Ey': { rights: 1 } } };
    const b = { type: 'user', emailVerified: false, _id: 'b' };
    const c = { type: 'mesh', emailVerified: true, _id: 'c' };
    const d = { type: 'user', emailVerified: true, _id: 'd' };
    const input = [a, b, c, d];
    const snapshot = JSON.stringify(input);
    const out = common.filterVerifiedEmailUsers(input);
    assert.deepStrictEqual(out.map(function (x) { return x._id; }), ['a', 'd']);
    assert.strictEqual(out[0], a);
    assert.strictEqual(out[1], d);
    assert.notStrictEqual(out, input);
    assert.strictEqual(input.length, 4);
    assert.strictEqual(JSON.stringify(input), snapshot);
});

test('filterVerifiedEmailUsers returns empty list and preserves null/undefined', function () {
    assert.deepStrictEqual(common.filterVerifiedEmailUsers([]), []);
    assert.strictEqual(common.filterVerifiedEmailUsers(null), null);
    assert.strictEqual(common.filterVerifiedEmailUsers(undefined), undefined);
});

test('filtering must happen before type is deleted', function () {
    // SQLite removes doc.type after querying, so filtering afterwards would reject every verified user.
    const doc = { type: 'user', emailVerified: true };
    assert.strictEqual(common.filterVerifiedEmailUsers([doc]).length, 1);
    delete doc.type;
    assert.strictEqual(common.filterVerifiedEmailUsers([doc]).length, 0);
});
