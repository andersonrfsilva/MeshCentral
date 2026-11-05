'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = 4294967295;
const START = '    function handleCreateAccountRequest(req, res, direct) {';
const END = '    // Called to process an account password reset';
const source = fs.readFileSync(path.join(__dirname, '..', 'webserver.js'), 'utf8');

function occurrences(text, marker) { return text.split(marker).length - 1; }
assert.strictEqual(occurrences(source, START), 1, 'start marker of handleCreateAccountRequest drifted');
assert.strictEqual(occurrences(source, END), 1, 'end marker of handleCreateAccountRequest drifted');
assert.ok(source.indexOf(START) < source.indexOf(END), 'handleCreateAccountRequest markers are out of order');
const handlerSource = source.slice(source.indexOf(START), source.indexOf(END));

// Builds a fresh VM context running the actual handler text from webserver.js with synthetic collaborators.
function createEnv() {
    const env = { maxQueue: [], emailQueue: [], rootCalls: 0, events: [], hashError: null, hashCalls: 0, groupSets: [] };
    const db = {
        isMaxType: function (limit, type, domainid, cb) { env.maxQueue.push(cb); },
        GetUserWithVerifiedEmail: function (domainid, email, cb) { env.emailQueue.push(cb); },
        SetUser: function () { },
        Set: function (doc) { env.groupSets.push(doc); }
    };
    const obj = {
        users: Object.create(null),
        bootstrapClaimed: Object.create(null),
        common: require('../common.js'),
        db: db,
        userGroups: {},
        parent: { DispatchEvent: function (t, s, e) { env.events.push(e); } },
        CloneSafeUser: function (u) { return Object.assign({}, u); },
        getLanguageCodes: function () { return 'en'; }
    };
    const sandbox = {
        obj: obj,
        db: db,
        parent: { config: { settings: {} }, debug: function () { }, DispatchEvent: obj.parent.DispatchEvent },
        checkUserIpAddress: function (req) { return req.domain; },
        getQueryPortion: function () { return ''; },
        handleRootRequestEx: function () { env.rootCalls++; },
        setSessionRandom: function () { },
        require: function (name) {
            if (name !== './pass') { throw new Error('unexpected require: ' + name); }
            return { hash: function (pw, cb) { env.hashCalls++; if (env.hashError) { cb(env.hashError); } else { cb(null, 'salt', 'hash', 'tag'); } } };
        }
    };
    const context = vm.createContext(sandbox);
    env.handler = vm.runInContext(handlerSource + '\nhandleCreateAccountRequest;', context);
    env.obj = obj;

    env.domain = function (id, extra) { return Object.assign({ id: id, url: '/' + id, limits: {}, newaccounts: false }, extra); };
    // Starts one request; returns its response capture.
    env.request = function (domain, name, bodyExtra) {
        const body = Object.assign({ username: name, email: name + '@example.com', password1: 'Passw0rd!x', password2: 'Passw0rd!x' }, bodyExtra);
        const req = { domain: domain, body: body, session: {}, query: {}, clientIp: '127.0.0.1' };
        const res = { status: null, redirected: null, req: req, sendStatus: function (c) { this.status = c; }, redirect: function (u) { this.redirected = u; } };
        env.handler(req, res, false);
        return res;
    };
    env.user = function (domain, name) { return obj.users['user/' + domain.id + '/' + name]; };
    env.claimed = function (domain) { return obj.bootstrapClaimed[domain.id] === true; };
    env.finishMax = function (exceeded) { env.maxQueue.shift()(exceeded === true); };
    env.finishEmail = function (err, docs) { env.emailQueue.shift()(err || null, docs || []); };
    env.complete = function () { env.finishMax(false); env.finishEmail(); };
    return env;
}

test('handler is still registered for POST createaccount', function () {
    assert.ok(source.indexOf("obj.app.post(url + 'createaccount', obj.bodyParser.urlencoded({ extended: false }), handleCreateAccountRequest);") >= 0);
});

test('single account in an empty domain becomes administrator and clears the claim', function () {
    const env = createEnv(), d = env.domain('');
    const res = env.request(d, 'alice');
    assert.ok(env.claimed(d));
    env.complete();
    assert.strictEqual(env.user(d, 'alice').siteadmin, ADMIN);
    assert.strictEqual(res.redirected, '/');
    assert.ok(!env.claimed(d));
});

test('existing-user registration policy is preserved', function () {
    const env = createEnv();
    const closed = env.domain('a'), open = env.domain('b', { newaccounts: true, newaccountsrights: 5 });
    env.obj.users['user/a/root'] = { domain: 'a' };
    env.obj.users['user/b/root'] = { domain: 'b' };
    assert.strictEqual(env.request(closed, 'bob').status, 401);
    assert.strictEqual(env.maxQueue.length, 0);
    env.request(open, 'bob');
    env.complete();
    assert.strictEqual(env.user(open, 'bob').siteadmin, 5);
});

for (const newaccounts of [false, true]) {
    test('overlapping empty-domain requests give one bootstrap owner (newaccounts=' + newaccounts + ')', function () {
        const env = createEnv(), d = env.domain('', { newaccounts: newaccounts, newaccountsrights: 5 });
        const a = env.request(d, 'alice');
        const b = env.request(d, 'bob');
        assert.strictEqual(b.status, 401);
        assert.strictEqual(env.maxQueue.length, 1);
        env.complete();
        assert.strictEqual(env.user(d, 'alice').siteadmin, ADMIN);
        assert.strictEqual(a.redirected, '/');
        // Fresh retry follows normal registration policy.
        const b2 = env.request(d, 'bob');
        if (newaccounts) {
            env.complete();
            assert.strictEqual(env.user(d, 'bob').siteadmin, 5);
        } else {
            assert.strictEqual(b2.status, 401);
        }
    });
}

test('reverse arrival order gives the same guarantee', function () {
    const env = createEnv(), d = env.domain('');
    const b = env.request(d, 'bob');
    const a = env.request(d, 'alice');
    assert.strictEqual(a.status, 401);
    env.complete();
    assert.strictEqual(env.user(d, 'bob').siteadmin, ADMIN);
    assert.strictEqual(env.user(d, 'alice'), undefined);
    assert.strictEqual(b.redirected, '/');
});

test('rejected non-owner cannot release the active claim', function () {
    const env = createEnv(), d = env.domain('');
    env.request(d, 'alice');
    assert.strictEqual(env.request(d, 'bob').status, 401);
    assert.ok(env.claimed(d));
    assert.strictEqual(env.request(d, 'carol').status, 401);
    assert.strictEqual(env.maxQueue.length, 1);
    env.complete();
    assert.ok(!env.claimed(d));
});

test('different domains bootstrap independently, including the default empty id', function () {
    const env = createEnv(), d1 = env.domain(''), d2 = env.domain('two');
    env.request(d1, 'alice');
    env.request(d2, 'bob');
    assert.strictEqual(env.maxQueue.length, 2);
    assert.ok(env.claimed(d1) && env.claimed(d2));
    env.complete(); env.complete();
    assert.strictEqual(env.user(d1, 'alice').siteadmin, ADMIN);
    assert.strictEqual(env.user(d2, 'bob').siteadmin, ADMIN);
});

test('user inserted during validation prevents the stale grant (registration disabled)', function () {
    const env = createEnv(), d = env.domain('');
    const a = env.request(d, 'alice');
    env.finishMax(false);
    env.obj.users['user//intruder'] = { domain: '' };
    env.finishEmail();
    assert.strictEqual(a.status, 401);
    assert.strictEqual(env.user(d, 'alice'), undefined);
    assert.deepStrictEqual(a.req.session, {});
    assert.ok(!env.claimed(d));
});

test('user inserted during validation prevents the stale grant (registration enabled)', function () {
    const env = createEnv(), d = env.domain('', { newaccounts: true, newaccountsrights: 5 });
    env.request(d, 'alice');
    env.finishMax(false);
    env.obj.users['user//intruder'] = { domain: '' };
    env.finishEmail();
    assert.strictEqual(env.user(d, 'alice').siteadmin, 5);
    assert.ok(!env.claimed(d));
});

// Each failure branch must release the claim so another request can bootstrap.
const failures = {
    'missing email with allowed email domains': { domain: { newaccountemaildomains: ['example.com'] }, body: { email: undefined }, sync: true },
    'disallowed email domain': { domain: { newaccountemaildomains: ['other.com'] }, sync: true },
    'account limit': { max: true },
    'invalid password': { body: { password2: 'different' } },
    'verified-email conflict': { emailDocs: [{ _id: 'user//x' }] },
    'verified-email lookup error': { emailErr: new Error('db down') },
    'existing username': { preUser: true }
};
for (const name of Object.keys(failures)) {
    test('claim is released after failure: ' + name, function () {
        const f = failures[name];
        const env = createEnv(), d = env.domain('', f.domain);
        if (f.preUser) { env.obj.users['user//alice'] = { domain: '1' }; }
        const a = env.request(d, 'alice', f.body);
        if (f.sync) {
            assert.strictEqual(env.maxQueue.length, 0);
        } else if (f.max) {
            env.finishMax(true);
        } else {
            env.finishMax(false);
            if (f.body) { /* validation failure ends before the email lookup */ } else { env.finishEmail(f.emailErr, f.emailDocs); }
        }
        assert.ok(!env.claimed(d), 'claim survived');
        assert.strictEqual(env.hashCalls, 0);
        assert.notStrictEqual(a.status, 401);
        // Another request can acquire the slot (and so is not rejected).
        delete env.obj.users['user//alice'];
        const b = env.request(env.domain(''), 'bob');
        assert.strictEqual(b.status, null);
        assert.ok(env.claimed(d));
        env.complete();
        assert.strictEqual(env.user(d, 'bob').siteadmin, ADMIN);
    });
}

test('hash error throws after the claim was released, publication order unchanged', function () {
    const env = createEnv(), d = env.domain('');
    env.hashError = new Error('hash failed');
    env.request(d, 'alice');
    env.finishMax(false);
    assert.throws(function () { env.finishEmail(); }, /hash failed/);
    assert.ok(!env.claimed(d));
    assert.ok(env.user(d, 'alice'));
});
