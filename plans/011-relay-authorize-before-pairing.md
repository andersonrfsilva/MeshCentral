# Plan 011: Authorize node access before publishing or pairing a relay

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm its expected result before proceeding. If a STOP condition occurs, stop and report; do not improvise. Update this plan's status row in `plans/README.md` when finished, unless the dispatching reviewer owns the index. If the index is absent, skip and note it.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshrelay.js test/relay-authorization.test.js plans/011-relay-authorize-before-pairing.md plans/README.md`
> Compare changed source against the excerpts below. Plan 001's new test infrastructure is expected; changed authorization behavior is not.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: HIGH
- **Depends on**: `plans/001-test-baseline.md`
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

A no-cookie relay can become visible to another connection before its asynchronous node authorization completes. Pairing releases traffic, so closing the connection after a denied lookup is too late. Keep the relay unpublished until both node rights and protocol rights pass.

## Current state

`meshrelay.js` owns relay creation and pairing. Its public wrapper does not return the internal object:

```js
// meshrelay.js:82
module.exports.CreateMeshRelay = function (parent, ws, req, domain, user, cookie) {
// meshrelay.js:90-92
    } else {
        CreateMeshRelayEx(parent, ws, req, domain, user, cookie);
    }
```

The following are exact excerpts from the authorization branch:

```js
// meshrelay.js:1087-1094
parent.db.Get(obj.req.query.nodeid, function (err, docs) {
    if (docs.length == 0) { console.log('ERR: Node not found'); try { obj.close(); } catch (e) { } return; } // Disconnect websocket
    const node = docs[0];

    // Check if this user has permission to relay thru this computer (MESHRIGHT_REMOTECONTROL or MESHRIGHT_RELAY rights)
    const rights = parent.GetNodeRights(obj.user, node.meshid, node._id);
    if ((rights & 0x00200008) == 0) { console.log('ERR: Access denied (2)'); try { obj.close(); } catch (ex) { } return; }
    if (isProtocolAllowedByRights(rights, parseInt(obj.req.query.p)) == false) { console.log('ERR: Access denied (3)'); try { obj.close(); } catch (ex) { } return; }
// meshrelay.js:1097-1100
    obj.nodeid = node._id;
    obj.meshid = node.meshid;
});
}
// meshrelay.js:1142-1143
performRelay();
return obj;
```

The cookie branch already calls `performRelay(0)` inside its database callback and returns `obj` immediately afterward (`meshrelay.js:1079-1081`). Match that sequencing, not its unused argument.

`performRelay` starts at `meshrelay.js:333`. It looks up `parent.wsrelays[obj.id]` at line 366. With a waiting peer, lines 401-406 execute:

```js
obj.peer = relayinfo.peer1;
obj.peer.peer = obj;
relayinfo.peer2 = obj;
relayinfo.state = 2;
relayinfo.peer1.ws._socket.resume(); // Release the traffic
relayinfo.peer2.ws._socket.resume(); // Release the traffic
```

Without a peer, `meshrelay.js:656` publishes `{ peer1: obj, state: 1, timeout: setTimeout(closeBothSides, 15000) }`. Thus the security boundary is the call to `performRelay`, not merely a later data event.

Use CommonJS, four-space indentation, callback style, single quotes, and the existing compact close-and-return guards above. `package.json:58-60` declares Node >=20; use Node >=20.19 for the lockfile. At this commit there are no test scripts; Plan 001 establishes them.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Baseline prerequisite | `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c meshrelay.js` | Exit 0, no output |
| Focused tests | `node --test test/relay-authorization.test.js` | All tests pass |
| Full tests | `npm test` | All tests pass |
| Scope | `git diff --name-only` | Only scope files changed |

## Scope

**In scope**:
- `meshrelay.js`
- `test/relay-authorization.test.js` (create)
- `plans/011-relay-authorize-before-pairing.md` (completion evidence)
- `plans/README.md` (status only, if present)

**Out of scope**: desktop multiplexing, messenger authentication, relay protocol changes, cookie routing, database APIs, unrelated error handling, production configuration. Read but do not modify Plan 001's helper.

## Git workflow

- Branch: `advisor/011-relay-authorize-before-pairing`.
- Preserve existing user changes; do not reset files.
- Commit one logical fix with tests: `security: authorize relay before pairing`. Append `(#NNNN)` only when a real issue number exists, matching repository conventions.
- Do not push or open a PR without instruction.

## Steps

### Step 1: Establish the regression harness

Check the prerequisite first; if `npm test` does not exist, STOP. Create the test file using `const { test } = require('node:test'); const assert = require('node:assert');`. Reuse Plan 001's fake-parent helper where its API fits, extending the returned fake locally rather than changing the shared helper.

Exercise `require('../meshrelay.js').CreateMeshRelay(parent, ws, req, domain, user, null)`, not the private `CreateMeshRelayEx`. Do not depend on its return value. Use `req.query = { id: 'relay-test', nodeid: 'node/test/device', p: '2' }`, `req.clientIp = '127.0.0.1'`, `domain = { id: 'test' }`, and `user = { _id: 'user/test/alice' }`. Omit routing ports and messenger IDs.

Supply `parent.db.Get` that captures, but does not immediately invoke, its callback; `parent.GetNodeRights`; `parent.wsrelays = {}`; `parent.args = {}`; numeric session/error counters; `parent.parent.debug` as a no-op; and `parent.trafficStats.relayIn`/`relayOut`. Disable multiserver, Firebase, recording and cookie expiration by leaving them absent. Use an EventEmitter fake websocket with captured `send`, counted `close`, and `_socket` methods `setKeepAlive`, `pause`, `resume`, plus zero byte counters and a protocol index. The fake close method need not emit `close` automatically. Tests must explicitly release timers and any fake resources afterward.

**Verify**: `node -c test/relay-authorization.test.js` → exit 0. This step checks harness syntax only; do not require the known-vulnerable regression to pass yet.

### Step 2: Move only the gated relay call

Inside the no-routing branch's `db.Get` callback, add `performRelay()` immediately after setting `obj.nodeid` and `obj.meshid`. Immediately after that `db.Get(...)` invocation, add `return obj` inside the node-ID condition. This prevents fallthrough to line 1142 only for the asynchronous node-authorization path. Leave the final `performRelay()` for paths without that lookup. Preserve both existing rights guards and the cookie branch.

Add a brief comment explaining that publishing/pairing must wait for authorization.

**Verify**: `node -c meshrelay.js` → exit 0, no output.

### Step 3: Prove ordering and rejection

Complete the tests specified below. For denied access, assert an empty `wsrelays` before releasing the callback, then invoke it with one valid node and rights 0; assert it stays empty and `ws.close` was called. For allowed access, return full rights (`0xFFFFFFFF`), assert no publication before callback, then assert state 1 and populated node/mesh IDs afterward. Clear the state's timeout in test teardown.

Add an existing-waiter test: seed `wsrelays[id]` with state 1 and an inert peer. While the lookup is pending and after denial, assert the waiter remains state 1, has no `peer2`, and neither websocket resumed. This exercises the pairing hazard without needing the recording/event machinery of a successful paired session.

**Verify**: `node --test test/relay-authorization.test.js` → all four minimum cases pass: pending/denied, authorized publication, empty-node rejection, and existing-waiter denial.

### Step 4: Record and finish

Run full tests, record the security ordering change and verification result in this plan, and update the index if present. No live relay server is required; skip and note live testing when unavailable.

**Verify**: `npm test && git diff --name-only` → all tests pass; changed paths are within Scope.

## Test plan

Use Plan 001's Node test conventions and fake-parent helper; no test existed at the planned commit. All new tests live in `test/relay-authorization.test.js`. Cover deferred denial with rights 0, allowed publication only after callback, missing node, and a pre-existing waiting peer remaining unpaired on denial. Capture `ws.close`; do not mistake lack of a thrown exception for authorization success. Verification: `node --test test/relay-authorization.test.js` → at least four passing cases, no failures or leaked 15-second timers.

## Done criteria

- [ ] `node -c meshrelay.js` exits 0.
- [ ] Focused tests and `npm test` pass.
- [ ] Deferred denied lookup never publishes a relay and calls `ws.close`.
- [ ] Allowed lookup publishes only after rights checks and node/mesh assignment.
- [ ] Existing waiting peer cannot pair with an unauthorized pending lookup.
- [ ] Only Scope files changed; completion evidence and index status updated (or absent index noted).

## STOP conditions

- `npm test` is missing: Plan 001 has not landed.
- The public wrapper or authorization branches differ materially from the excerpts after drift comparison.
- The no-cookie node lookup is now shared with a routing path requiring different rights; do not guess its authorization contract.
- Tests show pairing still occurs before the deferred callback, or unrelated cookie/messenger paths require changes to pass.
- A fix requires changes outside Scope or a verification fails twice after a reasonable correction.

## Maintenance notes

Keep authorization ahead of `wsrelays` mutation, peer assignment and socket resume. Future asynchronous checks must preserve that ordering. This plan does not redesign denial cleanup or database error handling. The high risk is accidentally moving the final relay call for unrelated paths; review the placement of the new `return obj` carefully.
