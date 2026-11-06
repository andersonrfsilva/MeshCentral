# Plan 004: Enforce domain authorization on user-group cloning

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions section occurs, stop and report; do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index. If that index or another documentation file is absent, skip its update and note the omission; absence is not a STOP.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshuser.js test/usergroup-clone-domain.test.js test/helpers/fake-parent.js readme.md plans/README.md`
> Compare changed files against the Current state excerpts. Expected changes from plan 001 are allowed; unexplained changes to the affected logic require STOP and review.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-test-baseline.md
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

An explicit domain field disables the clone source-domain check. A local group administrator can therefore clone another domain’s group and memberships. Separate validation of source and requested domains closes this boundary without redesigning group cloning.

## Current state

All paths are relative to `/home/anderson/Desenvolvimento/oss/meshcentral`. Run commands from that directory. This is CommonJS and callback-based code. Match four-space indentation, single quotes, and existing compact guards; do not reformat surrounding code.

`meshuser.js:1621` is `case 'createusergroup'`. `meshuser.js:1636` checks `(user.siteadmin & SITERIGHT_USERGROUPS) == 0`; `meshuser.js:76` defines that permission as `0x00000100`. It is not cross-domain authority. `meshuser.js:126` grants `obj.crossDomain` only when the requester is listed in `parent.parent.config.settings.managecrossdomain`.

The flawed clone validation at `meshuser.js:1643-1648` is:
```js
if (command.clone) {
    if (common.validateString(command.clone, 1, 256) == false) { err = "Invalid clone groupid"; }
    else {
        var clonesplit = command.clone.split('/');
        if ((clonesplit.length != 3) || (clonesplit[0] != 'ugrp') || ((command.domain == null) && (clonesplit[1] != domain.id))) { err = "Invalid clone groupid"; }
        else if (parent.userGroups[command.clone] == null) { err = "Invalid clone groupid"; }
```
An explicit command.domain bypasses the clone-domain comparison. The source domain then controls the created group (`meshuser.js:1653-1660`):
```js
ugrpdomain = parent.parent.config.domains[clonesplit[1]];
if (ugrpdomain == null) { err = "Invalid domain"; }
```
For non-clone creation:
```js
ugrpdomain = domain;
if ((obj.crossDomain === true) && (command.domain != null)) { ugrpdomain = parent.parent.config.domains[command.domain]; }
if (ugrpdomain == null) { err = "Invalid domain"; }
```
`meshuser.js:1668-1670` sends `{ action: 'createusergroup', responseid: command.responseid, result: err }` and breaks before randomBytes or persistence on validation errors. `meshuser.js:1674-1693,1726-1743` generates the ID, clones memberships, writes via db.Set/SetUser, and emits creation/change events. `readme.md:26` is the Documentation heading.

### Real WebSocket fixture contract

Use plan 001's `test/helpers/fake-parent.js`; extend only explicit fields there if necessary. Construct `require('../meshuser.js').CreateMeshUser(parent, db, ws, req, args, domain, user)` from a test file. There is **no `obj.handleMessage` entry point**. `meshuser.js:554` registers `ws.on('message', processWebSocketData)`; `meshuser.js:710-724` parses `msg.toString('utf8')`, validates `action`, calls `parent.force2factorPending`, then routes through `serverCommands` or the switch. Emit `ws.emit('message', Buffer.from(JSON.stringify(command)))` after initialization. Wait for `_socket.resume()` through a readiness promise before dispatch; clear captured initialization sends/events before assertions.

The baseline fixture must provide a real EventEmitter socket with captured `send`, `close`, `_socket.setKeepAlive`, `_socket.resume`; `req.session.userid`, `req.clientIp`; `domain.id`, `domain.limits = {}`; `user._id`, `user.name`, `user.domain`, `user.siteadmin`; empty `args` without ping/pong settings. Web parent fields: `common` (real common module), `crypto` (real Node crypto), `args`, `users` containing requester, `wssessions`, `wssessions2`, `meshes`, `userGroups`, `desktoprelays`, `certificates` with synthetic `CommonName` and `AmtMpsName`, `webCertificateFullHashs[domain.id]` (synthetic binary string), `webCertificateExpire = {}`, `subscribe` returning `[]`, `getDomainUserFeatures` returning `{ features: 0, features2: 0, features3: 0 }`, `getWebServerName` returning a test hostname, `CloneSafeUser` returning a safe copy, and `force2factorPending` returning false. Root `parent.parent` needs `config.settings = { managealldevicegroups: [], autobackup: {} }`, `config.domains[domain.id]`, captured `DispatchEvent`, `RemoveAllEventDispatch`, `debug`, `getServerWarnings` returning `[]`, and `logError` that records unexpected exceptions. Leave optional services absent. These fields follow `meshuser.js:126,387-432,496,567-625,641-644,665-701`. Close the returned session in test cleanup; do not enable session-expiry or browser timers. Assert readiness, exactly one message listener, and no logged errors so initialization failures cannot make negative tests pass accidentally.

For teardown (`meshuser.js:210-234`), set `user.access` to current epoch seconds and `parent.db = db`; provide `db.SetUser` as a capture function and `db.changeStream = false`. The fake socket close must not recursively emit close when `obj.close()` calls it.


## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime | `node --version` | Node 20.19 or newer; CI uses Node 20 and 22 |
| Syntax, available now | `node -c common.js && node -c db.js && node -c meshuser.js` | Exit 0, no output |
| Test suite, after plan 001 | `npm test` | All tests pass and process exits naturally |
| Maintained syntax, after plan 001 | `npm run check` | Exit 0 |


The npm commands above are planned additions, not commands present at the planning commit. No test or install was run while writing this plan.

## Scope

**In scope** (the only files to modify):
- `meshuser.js`
- `test/usergroup-clone-domain.test.js` (create)
- `test/helpers/fake-parent.js` (create)
- `readme.md`
- `plans/README.md`

**Out of scope**:
- Production configuration, credentials, databases, network services, and deployment.
- Dependency upgrades, schema changes, unrelated formatting, and unrelated security findings.
- Existing public response shapes except the explicitly denied operations below.

## Git workflow

- Branch: `advisor/004-usergroup-clone-domain-check`.
- Preserve unrelated local work. Do not reset or clean the checkout.
- Use a focused commit with the repository's style, such as `security: enforce domain authorization on user-group cloning`. Add `(#NNNN)` only when a real issue number exists.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add domain-boundary regression tests

Create `test/usergroup-clone-domain.test.js` with Node native test/assert imports and the shared fixture. Define two domains `test` and `other`, each with `id` and `limits: {}`; configure both under root config.domains. Give requester only `siteadmin: 256`, no cross-domain manage list membership. Seed `parent.userGroups['ugrp/other/source']` with `domain: 'other'` and `links: {}`; use empty links for allowed-path tests to isolate domain policy. Capture `db.Set`, `db.SetUser`, root DispatchEvent, and socket sends; set db.changeStream=false. Fixture supplies parent.crypto and req.session. Clear startup captures first.

Dispatch `{ action: 'createusergroup', name: 'Clone', clone: 'ugrp/other/source', domain: 'test', responseid: 'r1' }`. Assert an error result, no Set/SetUser, no new group, no creation/membership events. Repeat with domain `other`: both variants were bypass inputs. Assert completion through response capture, not a short sleep; successful paths use asynchronous randomBytes. Add allowed-path cases and malformed IDs before fixing.

**Verify**: `node --test test/usergroup-clone-domain.test.js` → original cross-domain bypass cases fail because a group is created; readiness and response observation succeed.

### Step 2: Validate source and requested domains independently

Replace only the domain portion of the clone ID check with:
```js
((obj.crossDomain !== true) && (clonesplit[1] != domain.id))
```
Keep shape/prefix validation and source existence checks. A supplied command.domain must never suppress source authorization.

Before choosing a target domain, validate every non-null command.domain, regardless of clone mode: require a string, a configured domain, and either equality with domain.id or obj.crossDomain === true. Use the existing err = 'Invalid domain' pathway. The default domain ID is the empty string and is valid when configured; do not impose a nonempty-string restriction. Reject arrays, objects, numbers, and unknown domain IDs. Use own-property validation for config.domains so inherited names such as `toString` do not count as configured domains.

Preserve current destination semantics: a clone is created in its source domain; ordinary creation uses command.domain only for a cross-domain administrator. Do not turn this into a source-to-different-domain migration. For a cross-domain administrator, a valid explicit command.domain different from the clone source remains validated but does not move the clone; test this behavior. Preserve SITERIGHT_USERGROUPS, OIDC, email verification, name/description checks, and existing response shape.

**Verify**: `node --test test/usergroup-clone-domain.test.js && node -c meshuser.js` → all boundary and legitimate cross-domain cases pass.

### Step 3: Document the boundary and finish

Add a concise note near `readme.md` Documentation: user-group cloning requires source-domain access; cross-domain creation/cloning requires configured cross-domain administrator status. Skip missing documentation and note it. Update index if present and not reviewer-owned.

**Verify**: `npm test && npm run check && git diff --check` → all gates exit 0.


## Test plan

Required matrix: non-cross-domain requester cloning other-domain group with domain absent, domain=self, and domain=other: all denied; own-domain clone with domain absent/self: allowed; own clone plus explicit other domain: denied; non-clone explicit other domain: denied, not silently redirected to self; wrong type and unknown domain: denied; default domain empty string accepted when configured; malformed prefix/component count or missing source: denied. A requester included in managecrossdomain and holding bit 256 can clone other-domain groups with domain absent or configured explicit domain, and can create a non-clone group in a configured other domain. Assert clone destination equals source domain and non-clone destination equals requested domain. Full siteadmin without cross-domain configuration must still fail cross-domain cloning. Denied tests must observe the error reply and unchanged groups, users, DB captures and event captures; do not accept silent fixture failure as success.

## Done criteria

- [ ] Supplying command.domain never bypasses clone source authorization.
- [ ] Non-cross-domain group administrators cannot select another configured domain.
- [ ] Configured cross-domain administrators retain legitimate creation and clone behavior.
- [ ] Malformed, inherited, and unknown domain values are rejected before side effects.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` lists only the scoped files for this change; preserve pre-existing unrelated work.
- [ ] Update the index row, or note that the reviewer owns it or the file was absent.

## STOP conditions

- If `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` fails, STOP: plan 001 has not landed. Do not substitute ad hoc tests.
- STOP if the expected clone destination is a requested domain rather than the source domain; that is a migration feature outside this plan.
- STOP if cross-domain authority is no longer configured through managecrossdomain; resolve the policy source instead of trusting command.domain.
- STOP if passing domain checks requires bypassing OIDC sync restrictions or email verification; preserve both existing controls.

A live server is not required. Skip live checks and note that limitation instead of stopping.

## Maintenance notes

Test source authority separately from destination selection. The siteadmin bit for group management is not cross-domain authority. Future cross-domain membership migration needs its own design and tests.
