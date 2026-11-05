'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const webauthn = require('../webauthn.js').CreateWebAuthnModule();

const ORIGIN = 'https://example.test:8443';
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const sha256 = function (d) { return crypto.createHash('sha256').update(d).digest(); };
const challengeBytes = crypto.randomBytes(64);

// Build a correctly signed assertion; overrides alter one field while keeping the signature valid.
function build(o) {
    o = o || {};
    const counterBuf = Buffer.alloc(4); counterBuf.writeUInt32BE(o.counter == null ? 5 : o.counter);
    const authData = Buffer.concat([sha256(o.rpId || 'example.test'), Buffer.from([o.flags == null ? 0x01 : o.flags]), counterBuf, o.ext || Buffer.alloc(0)]);
    const cd = o.clientDataRaw != null ? Buffer.from(o.clientDataRaw) : Buffer.from(JSON.stringify({
        type: o.type || 'webauthn.get',
        challenge: o.challenge != null ? o.challenge : challengeBytes.toString('base64url'),
        origin: o.origin || ORIGIN
    }), 'utf8');
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(cd)]), keys.privateKey);
    return { authenticatorData: o.authData || authData, clientDataJSON: cd, signature: signature };
}
function expect(o) {
    o = o || {};
    return {
        challenge: 'challenge' in o ? o.challenge : challengeBytes.toString('base64'),
        origin: o.origin || ORIGIN, fmt: 'fido-u2f', publicKey: publicKey,
        prevCounter: 'prevCounter' in o ? o.prevCounter : 4
    };
}
function verify(resp, exp) { return webauthn.verifyAuthenticatorAssertionResponse(resp, exp).verified; }

test('valid assertion verifies and returns counter', function () {
    const r = webauthn.verifyAuthenticatorAssertionResponse(build(), expect());
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.counter, 5);
});

test('wrong challenge rejected even when correctly signed', function () {
    assert.strictEqual(verify(build({ challenge: crypto.randomBytes(64).toString('base64url') }), expect()), false);
});

test('wrong origin rejected even when correctly signed', function () {
    assert.strictEqual(verify(build({ origin: 'https://evil.test:8443' }), expect()), false);
});

test('wrong RP hash rejected even when correctly signed', function () {
    assert.strictEqual(verify(build({ rpId: 'evil.test' }), expect()), false);
});

test('RP hash excludes the port', function () {
    assert.strictEqual(verify(build({ rpId: 'example.test:8443' }), expect()), false);
    assert.strictEqual(verify(build(), expect()), true);
});

test('base64 and base64url challenges are equivalent', function () {
    const b = Buffer.from([0xfb, 0xff, 0xfe, 0xfa, 0x3e, 0x3f]);
    const std = b.toString('base64'), url = b.toString('base64url');
    assert.notStrictEqual(std, url);
    assert.strictEqual(verify(build({ challenge: url }), expect({ challenge: std })), true);
    assert.strictEqual(verify(build({ challenge: std }), expect({ challenge: url })), true);
    assert.strictEqual(verify(build({ challenge: std + '=' }), expect({ challenge: url })), true);
});

test('missing or malformed challenge rejected', function () {
    assert.strictEqual(verify(build(), expect({ challenge: null })), false);
    assert.strictEqual(verify(build(), expect({ challenge: '' })), false);
    assert.strictEqual(verify(build(), expect({ challenge: undefined })), false);
    assert.strictEqual(verify(build({ challenge: '!!!!' }), expect({ challenge: '!!!!' })), false);
    assert.strictEqual(verify(build({ challenge: 'ab cd' }), expect({ challenge: 'ab cd' })), false);
    assert.strictEqual(verify(build({ challenge: undefined, clientDataRaw: JSON.stringify({ type: 'webauthn.get', origin: ORIGIN }) }), expect()), false);
});

test('wrong type rejected', function () {
    assert.strictEqual(verify(build({ type: 'webauthn.create' }), expect()), false);
});

test('malformed clientDataJSON rejected without throwing', function () {
    assert.strictEqual(verify(build({ clientDataRaw: '{not json' }), expect()), false);
    assert.strictEqual(verify(build({ clientDataRaw: 'null' }), expect()), false);
});

test('short authenticator data rejected', function () {
    const r = build(); r.authenticatorData = r.authenticatorData.subarray(0, 36);
    assert.strictEqual(verify(r, expect()), false);
});

test('missing user presence rejected', function () {
    assert.strictEqual(verify(build({ flags: 0x00 }), expect()), false);
});

test('wrong signature rejected', function () {
    const r = build(); r.signature[r.signature.length - 1] ^= 0xff;
    assert.strictEqual(verify(r, expect()), false);
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const exp = expect(); exp.publicKey = other.publicKey.export({ type: 'spki', format: 'pem' });
    assert.strictEqual(verify(build(), exp), false);
});

test('missing or invalid previous counter rejected', function () {
    assert.strictEqual(verify(build(), expect({ prevCounter: undefined })), false);
    assert.strictEqual(verify(build(), expect({ prevCounter: null })), false);
    assert.strictEqual(verify(build(), expect({ prevCounter: -1 })), false);
    assert.strictEqual(verify(build(), expect({ prevCounter: 1.5 })), false);
    assert.strictEqual(verify(build(), expect({ prevCounter: 0x100000000 })), false);
    assert.strictEqual(verify(build(), expect({ prevCounter: '4' })), false);
});

test('counter policy', function () {
    assert.strictEqual(verify(build({ counter: 5 }), expect({ prevCounter: 5 })), false); // equal nonzero
    assert.strictEqual(verify(build({ counter: 0 }), expect({ prevCounter: 5 })), false); // regression to zero
    assert.strictEqual(verify(build({ counter: 4 }), expect({ prevCounter: 5 })), false); // regression
    assert.strictEqual(verify(build({ counter: 0 }), expect({ prevCounter: 0 })), true);  // counterless
    assert.strictEqual(verify(build({ counter: 1 }), expect({ prevCounter: 0 })), true);  // advancing
    assert.strictEqual(verify(build({ counter: 0xFFFFFFFF }), expect({ prevCounter: 0xFFFFFFFE })), true);
});

test('extension bytes are covered by the signature', function () {
    const ext = Buffer.from([0xa1, 0x61, 0x78, 0x01]); // CBOR {"x": 1}
    const good = build({ flags: 0x81, ext: ext });
    assert.strictEqual(verify(good, expect()), true);
    const tampered = { authenticatorData: Buffer.from(good.authenticatorData), clientDataJSON: good.clientDataJSON, signature: good.signature };
    tampered.authenticatorData[tampered.authenticatorData.length - 1] ^= 0x01;
    assert.strictEqual(verify(tampered, expect()), false);
});

test('non-buffer or missing inputs fail closed', function () {
    const r = build();
    assert.strictEqual(verify({ authenticatorData: r.authenticatorData.toString('base64'), clientDataJSON: r.clientDataJSON, signature: r.signature }, expect()), false);
    assert.strictEqual(verify(null, expect()), false);
    assert.strictEqual(verify(r, expect({ origin: 'not a url' })), false);
});
