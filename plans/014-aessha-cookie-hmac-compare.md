# Plan 014: Authenticate legacy AES-CBC cookies using byte-preserving constant-time HMAC comparison

> **Executor instructions**: Follow each step and run its verification command before proceeding. Stop and report on a STOP condition; do not improvise. Update this plan's row in `plans/README.md` unless the reviewer owns the index. If the index is absent, skip and note it.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- common.js meshcentral.js test/aessha-cookie.test.js plans/014-aessha-cookie-hmac-compare.md plans/README.md`
> Compare changed source against Current state before proceeding. Plan 001's test infrastructure is expected; changed decoder semantics require reconciliation.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/001-test-baseline.md`
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

The legacy decoder reverses the meaning of an HMAC comparison and converts arbitrary binary bytes through UTF-8 strings. A mismatched HMAC can therefore reach JSON parsing and cookie acceptance. Extracting the decoder into the existing shared module makes the byte-level authentication boundary directly testable without starting MeshCentral.

## Current state

`meshcentral.js` owns the public cookie APIs. `common.js` is already available as `obj.common`:

```js
// meshcentral.js:47
obj.common = common;
// common.js:17-19
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
// common.js:33
module.exports.Clone = function (v) { return JSON.parse(JSON.stringify(v)); };
```

Reuse that CommonJS export convention; no new module or dependency is needed.

```js
// meshcentral.js:4000-4003
obj.decodeCookie = function (cookie, key, timeout) {
    if (cookie == null) return null;
    var r = obj.decodeCookieAESGCM(cookie, key, timeout);
    if (r === -1) { r = obj.decodeCookieAESSHA(cookie, key, timeout); } // If decodeCookieAESGCM() failed to decode, try decodeCookieAESSHA()
// meshcentral.js:4060-4070
obj.decodeCookieAESSHA = function (cookie, key, timeout) {
    try {
        if (key == null) { key = obj.serverKey; }
        if (key.length < 80) { return null; }
        cookie = Buffer.from(cookie.replace(/\@/g, '+').replace(/\$/g, '/'), obj.args.cookieencoding ? obj.args.cookieencoding : 'base64');
        const decipher = obj.crypto.createDecipheriv('aes-256-cbc', key.slice(48, 80), cookie.slice(0, 16));
        const rawmsg = decipher.update(cookie.slice(16), 'binary', 'binary') + decipher.final('binary');
        const hmac = obj.crypto.createHmac('sha384', key.slice(0, 48));
        hmac.update(rawmsg.slice(48));
        if (Buffer.compare(hmac.digest(), Buffer.from(rawmsg.slice(0, 48))) == false) { return null; }
        const o = JSON.parse(rawmsg.slice(48).toString('utf8'));
```

`Buffer.compare` returns zero for equal bytes, so `== false` rejects equality. Moreover, `rawmsg` is a binary/Latin-1 string, whereas `Buffer.from(rawmsg.slice(0, 48))` and `hmac.update(string)` use UTF-8 by default. Fix both problems, not only the operator.

`meshcentral.js:4071-4084` validates numeric `time`, converts seconds to milliseconds, sets `dtime`, and applies a default two-minute timeout plus 30-second future-clock allowance. Numeric `expire` overrides timeout; `expire === 0` bypasses the existing time-window check. Preserve that behavior in this focused change. Failures return null and emit existing debug messages. The outer `decodeCookie` also handles once-only cookies (`meshcentral.js:4008-4031`); do not move or alter that table logic.

The current encoder is AES-GCM (`meshcentral.js:3986-3996`), not AES-CBC. No legacy producer was confirmed during this plan's source inspection. Tests must create their own legacy-format encoder; they must not assume the current `encodeCookie` produces this format. Do not infer that an external producer cannot exist.

Match CommonJS, four spaces, single quotes, and compact guard returns shown above. Use Node >=20.19. `package.json:58-60` declares Node >=20; Plan 001 supplies the missing test infrastructure.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c common.js && node -c meshcentral.js` | Exit 0 |
| Focused tests | `node --test test/aessha-cookie.test.js` | All pass |
| Full tests | `npm test` | All pass |
| Old comparison | `grep -n 'Buffer.compare(hmac.digest()' meshcentral.js common.js` | No matches, exit 1 |
| Scope | `git diff --name-only` | Only Scope paths changed |

## Scope

**In scope**:
- `common.js`
- `meshcentral.js`
- `test/aessha-cookie.test.js` (create)
- `plans/014-aessha-cookie-hmac-compare.md` (completion evidence)
- `plans/README.md` (status only, if present)

**Out of scope**: AES-GCM encoding/decoding, key generation, once-only cookie storage, changing expiry policy, external Router/Installer clients, production credentials, format migration or removal of the legacy fallback.

## Git workflow

- Branch: `advisor/014-aessha-cookie-hmac-compare`.
- Preserve unrelated user edits.
- Commit: `security: authenticate legacy AES cookies correctly`; append a real `(#NNNN)` only when supplied.
- Do not push or open a PR without instruction.

## Steps

### Step 1: Add an independent legacy-format fixture encoder

STOP if `npm test` is absent. Create `test/aessha-cookie.test.js` using `const { test } = require('node:test'); const assert = require('node:assert');`, matching Plan 001's tests.

Use test-only 80-byte keys and 16-byte IVs. The fixture format is precisely:

```text
payload = UTF8(JSON.stringify(object))
mac = HMAC-SHA384(key[0:48], payload)       # 48 raw bytes
plaintext = mac || payload
ciphertext = AES-256-CBC(key[48:80], IV, plaintext) with default PKCS#7 padding
cookie = base64(IV || ciphertext), replacing + with @ and / with $
```

Use `crypto.createCipheriv`, `Buffer.concat`, and `.digest()` returning a Buffer. For a decisive invalid-HMAC fixture, alter the MAC before encrypting the unchanged valid JSON payload. This preserves valid CBC padding and JSON while isolating the authentication failure. Add Unicode payload text to expose accidental UTF-8/Latin-1 conversion. Do not persist a production key or add a production legacy encoder.

**Verify**: `node -c test/aessha-cookie.test.js` → exit 0. Initially this gate checks fixture syntax only.

### Step 2: Extract and correct the decoder in common.js

Add `module.exports.decodeCookieAESSHA = function (cookie, key, timeout, encoding, debug) { ... };` in `common.js`. Explicit inputs replace the parent closure: the caller resolves its default key, the helper defaults encoding to base64, and optional `debug` receives the existing `(source, message)` arguments. The helper returns the decoded object or null and owns the former body's time validation, byte authentication and exception handling. Do not capture a server instance or import `meshcentral.js` from tests.

Require a Buffer key at least 80 bytes long and a string cookie. Decode custom `@`/`$` substitutions using the supplied encoding. Reject too-short/truncated layouts before cryptography: IV is 16 bytes, ciphertext is nonempty and a multiple of 16, and decrypted plaintext must contain at least the 48-byte MAC plus a payload. Use `Buffer.concat([decipher.update(ciphertext), decipher.final()])`; never ask crypto for a binary string.

Slice the stored 48-byte MAC and remaining payload as Buffers. Compute `crypto.createHmac('sha384', key.subarray(0, 48)).update(payload).digest()`. Check equal lengths and then require `crypto.timingSafeEqual(expectedMac, storedMac)` to be true. Return null on mismatch before parsing JSON. Only authenticated payload bytes may become `payload.toString('utf8')` and reach `JSON.parse`.

Move the existing time/expiry validation and debug messages with the decoder, preserving default timeout, milliseconds conversion, `dtime`, future-skew allowance, `expire === 0`, return-null failure semantics and exceptions caught at the API boundary. Do not log keys or raw cookie bytes. Keep existing comments explaining expiry behavior; update only references made inaccurate by extraction.

Replace the old `obj.decodeCookieAESSHA` body with delegation to `obj.common.decodeCookieAESSHA(cookie, key == null ? obj.serverKey : key, timeout, obj.args.cookieencoding, obj.debug)`. The wrapper remains the server's public API and supplies its state; the extracted implementation must exist only once. Leave the AES-GCM-first fallback at line 4003 intact.

**Verify**: `node -c common.js && node -c meshcentral.js && node --test test/aessha-cookie.test.js` → syntax passes; a valid fixture decodes and the correctly encrypted wrong-MAC fixture returns null.

### Step 3: Lock down format and expiry compatibility

Call the common export directly in tests. Assert decoded fields and UTF-8 text, converted `time`, and numeric `dtime`. Use a controlled `Date.now` in non-concurrent tests with teardown restoration, or times safely away from boundaries. Cover base64 custom substitutions and configured hex encoding, short keys, wrong keys, short IV/ciphertext, invalid padding, plaintext shorter than the MAC, malformed authenticated JSON, missing/non-numeric time, expired default/custom timeout, future timestamps beyond 30 seconds, numeric expire override and `expire === 0` behavior. Assert failures return null rather than throwing. Include a mismatch in the first and last MAC bytes using valid ciphertext.

Do not import the executable MeshCentral entry point merely to test the wrapper. Review that the wrapper forwards timeout, resolved default key, encoding and debug; use source-level scope review for this trivial adapter and direct functional tests for the complete decoder body.

**Verify**: `node --test test/aessha-cookie.test.js` → all named cases pass. `grep -n 'Buffer.compare(hmac.digest()' meshcentral.js common.js` → no output, exit 1.

### Step 4: Record and finish

Run the full suite and document the byte-preserving HMAC change in completion notes here. Update the index if present. A live legacy client/server is not required; skip and note live interoperability when unavailable.

**Verify**: `npm test && git diff --name-only` → all tests pass; changed files are within Scope.

## Test plan

Use Plan 001's Node test conventions. All fixtures and tests belong in `test/aessha-cookie.test.js`. The independent encoder implements the observed wire layout, not the production decoder's internal conversions. The critical regression is a validly encrypted, parseable cookie with the wrong embedded HMAC returning null; a random corrupt cookie alone would only prove padding rejection. Positive tests cover Unicode, default/custom encoding and time semantics. Negative tests cover MAC, key, framing, JSON and expiry failures. `node --test test/aessha-cookie.test.js` and `npm test` must pass without starting a server.

## Done criteria

- [ ] Syntax checks for both source files pass.
- [ ] Focused tests and `npm test` pass.
- [ ] Valid legacy-format fixtures decode; wrong embedded MAC never reaches acceptance.
- [ ] The decoder uses Buffers until authenticated JSON decoding and uses `crypto.timingSafeEqual`.
- [ ] The old `Buffer.compare(hmac.digest()` pattern has zero matches.
- [ ] Existing time/expiry semantics and AES-GCM-first public fallback remain unchanged.
- [ ] Only Scope files changed; completion notes/index updated or absent index noted.

## STOP conditions

- Plan 001 has not provided `npm test`.
- Drift changes key slices, wire layout or the public wrapper's contract.
- A confirmed legacy producer uses a different MAC input encoding or cipher layout than the observed decoder implies; obtain an interoperability fixture before changing the format.
- Passing existing tests would require weakening HMAC checking, altering expiry policy, or modifying an external producer.
- A fix requires out-of-scope files, or verification fails twice after a reasonable correction.

## Maintenance notes

Review the order: decrypt, authenticate raw bytes, then parse JSON. CBC padding can still fail before authentication; this plan does not redesign the legacy format. Keep new issuance on AES-GCM. If maintainers confirm no producer remains, prefer a separate removal of the legacy fallback at `meshcentral.js:4003` and this decoder over maintaining unused cryptography. Absence of a producer has not been established by this plan and is not grounds to remove compatibility now.
