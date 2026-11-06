# Plan 013: Bind WebAuthn assertions to the expected login challenge and relying party

> **Executor instructions**: Follow each step and run its verification command before proceeding. Stop and report on a STOP condition; do not improvise. Update this plan's row in `plans/README.md` unless the reviewer owns the index. If the index is absent, skip and note it.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- webauthn.js test/webauthn-assertion.test.js plans/013-webauthn-verify-expectations.md plans/README.md`
> Compare changed source against Current state. Plan 001's test infrastructure is expected; changed assertion semantics require reconciliation.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-test-baseline.md`
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

A valid signature does not prove an assertion belongs to the current login or relying party. The caller supplies challenge, origin and previous counter, but the verifier ignores them. Enforcing those expectations rejects replayed or wrongly scoped assertions without changing the caller's success contract.

## Current state

`webauthn.js` exposes `CreateWebAuthnModule()` and a synchronous assertion verifier. Its current verification is:

```js
// webauthn.js:200-208
obj.verifyAuthenticatorAssertionResponse = function (webauthnResponse, authr) {
    const response = { 'verified': false }
    if (['fido-u2f'].includes(authr.fmt)) {
        const authrDataStruct = parseGetAssertAuthData(webauthnResponse.authenticatorData);
        if (!(authrDataStruct.flags & 0x01)) { throw new Error('User was not presented durring authentication!'); } // U2F_USER_PRESENTED
        response.counter = authrDataStruct.counter;
        response.verified = verifySignature(webauthnResponse.signature, Buffer.concat([authrDataStruct.rpIdHash, authrDataStruct.flagsBuf, authrDataStruct.counterBuf, hash(webauthnResponse.clientDataJSON)]), authr.publicKey);
    }
    return response;
```

`parseGetAssertAuthData` reads the first 32 bytes as `rpIdHash`, one flag byte, and a four-byte big-endian counter (`webauthn.js:214-223`). The current signature reconstruction omits any authenticator extension bytes. `hash` is SHA-256 and `verifySignature` uses `crypto.createVerify('SHA256')` (`webauthn.js:211-212`).

The caller already constructs the required expectations:

```js
// webserver.js:1264-1272
if ((req.session != null) && (req.session.e != null)) { const sec = parent.decryptSessionData(req.session.e); if (sec != null) { u2fchallenge = sec.u2f; } }
var assertionExpectations = {
    challenge: u2fchallenge,
    origin: origin,
    factor: 'either',
    fmt: 'fido-u2f',
    publicKey: webAuthnKey.publicKey,
    prevCounter: webAuthnKey.counter,
    userHandle: Buffer.from(user._id, 'binary').toString('base64')
```

`webserver.js:1259-1261` builds the expected HTTPS origin from domain DNS or certificate CommonName and the externally configured port. Lines 1275-1287 catch verifier exceptions and accept only `verified === true`; only then is `webAuthnKey.counter` updated and `obj.db.SetUser(user)` called.

The challenge is random bytes encoded as standard base64, not hex or a literal UTF-8 challenge:

```js
// webserver.js:1365
var authnOptions = { type: 'webAuthn', keyIds: [], timeout: 60000, challenge: obj.crypto.randomBytes(64).toString('base64') };
// webserver.js:1369-1370
sec.u2f = authnOptions.challenge;
req.session.e = parent.encryptSessionData(sec);
```

Registration uses the browser's default RP ID, not a custom server-supplied identifier:

```js
// webauthn.js:18-23
obj.generateRegistrationChallenge = function (rpName, user) {
    return {
        rp: { name: rpName },
        user: user,
        challenge: crypto.randomBytes(64).toString('base64'),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
// meshuser.js:4295
var registrationOptions = parent.webauthn.generateRegistrationChallenge("Anonymous Service", { id: Buffer.from(user._id, 'binary').toString('base64'), name: user._id, displayName: user._id.split('/')[2] });
// views/default.handlebars:3331-3334
var publicKey = message.request;
message.request.challenge = Uint8Array.from(atob(message.request.challenge), function (c) { return c.charCodeAt(0) })
message.request.user.id = Uint8Array.from(atob(message.request.user.id), function (c) { return c.charCodeAt(0) })
navigator.credentials.create({ publicKey: publicKey }).then(function(newCredentialInfo) {
```

Because `rp.id` is omitted, WebAuthn defaults it to the calling origin's effective domain. Therefore hash `new URL(authr.origin).hostname`, excluding the port, for the expected RP ID. Registration does not currently validate attestation RP/challenge expectations; that is outside this assertion-only fix.

Match CommonJS, four spaces, single quotes and existing synchronous result objects. `package.json:42` already includes `cbor`; no new cryptographic dependency is needed. Use Node >=20.19. Plan 001 supplies Node test infrastructure; no tests existed at the planned commit.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c webauthn.js` | Exit 0 |
| Focused tests | `node --test test/webauthn-assertion.test.js` | All pass |
| Full tests | `npm test` | All pass |
| Scope | `git diff --name-only` | Only Scope files changed |

## Scope

**In scope**:
- `webauthn.js`
- `test/webauthn-assertion.test.js` (create)
- `plans/013-webauthn-verify-expectations.md` (completion evidence)
- `plans/README.md` (status only, if present)

**Out of scope**: registration/attestation redesign, `meshuser.js`, `webserver.js`, browser templates, user-verification policy, session lifecycle, new algorithms, credential database migrations, passkey backup-policy changes. Caller files cited above are read-only context.

## Git workflow

- Branch: `advisor/013-webauthn-verify-expectations`.
- Preserve unrelated user edits.
- Commit: `security: verify WebAuthn assertion expectations`; use a real `(#NNNN)` suffix only when supplied.
- Do not push or open a PR without instruction.

## Steps

### Step 1: Build real signed assertion fixtures

STOP if `npm test` is absent. Create the test file with `const { test } = require('node:test'); const assert = require('node:assert');`, following Plan 001's tests. No server or fake meshuser handler is necessary: call `require('../webauthn.js').CreateWebAuthnModule().verifyAuthenticatorAssertionResponse(...)` directly.

Generate a test-only key with `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })`. Export its public key as PEM SPKI. Build `authenticatorData` from SHA-256 of `example.test`, a user-presence flag byte, and a four-byte big-endian counter; optionally append extension bytes. Build UTF-8 `clientDataJSON` from `{ type: 'webauthn.get', challenge: challengeBytes.toString('base64url'), origin: 'https://example.test:8443' }`. Sign `Buffer.concat([authenticatorData, sha256(clientDataJSON)])` with `crypto.sign('sha256', ..., privateKey)`. Expected challenge is the same bytes encoded with standard base64, matching the encrypted-session format. The expectation object includes `fmt: 'fido-u2f'`, the PEM public key, origin and `prevCounter`.

**Verify**: `node -c test/webauthn-assertion.test.js` → exit 0. This initial gate validates fixture syntax, not the known-vulnerable negative cases.

### Step 2: Enforce assertion expectations before accepting the signature

Keep the public synchronous method and `{ verified: false }` failure shape. Validate required Buffers and a minimum authenticator-data length of 37 before parsing. Parse `clientDataJSON` as UTF-8 JSON; malformed or missing fields must fail closed. Require exact `type === 'webauthn.get'` and exact origin equality with `authr.origin`.

Normalize challenge encodings by decoding standard base64 and base64url into bytes and comparing those bytes. Do not compare encoded strings or decode the expected challenge as UTF-8. Require nonempty string inputs; validate alphabet/padding and canonical round-trip after removing padding and converting URL-safe alphabet, since `Buffer.from(..., 'base64')` alone silently ignores invalid characters. Reject missing session challenges; do not substitute a generated challenge.

Compute SHA-256 over `new URL(authr.origin).hostname` and require equality with the 32-byte `rpIdHash`. Retain the user-presence requirement; do not introduce mandatory user verification because the caller currently requests `factor: 'either'`.

Require a nonnegative integer `prevCounter` within uint32 range. Accept the new counter only if it exceeds `prevCounter`, except allow the explicit counterless case where both equal zero. Do not treat a missing previous counter as zero. Verify the signature over the full original `authenticatorData` Buffer concatenated with SHA-256 of the original `clientDataJSON` bytes. Do not reconstruct authenticator data from parsed fields or reserialize JSON. Populate the returned counter on verified success; leave the caller's persistence and success branch unchanged. Invalid input should return unverified, not escape as an uncaught parsing exception.

**Verify**: `node -c webauthn.js && node --test test/webauthn-assertion.test.js` → syntax and signed happy-path tests pass; wrong challenge, origin, RP hash and counter regression are rejected.

### Step 3: Add adversarial, encoding and extension cases

For each wrong expectation, sign the altered message correctly. A bad signature test alone cannot prove challenge/origin/RP checks exist. Add base64/base64url equivalence, missing challenge, wrong type, malformed JSON, malformed challenge encoding, short authenticator data, absence of user presence, wrong signature, missing previous counter, equal nonzero counters, regression to zero, both-zero counters, and advancing counters. Add authenticator extension bytes with flag `0x81` and a small valid CBOR map; sign the complete buffer, assert success, then alter an extension byte without resigning and assert rejection. Keep the expected origin port while proving the RP hash excludes it.

**Verify**: `node --test test/webauthn-assertion.test.js` → every named positive case verifies and every named negative case returns unverified.

### Step 4: Record and finish

Run full tests and record the expectation contract and verification result in this plan. Update the index if present. A live security key/browser is optional; skip and note hardware testing if unavailable.

**Verify**: `npm test && git diff --name-only` → all tests pass and only Scope paths changed.

## Test plan

Use real Node crypto signatures, not mocked signature verification. All fixtures are generated in `test/webauthn-assertion.test.js` and contain no production credentials. Baseline: Plan 001's Node test conventions. The minimum required five cases are valid assertion, wrong challenge, wrong origin, wrong RP hash, and counter regression; Step 3 adds encoding, malformed input, presence, extension and counterless coverage. Tests must fail if any expectation check is removed while the signatures remain valid. Verification: `node --test test/webauthn-assertion.test.js` and `npm test` pass without a server or hardware key.

## Done criteria

- [ ] `node -c webauthn.js` exits 0.
- [ ] Focused tests and `npm test` pass.
- [ ] Correctly signed wrong-challenge/origin/RP assertions are rejected.
- [ ] Both-zero counters pass; equal nonzero and regressed counters fail.
- [ ] Full authenticator data, including extension bytes, is signature-covered.
- [ ] Missing/malformed expectations fail closed without a production exception.
- [ ] No caller, template or registration behavior changed; completion notes/index updated or missing index noted.

## STOP conditions

- `npm test` is absent: Plan 001 must land first.
- Drift shows registration now supplies an explicit RP ID different from the origin hostname; do not guess a compatibility fallback.
- A supported deployment registers keys using a parent-domain RP ID or origin alias that conflicts with the caller's expected origin; report the exact mismatch before changing caller behavior.
- Existing stored credentials lack numeric counters and compatibility requires accepting them; that needs a separate migration decision, not an implicit zero fallback.
- The fix needs out-of-scope changes or a verification fails twice after a reasonable correction.

## Maintenance notes

Keep hashing the raw signed client/authenticator bytes. Future explicit RP IDs require passing that expectation from registration/login, rather than silently inferring a different domain. Counter policy may need revisiting for synchronized passkeys, but this plan implements the specified greater-than-or-both-zero rule. Registration attestation validation is separate work; this change does not claim to fix it.
