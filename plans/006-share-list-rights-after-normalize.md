# Plan 006: Authorize device share listings after normalizing mesh IDs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions occurs, stop and report; do not improvise. When done, update this plan's status row in `plans/README.md`, unless the dispatching reviewer maintains the index. If the index is absent, skip and note it.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshuser.js test/device-mesh-shares.test.js plans/006-share-list-rights-after-normalize.md plans/README.md`
> Compare changed source against the Current state excerpts. Stop on a material mismatch; additions from prerequisite plan 001 and index updates are expected.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 001, the test baseline plan under `plans/001-*.md`
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

A short mesh ID enters a normalization branch that bypasses mesh existence and permission checks. The following database query can therefore disclose device shares without the authorization applied to full IDs. Normalize valid strings first, then apply the same checks to both forms.

## Current state

`meshuser.js` implements authenticated WebSocket commands. Its `deviceMeshShares` validation at `meshuser.js:4475-4483` is:

```js
if (common.validateString(command.meshid, 8, 134) == false) { err = 'Invalid device group id'; } // Check the meshid
else if (command.meshid.indexOf('/') == -1) { command.meshid = 'mesh/' + domain.id + '/' + command.meshid; }
else if ((command.meshid.split('/').length != 3) || (command.meshid.split('/')[1] != domain.id)) { err = 'Invalid domain'; } // Invalid domain, operation only valid for current domain
else {
    // Check if we have rights on this device group
    mesh = parent.meshes[command.meshid];
    if (mesh == null) { err = 'Invalid device group id'; } // Check the meshid
    else if (parent.GetMeshRights(user, mesh) == 0) { err = 'Access denied'; }
}
```

The error response intentionally uses action `deviceShares`, not `deviceMeshShares` (`meshuser.js:4487`):

```js
if (command.responseid != null) { try { ws.send(JSON.stringify({ action: 'deviceShares', responseid: command.responseid, result: err })); } catch (ex) { } }
```

The sensitive read follows at `meshuser.js:4492`:

```js
parent.db.GetAllTypeNoTypeField('deviceshare', domain.id, function (err, docs) {
```

Test the actual closure entry point, not a copied validator. `meshuser.js:554` registers `ws.on('message', processWebSocketData);`; `meshuser.js:710-714` parses `msg.toString('utf8')` as JSON and validates `command.action`. There is no `obj.handleMessage` entry point. Construct the exported `CreateMeshUser(parent, db, ws, req, args, domain, user)` (`meshuser.js:23`).

Use CommonJS, four-space indentation, single quotes, callback style, and existing one-line guard conventions shown above. `package.json:58-60` declares Node >=20; use Node >=20.19 for the locked dependency tree. At the planned revision there are no test/check scripts; plan 001 adds them.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const p=require('./package.json'); if (!p.scripts || !p.scripts.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c meshuser.js` | Exit 0, no output |
| Focused tests | `node --test test/device-mesh-shares.test.js` | All cases pass |
| Full suite | `npm test` | Exit 0 |
| Maintained syntax baseline | `npm run check` | Exit 0; script supplied by 001 |

No install, lint, build, live server, or new dependency is needed for this change.

## Scope

**In scope** (only these files may change):
- `meshuser.js`, only `deviceMeshShares` validation.
- `test/device-mesh-shares.test.js` (create).
- `plans/006-share-list-rights-after-normalize.md`, completion evidence.
- `plans/README.md`, own status row if present.

**Out of scope**: other ID validators, share schema, response names, rights bit definitions, expiration cleanup, shared baseline helper, dependencies.

## Git workflow

- Preserve unrelated work; branch `advisor/006-share-list-rights-after-normalize` from the baseline containing 001.
- One logical fix commit, style `security: authorize normalized mesh share listings`; append a real `(#NNNN)` only when an issue exists.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Confirm baseline and establish the handler fixture

Require plan 001's `test/helpers/fake-parent.js` using its actual exported API. Do not guess its signature. Create a local fixture in the new test file using `const { test } = require('node:test'); const assert = require('node:assert');`.

Use a fake WebSocket/EventEmitter with captured JSON `send`, `close`, and `_socket.setKeepAlive`. Construct the real `CreateMeshUser`; await registration of the `message` listener before `ws.emit('message', Buffer.from(JSON.stringify(command)))`. `crypto.randomBytes` initialization is asynchronous (`meshuser.js:415-420`); do not dispatch before it finishes. Clear startup messages before assertions.

Handler dependencies: real `parent.common`, `parent.meshes`, controlled `parent.GetMeshRights`, and `parent.db.GetAllTypeNoTypeField`. Return `[]` for successful database reads so expiration/removal logic is not activated. Set `domain={id:'test',limits:{}}`, ordinary user `_id:'user/test/alice'`, and `parent.force2factorPending` returning false. Reuse the baseline's constructor stubs: session maps, crypto, `parent.parent.config.settings/domains`, `DispatchEvent`, `subscribe`, certificates/hash fields, `getDomainUserFeatures`, `getWebServerName`, and args (`meshuser.js:387-430,496-497,567-625`). Do not swallow fixture errors or bypass constructor startup. Assert the listener exists.

Start with an authorized full-ID test and a zero-rights full-ID test. Use an eight-character minimum short suffix, e.g. `abcdefgh`.

**Verify**: `node --test test/device-mesh-shares.test.js` → both characterization tests pass against existing behavior.

### Step 2: Normalize inside successful string validation, then authorize

Replace the chain with `if (invalidString) { ... } else { ... }`. Inside the `else`, use a standalone normalization `if`, followed by the existing domain-validation `if`/mesh-authorization `else`. Never call `indexOf` or `split` before successful string validation. Preserve the length limits, messages, error-response action, and no-response behavior when `responseid` is absent. Both short and full IDs must reach `GetMeshRights` exactly once for an existing current-domain mesh.

Add the remaining regression cases below. For every rejection, assert zero calls to `GetAllTypeNoTypeField`; do not merely assert a response error. For successful requests, assert the normalized mesh object was passed to `GetMeshRights`.

**Verify**: `node -c meshuser.js && node --test test/device-mesh-shares.test.js` → exit 0; all regression cases pass.

### Step 3: Finish checks and record the boundary

Run the suite and syntax baseline. Record that short IDs no longer skip authorization in this plan's completion evidence. Update the index row if present; otherwise skip and note. A missing live server is not a blocker; skip manual smoke testing and note it.

**Verify**: `npm test && npm run check` → exit 0, no failures.

## Test plan

Use the plan 001 fake-parent fixture, not an invented pre-existing test file. Add at least eight cases: authorized full ID; denied full ID; authorized short ID; denied short ID; missing mesh with short ID; foreign-domain full ID; malformed/non-string ID; denied request without `responseid`. Include an extra malformed slash-count case if not covered by the malformed-ID table. Assert denial never invokes the share database read, authorized forms use identical canonical IDs, and the existing `deviceShares` response shape remains unchanged.

Verification: `node --test test/device-mesh-shares.test.js` passes all cases, then `npm test` passes.

## Done criteria

- [ ] `node -c meshuser.js` exits 0.
- [ ] Focused tests cover short/full authorized and denied IDs and zero database reads on denial.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] No public response shape or permission threshold changed.
- [ ] `git diff --name-only` contains no modifications outside Scope attributable to this plan.
- [ ] Completion evidence and own index row are updated, or absent index is noted.

## STOP conditions

- `npm test` is absent: complete plan 001 first; do not create another test runner.
- The live handler no longer uses the quoted validation/query flow; reconcile before editing.
- The baseline fixture cannot construct `CreateMeshUser` and register the real message listener without modifying shared production startup. Report missing fixture fields instead of testing a copied handler.
- Successful short-ID access requires a different authorization threshold from full IDs. That contradicts this plan's intended equivalence.
- Two reasonable attempts cannot make a verification pass, or the fix requires an out-of-scope file.

## Maintenance notes

Keep normalization and authorization sequential when adding other ID forms. Review denial tests for database-call assertions; error-only assertions would miss a read-before-denial regression. This change does not tighten the existing nonzero-rights policy. No production server was exercised during planning.
