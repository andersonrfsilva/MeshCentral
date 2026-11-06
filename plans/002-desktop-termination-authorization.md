# Plan 002: Authorize desktop termination against the requester

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions section occurs, stop and report; do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index. If that index or another documentation file is absent, skip its update and note the omission; absence is not a STOP.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshuser.js test/desktop-termination-authorization.test.js test/helpers/fake-parent.js readme.md plans/README.md`
> Compare changed files against the Current state excerpts. Expected changes from plan 001 are allowed; unexplained changes to the affected logic require STOP and review.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-test-baseline.md
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

A logged-in user can target another user’s desktop relay because the current guard compares the target ID with itself. Checking the requester’s node rights blocks unauthorized disconnects. The change retains intentional self-disconnect and guest matching.

## Current state

All paths are relative to `/home/anderson/Desenvolvimento/oss/meshcentral`. Run commands from that directory. This is CommonJS and callback-based code. Match four-space indentation, single quotes, and existing compact guards; do not reformat surrounding code.

`meshuser.js:5823` handles `case 'endDesktopMultiplex'`. The target lookup at `meshuser.js:5829-5832` is:
```js
const xusersplit = command.xuserid.split('/');
xuser = parent.users[command.xuserid];
if (xuser == null) { err = 'User does not exists'; }
else if ((obj.crossDomain !== true) && ((xusersplit.length != 3) || (xusersplit[1] != domain.id))) { err = 'Invalid domain'; }
```
The faulty authorization at `meshuser.js:5838-5842` is:
```js
// Get the node and the rights for this node
parent.GetNodeWithRights(domain, xuser, command.nodeid, function (node, rights, visible) {
    if ((rights != 0xFFFFFFFF) && (xuser._id != command.xuserid)) return;
    const desktopRelay = parent.desktoprelays[command.nodeid];
    if ((desktopRelay == null) || (desktopRelay === 1)) return; // If the desktopRelay is equal to 1, the relay is being constructed.
```
`xuser` was looked up using the very same ID compared by the guard, so the second term is false for normal stored users. Rights belong to the target, not the requester. `meshuser.js:43,64` defines `MESHRIGHT_REMOTECONTROL = 0x00000008` and `MESHRIGHT_ADMIN = 0xFFFFFFFF`.

`meshuser.js:5843-5848` first collects matching viewers, then closes them:
```js
if ((viewer.user._id == command.xuserid) && (viewer.guestName == command.guestname)) { viewersToClose.push(viewer); }
```
`meshuser.js:5855-5861` attributes the `endsession` event to requesting `user` and dispatches it. Preserve this attribution and the collect-then-close loop. `readme.md:26` is the existing Documentation heading.

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
- `test/desktop-termination-authorization.test.js` (create)
- `test/helpers/fake-parent.js` (create)
- `readme.md`
- `plans/README.md`

**Out of scope**:
- Production configuration, credentials, databases, network services, and deployment.
- Dependency upgrades, schema changes, unrelated formatting, and unrelated security findings.
- Existing public response shapes except the explicitly denied operations below.

## Git workflow

- Branch: `advisor/002-desktop-termination-authorization`.
- Preserve unrelated local work. Do not reset or clean the checkout.
- Use a focused commit with the repository's style, such as `security: authorize desktop termination against the requester`. Add `(#NNNN)` only when a real issue number exists.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add real-dispatch authorization regression tests

Create `test/desktop-termination-authorization.test.js` using `const { test } = require('node:test'); const assert = require('node:assert');`. Reuse the baseline fixture. Add a target to `parent.users`, populate `parent.desktoprelays[nodeid].viewers`, and supply `parent.GetNodeWithRights(domainArg, requesterArg, nodeidArg, callback)` as a capture stub. The stub must derive rights from requesterArg, not simply return the same rights for anyone. Give target full rights and requester zero rights in the exploit regression. Capture exact callback arguments and return a synthetic node plus the requester's rights.

Send `{ action: 'endDesktopMultiplex', nodeid: 'node/test/n1', xuserid: 'user/test/target' }` through the message event. Assert GetNodeWithRights receives the authenticated requesting user; no viewer close and no `endsession` event occurs. Add self-disconnect, remote-control, full-rights, unrelated-rights, target/guest mismatch, and absent/constructing relay cases listed below. Use close spies that remove viewers from the relay to prove the existing collect-first behavior survives. No source extraction or exported test-only handler.

**Verify**: `node --test test/desktop-termination-authorization.test.js` → before the fix, the requester-identity/unauthorized-close regression fails for the intended reason; fixture readiness succeeds. Record the failure, then proceed to Step 2.

### Step 2: Authorize the requesting user

Change only this handler's GetNodeWithRights argument from `xuser` to `user`. Replace its ineffective guard with:
```js
if ((user._id != command.xuserid) && (rights != MESHRIGHT_ADMIN) && ((rights & MESHRIGHT_REMOTECONTROL) == 0)) { return; }
```
Keep target existence/domain validation, ID normalization, guest filtering, relay construction check, viewer collection, and audit dispatch unchanged. Self-disconnect is deliberately allowed even without current node rights; do not add a node-visible or node-exists guard that silently removes that policy. No extra site-admin restriction. No unauthorized success/audit event.

**Verify**: `node --test test/desktop-termination-authorization.test.js && node -c meshuser.js` → all cases pass and syntax exits 0.

### Step 3: Record policy and run full gates

Add one short statement under `readme.md` Documentation: users may end their own multiplexed desktop sessions; ending another user's session requires remote-control rights on the node. Skip and note if the documentation file is missing. Update the index if available and not reviewer-owned.

**Verify**: `npm test && npm run check && git diff --check` → all pass, exit 0.


## Test plan

Use plan 001's native test imports and fake-parent pattern. Required cases: (1) requester zero rights, target full rights: zero closes; (2) requester matches target, zero rights: matching viewers close; (3) requester remote-control bit 8: allowed; (4) requester full 0xFFFFFFFF: allowed; (5) only unrelated edit-mesh bit 1: denied; (6) missing or sentinel-1 relay: no closes/exception; (7) two matching viewers close even when close mutates the list; (8) wrong user or guestName remains open; (9) malformed or cross-domain target retains current rejection. In every rights lookup, assert identity is requester. Clear startup events, then assert denied operations emit no `endsession`; allowed operations retain requester attribution. Run `node --test test/desktop-termination-authorization.test.js`, then full gates. No live agents are needed.

## Done criteria

- [ ] The GetNodeWithRights spy always sees the authenticated requester.
- [ ] Requester zero rights cannot close any target viewer or emit an endsession audit event.
- [ ] Self-disconnect and node remote-control/full-rights cases pass.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` lists only the scoped files for this change; preserve pre-existing unrelated work.
- [ ] Update the index row, or note that the reviewer owns it or the file was absent.

## STOP conditions

- If `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` fails, STOP: plan 001 has not landed. Do not substitute ad hoc tests.
- STOP if product policy now forbids self-disconnect without node rights; this plan explicitly preserves it.
- STOP if GetNodeWithRights no longer accepts `(domain, user, nodeid, callback)` or returns a different rights contract.
- STOP if the regression fails only due to fixture initialization rather than requester identity/close assertions; repair the scoped fixture first.

A live server is not required. Skip live checks and note that limitation instead of stopping.

## Maintenance notes

Do not conflate target identity with acting identity in future relay actions. Cross-domain administrator status alone does not grant node remote-control rights. No browser protocol change is needed.
