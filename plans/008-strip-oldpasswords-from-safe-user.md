# Plan 008: Remove historical password hashes from safe user clones

> **Executor instructions**: Follow each step and run its verification before proceeding. Stop and report when a STOP condition occurs; do not improvise. Update this plan's row in `plans/README.md` when done unless the dispatching reviewer maintains it. If the index is absent, skip and note.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- webserver.js common.js test/safe-user.test.js plans/008-strip-oldpasswords-from-safe-user.md plans/README.md`
> Compare changed source with Current state. Stop on a material mismatch; baseline and index additions from prerequisite 001 are expected.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 001, test baseline (`plans/001-*.md`)
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Password history contains salted password hashes. The safe-user clone removes the current hash and salt but leaves the history array, allowing event consumers to receive past credentials. Strip history from outgoing clones without deleting it from the stored account or weakening password-reuse checks.

## Current state

`webserver.js:1992-1994` stores password history:

```js
if ((typeof domain.passwordrequirements.oldpasswordban == 'number') && (domain.passwordrequirements.oldpasswordban > 0)) {
    if (user.oldpasswords == null) { user.oldpasswords = []; }
    user.oldpasswords.push({ salt: user.salt, hash: user.hash, start: user.passchange, end: nowSeconds });
```

`webserver.js:10208-10217` begins the outbound clone:

```js
obj.CloneSafeUser = function (user) {
    if (typeof user != 'object') { return user; }
    var user2 = Object.assign({}, user); // Shallow clone
    delete user2.hash;
    delete user2.passhint;
    delete user2.salt;
    delete user2.type;
    delete user2.domain;
    delete user2.subscriptions;
    delete user2.passtype;
```

The rest of that function (`webserver.js:10218-10227`) deletes `otpsms`/`otpmsg` and converts 2FA and webpush fields into indicators/counts. It never deletes `oldpasswords`.

Two real event consumers are `account: obj.CloneSafeUser(user)` in the login event (`webserver.js:1696`) and the password-reset accountchange event (`webserver.js:2007`). Both subsequently call `DispatchEvent` (`webserver.js:1701,2009`). Fix the shared clone, not those individual callers.

`CloneSafeUser` is an object property inside the large `CreateWebServer` constructor, not a standalone module export. Construction imports Express and WebAuthn and builds an app (`webserver.js:122-159`):

```js
obj.common = require('./common.js');
obj.express = require('express');
```

A full server fixture is unnecessary for this pure function. Use the existing utility-module convention in `common.js:31-33`:

```js
module.exports.MakeToArray = function (v) { if (!v || v == null || typeof v == 'object') return v; return [v]; };
module.exports.SplitArray = function (v) { return v.split(','); };
module.exports.Clone = function (v) { return JSON.parse(JSON.stringify(v)); };
```

Move the complete existing pure CloneSafeUser implementation into `common.js` as `module.exports.CloneSafeUser`, including its deletion field list and indicator logic. Then bind `obj.CloneSafeUser = obj.common.CloneSafeUser` at the existing location. This preserves the live object API and tests the exact function used by consumers without constructing a server. There must be only one implementation, not a second clone or wrapper. Preserve every existing comment and behavior except stripping history. Use CommonJS, four spaces, single quotes, and local semicolon conventions. Node >=20.19 is the execution baseline (`package.json:58-60` declares >=20); test/check scripts come from 001.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const p=require('./package.json'); if (!p.scripts || !p.scripts.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c common.js && node -c webserver.js` | Exit 0, no output |
| Focused tests | `node --test test/safe-user.test.js` | All tests pass |
| Suite | `npm test` | Exit 0 |
| Syntax baseline | `npm run check` | Exit 0; supplied by 001 |
| Live binding | `rg -n 'obj.CloneSafeUser = obj.common.CloneSafeUser' webserver.js` | Exactly one assignment |

No install, build, lint, or live server is required.

## Scope

**In scope**:
- `webserver.js`, replace only the existing CloneSafeUser implementation with the direct binding.
- `common.js`, move the pure CloneSafeUser implementation here and add history deletion.
- `test/safe-user.test.js` (create).
- `plans/008-strip-oldpasswords-from-safe-user.md`, completion evidence.
- `plans/README.md`, own status row if present.

**Out of scope**: password-history persistence, password-reuse policy, event consumers, existing stored events, credential rotation, CloneSafeNode, dependency changes, unrelated redaction helpers.

## Git workflow

- Branch `advisor/008-strip-oldpasswords-from-safe-user` after 001; preserve unrelated work.
- Commit style: `security: redact password history from safe users`; add an issue number only if real.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Move the pure clone without changing its behavior

Check the baseline script exists. Search every `CloneSafeUser` callsite before editing: `rg -n 'CloneSafeUser' --glob '*.js'`. Keep those consumers unchanged because the object method API remains available. Move the function, including every deletion and indicator conversion, to `common.js` near other cloning helpers. Replace its original definition with `obj.CloneSafeUser = obj.common.CloneSafeUser;`. The implementation currently references only its argument and standard JavaScript built-ins; if that is no longer true, STOP instead of extracting a closure incorrectly.

Create `test/safe-user.test.js` using `const { test } = require('node:test'); const assert = require('node:assert');` and `require('../common.js').CloneSafeUser`. Use the node:test structure established by 001; no parent or server fixture is needed. Characterize current hash/salt/hint deletion, preservation of public fields, unchanged input, primitive passthrough, and existing 2FA/webpush conversions before adding the history assertion.

**Verify**: `node -c common.js && node -c webserver.js && node --test test/safe-user.test.js` → syntax clean and characterization tests pass.

### Step 2: Delete history from the clone and add regression coverage

Add `delete user2.oldpasswords;` next to the existing hash/salt deletions in the moved function. Do not mutate `user.oldpasswords`, deep-clone the account, or replace the field with a count. The outbound object must have no own `oldpasswords` property.

Use synthetic placeholders, never real account values. Freeze the input account and its history array/entries. Assert the returned object differs from the input, lacks current and historical credential fields, and retains `_id`, `name`, and unrelated public fields. Assert the original history reference, entries, current credentials, and 2FA structures remain unchanged. Cover history absent, empty, populated with multiple records, and an unexpected non-array history value: deletion should remove all forms.

Add a small source-binding assertion or equivalent integration assertion that `webserver.js` assigns its object method directly to the tested common function. A source-binding check supplements behavioral tests; it must not replace them.

**Verify**: `node --test test/safe-user.test.js` → all cases pass, including history redaction and input immutability.

### Step 3: Record the behavior and run repository gates

Record the safe-user history omission and unchanged persisted history in this plan's completion evidence. Update the index row if present; otherwise skip and note. If no live server is available, skip manual account-event inspection and note it; never use production credentials for tests.

**Verify**: `npm test && npm run check && rg -n 'obj.CloneSafeUser = obj.common.CloneSafeUser' webserver.js` → tests/check pass; exactly one live binding is printed.

## Test plan

At least eight named tests in `test/safe-user.test.js`: populated history; empty history; absent history; non-array history; current secret stripping; frozen input unchanged; existing 2FA/webpush indicators preserved; primitive passthrough. Include identity/public-field preservation in these cases. Test exported production code, not a regex-extracted function or duplicated deletion list. Add the live-binding assertion described above. Verify with `node --test test/safe-user.test.js`, then `npm test`.

## Done criteria

- [ ] `node -c common.js` and `node -c webserver.js` exit 0.
- [ ] Tests assert `Object.prototype.hasOwnProperty.call(result, 'oldpasswords') === false` for every history form.
- [ ] Input history and all existing 2FA/public-field behavior remain unchanged in tests.
- [ ] There is exactly one CloneSafeUser implementation and the webserver directly binds it.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` shows only in-scope changes attributable to this work.
- [ ] Completion evidence and own index row are updated, or absent index is noted.

## STOP conditions

- `npm test` is absent; complete plan 001 first.
- CloneSafeUser now accesses constructor-local state that cannot move unchanged to `common.js`.
- A caller relies on outgoing `oldpasswords`; report the conflict rather than retaining sensitive values or changing password policy.
- A test requires constructing a real listening server to exercise this pure clone; the extraction has failed its purpose.
- The only way to pass tests appears to delete stored password history, alter 2FA conversion, or touch out-of-scope consumers.
- Verification fails twice after reasonable correction.

## Maintenance notes

Treat every new credential field as requiring an explicit outbound-redaction decision. Keeping the object method bound to the common function prevents event callers from drifting into separate redaction policies. Previously emitted or persisted events are not scrubbed by this change; exposure assessment and any historical remediation require separate authorization. Planning did not inspect live accounts or run tests.
