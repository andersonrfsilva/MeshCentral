'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const common = require('../common.js');

// Test-only key: 48 bytes of HMAC key followed by 32 bytes of AES key
const KEY = Buffer.alloc(80); for (let i = 0; i < 80; i++) { KEY[i] = (i * 7 + 3) & 0xff; }
const IV = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const NOW = 1800000000000;

// Independent legacy-format encoder: base64(IV || AES-256-CBC(MAC || payload)), '+' -> '@', '/' -> '$'
function encode(obj, opts) {
    opts = opts || {};
    const key = opts.key || KEY;
    const payload = Buffer.from(opts.rawPayload != null ? opts.rawPayload : JSON.stringify(obj), 'utf8');
    const mac = crypto.createHmac('sha384', key.subarray(0, 48)).update(payload).digest();
    if (opts.flipMac != null) { mac[opts.flipMac] ^= 0x01; }
    const plain = opts.plain || Buffer.concat([mac, payload]);
    const c = crypto.createCipheriv('aes-256-cbc', key.subarray(48, 80), opts.iv || IV);
    const raw = Buffer.concat([opts.iv || IV, c.update(plain), c.final()]);
    return raw.toString(opts.encoding || 'base64').replace(/\+/g, '@').replace(/\//g, '$');
}

function withNow(fn) {
    const orig = Date.now;
    Date.now = function () { return NOW; };
    try { return fn(); } finally { Date.now = orig; }
}

test('aessha cookie: valid cookie decodes with Unicode, time conversion and encodings', function () {
    withNow(function () {
        const obj = { userid: 'user//ç漢字😀', time: NOW / 1000 - 10 };
        const r = common.decodeCookieAESSHA(encode(obj), KEY);
        assert.strictEqual(r.userid, obj.userid);
        assert.strictEqual(r.time, obj.time * 1000);
        assert.strictEqual(r.dtime, 10000);
        const h = common.decodeCookieAESSHA(encode(obj, { encoding: 'hex' }), KEY, null, 'hex');
        assert.strictEqual(h.userid, obj.userid);
        // Custom base64 substitutions are exercised by finding a cookie that contains them
        let found = false;
        for (let i = 0; i < 200 && !found; i++) {
            const o = { n: i, pad: 'x'.repeat(i), time: NOW / 1000 };
            const c = encode(o);
            if (/[@$]/.test(c)) { found = true; assert.strictEqual(common.decodeCookieAESSHA(c, KEY).n, i); }
        }
        assert.ok(found);
    });
});

test('aessha cookie: wrong embedded MAC returns null, including first and last byte', function () {
    withNow(function () {
        const obj = { userid: 'u', time: NOW / 1000 };
        assert.ok(common.decodeCookieAESSHA(encode(obj), KEY));
        for (const idx of [0, 1, 23, 46, 47]) {
            assert.strictEqual(common.decodeCookieAESSHA(encode(obj, { flipMac: idx }), KEY), null, 'MAC byte ' + idx);
        }
        // MAC computed over different bytes than the payload
        const other = crypto.createHmac('sha384', KEY.subarray(0, 48)).update('other').digest();
        const p = Buffer.from(JSON.stringify(obj));
        assert.strictEqual(common.decodeCookieAESSHA(encode(obj, { plain: Buffer.concat([other, p]) }), KEY), null);
        // Wrong key, short key, non-Buffer key
        assert.strictEqual(common.decodeCookieAESSHA(encode(obj), Buffer.alloc(80, 9)), null);
        assert.strictEqual(common.decodeCookieAESSHA(encode(obj), KEY.subarray(0, 79)), null);
        assert.strictEqual(common.decodeCookieAESSHA(encode(obj), KEY.toString('latin1')), null);
    });
});

test('aessha cookie: malformed framing and payload return null without throwing', function () {
    withNow(function () {
        const obj = { time: NOW / 1000 };
        const good = encode(obj);
        assert.strictEqual(common.decodeCookieAESSHA(null, KEY), null);
        assert.strictEqual(common.decodeCookieAESSHA('', KEY), null);
        assert.strictEqual(common.decodeCookieAESSHA(Buffer.alloc(8).toString('base64'), KEY), null); // Short IV
        assert.strictEqual(common.decodeCookieAESSHA(Buffer.alloc(16).toString('base64'), KEY), null); // No ciphertext
        assert.strictEqual(common.decodeCookieAESSHA(Buffer.alloc(40).toString('base64'), KEY), null); // Unaligned ciphertext
        assert.strictEqual(common.decodeCookieAESSHA(Buffer.alloc(32, 1).toString('base64'), KEY), null); // Invalid padding
        const raw = Buffer.from(good.replace(/@/g, '+').replace(/\$/g, '/'), 'base64');
        assert.strictEqual(common.decodeCookieAESSHA(raw.subarray(0, raw.length - 16).toString('base64'), KEY), null); // Truncated
        assert.strictEqual(common.decodeCookieAESSHA(encode(null, { plain: Buffer.alloc(20) }), KEY), null); // Shorter than MAC
        assert.strictEqual(common.decodeCookieAESSHA(encode(null, { plain: Buffer.alloc(48) }), KEY), null); // MAC only, no payload
        assert.strictEqual(common.decodeCookieAESSHA(encode(null, { rawPayload: '{not json' }), KEY), null); // Authenticated bad JSON
        assert.strictEqual(common.decodeCookieAESSHA(encode(null, { rawPayload: 'null' }), KEY), null);
        assert.strictEqual(common.decodeCookieAESSHA(encode({ a: 1 }), KEY), null); // Missing time
        assert.strictEqual(common.decodeCookieAESSHA(encode({ time: '123' }), KEY), null); // Non-numeric time
    });
});

test('aessha cookie: default and custom timeout, future skew', function () {
    withNow(function () {
        const t = NOW / 1000;
        assert.ok(common.decodeCookieAESSHA(encode({ time: t - 119 }), KEY));
        assert.strictEqual(common.decodeCookieAESSHA(encode({ time: t - 121 }), KEY), null);
        assert.ok(common.decodeCookieAESSHA(encode({ time: t - 121 }), KEY, 5));
        assert.strictEqual(common.decodeCookieAESSHA(encode({ time: t - 301 }), KEY, 5), null);
        assert.ok(common.decodeCookieAESSHA(encode({ time: t + 29 }), KEY));
        assert.strictEqual(common.decodeCookieAESSHA(encode({ time: t + 31 }), KEY), null);
    });
});

test('aessha cookie: numeric expire overrides timeout and expire 0 disables the window', function () {
    withNow(function () {
        const t = NOW / 1000;
        assert.ok(common.decodeCookieAESSHA(encode({ time: t - 600, expire: 15 }), KEY)); // Beyond default timeout, inside expire
        assert.strictEqual(common.decodeCookieAESSHA(encode({ time: t - 1000, expire: 15 }), KEY, 60), null); // Timeout argument ignored
        assert.strictEqual(common.decodeCookieAESSHA(encode({ time: t + 31, expire: 15 }), KEY), null);
        assert.ok(common.decodeCookieAESSHA(encode({ time: t - 86400 * 365, expire: 0 }), KEY));
        assert.ok(common.decodeCookieAESSHA(encode({ time: t + 86400, expire: 0 }), KEY));
        assert.ok(common.decodeCookieAESSHA(encode({ time: t - 600, expire: 'x' }), KEY, 15)); // Non-numeric expire falls back to timeout
    });
});
