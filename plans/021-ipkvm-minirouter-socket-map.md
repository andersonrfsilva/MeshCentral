# Plan 021: Track every MiniRouter socket by identity and destroy all sockets on stop

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer dispatched you and maintains the index.
>
> **Drift check (run first)**: `git diff --stat 4d8f043f..HEAD -- meshipkvm.js test/ipkvm-minirouter.test.js plans/021-ipkvm-minirouter-socket-map.md plans/README.md`
> Compare changed source with Current state. A target-code mismatch is a STOP condition; documentation-only changes are not source drift.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-test-baseline.md`, `plans/017-small-correctness-fixes.md`
- **Category**: bug
- **Planned at**: commit `4d8f043f`, 2026-11-05

## Why this matters

MiniRouter stores socket objects as ordinary object keys, collapsing their identities to strings. Its stop loop then passes those strings, not socket objects, into cleanup. Shutdown can fail to close any actual TCP socket, retaining relay connections; identity-based tracking fixes both defects.

## Current state

Repository: `/home/anderson/Desenvolvimento/oss/meshcentral`. Evidence worktree: `/home/anderson/Desenvolvimento/oss/.wt/mc-017`, branch `advisor/017-small-correctness-fixes`, commit `4d8f043f`. Execute on the completed prerequisite stack, not the older main checkout.

`meshipkvm.js:986-1005` defines an internal factory:

```javascript
function CreateMiniRouter(parent, nodeid, targetHost, targetPort) {
    const Net = require('net');
    const WebSocket = require('ws');
    const obj = {};
    const tcpSockets = {}
```

```javascript
function closeTcpSocket(tcpSocket) {
    if (tcpSockets[tcpSocket]) {
        delete tcpSockets[tcpSocket];
        try { tcpSocket.end(); } catch (ex) { console.log(ex); }
        if (tcpSocket.relaySocket) { try { tcpSocket.relaySocket.close(); } catch (ex) { console.log(ex); } }
        try { delete tcpSocket.relaySocket.tcpSocket; } catch (ex) { }
        try { delete tcpSocket.relaySocket; } catch (ex) { }
    }
}
```

`meshipkvm.js:1016-1025,1031-1033` starts a loopback server and installs cleanup handlers:

```javascript
obj.tcpServer = new Net.Server();
```

```javascript
obj.tcpServer.on('connection', function (socket) {
    tcpSockets[socket] = 1;
    socket.pause();
```

```javascript
socket.on('end', function () { closeTcpSocket(this); });
socket.on('close', function () { closeTcpSocket(this); });
socket.on('error', function (err) { closeTcpSocket(this); });
```

`meshipkvm.js:1047-1048` associates relay and TCP sockets:

```javascript
socket.relaySocket = new WebSocket(url, options);
socket.relaySocket.tcpSocket = socket;
```

`meshipkvm.js:1073-1083` shows the incorrect iteration and the only module export:

```javascript
obj.stop = function () {
    for (var tcpSocket in tcpSockets) { closeTcpSocket(tcpSocket); }
    obj.tcpServer.close();
    obj.tcpServer = null;
}
```

```javascript
module.exports.CreateIPKVMManager = CreateIPKVMManager;
```

Do not add a public export just for testing. `test/small-correctness.test.js:49-56` already loads whole production modules through `node:vm`, appends test-only exports, and supplies a local require:

```javascript
const wrapper = vm.runInThisContext('(function (module, exports, require, __x) {' + src + '\n})', { filename: full });
const m = { exports: {} }, x = {};
wrapper(m, m.exports, Module.createRequire(full), x);
```

Use this pattern in the new test with a require wrapper returning fake `net` and `ws`, delegating other modules to `Module.createRequire(full)`. Match the CommonJS, four-space, single-quote style and `node:test` / `node:assert/strict` imports in that file. `package.json:39-41,62-64` supplies the test/check scripts and Node >=20 requirement.

## Commands you will need

Run from the executor worktree root; do not install dependencies or connect to appliances.

| Purpose | Command | Expected on success |
|---|---|---|
| Focused test | `node --test test/ipkvm-minirouter.test.js` | All pass without real sockets |
| Old map search | `grep -nF 'tcpSockets[' meshipkvm.js` | No matches; exit 1 |
| Full suite | `npm test` | All pass |
| Syntax | `npm run check` | Exit 0 |
| Scope | `git diff --name-only` | Only in-scope paths |

## Scope

**In scope**:
- `meshipkvm.js` (`CreateMiniRouter` socket ownership only)
- `test/ipkvm-minirouter.test.js` (create)
- `plans/021-ipkvm-minirouter-socket-map.md` (execution evidence)
- `plans/README.md` (this status row only)

**Out of scope**: TLS policy, credentials/cookies, routing URLs, flow-control changes, appliance protocols, exported API changes, dependencies, and general IPKVM refactoring.

## Git workflow

- Branch `advisor/021-ipkvm-minirouter-socket-map` from the prerequisite stack containing `4d8f043f`; leave the evidence worktree untouched.
- Use a logical commit such as `fix: retain MiniRouter socket identity during shutdown`. Observed history uses `fix:` and `test:` prefixes; `4d8f043f` is `test: regression cases for plan 017 small correctness fixes`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Replace object-key tracking and make stop terminate real sockets

Use `const tcpSockets = new Set();`. Insert sockets with `add`, guard cleanup with `has`, and remove with `delete` before any operation that can synchronously emit a close event. Iterate actual members with `for (const tcpSocket of tcpSockets)` in `stop`.

Keep ordinary end/error/relay-close cleanup behavior, including counterpart-reference removal. For stop specifically, destroy every active TCP socket, not merely call `end()` and leave a half-open connection. The smallest explicit approach is an optional internal force argument to `closeTcpSocket`: call `destroy()` when true, otherwise retain `end()`. Pass true only from `stop`. Delete from the Set before either operation so reentrant callbacks cannot run cleanup twice. Keep relay `close()` and reference cleanup once per pair. Preserve existing try/catch boundaries and flow-control handlers.

Add the new test in the same logical change so socket closure is covered immediately.

**Verify**: `node --test test/ipkvm-minirouter.test.js` → three simultaneously connected fake sockets are all destroyed once by stop, and all three relay close spies run once.

### Step 2: Cover independent disconnect and callback reentrancy

Load the actual module through the VM pattern above, exposing only `CreateMiniRouter` inside the test. Inject a fake `net.Server` extending EventEmitter with `listen`, `address` returning `{ port: 12345 }`, and `close` spies. Invoke its listen callback on `setImmediate` so connection listeners are registered first. Fake `ws` must be a constructible EventEmitter with `close`, `send`, and a minimal `_socket`; do not make any network connection.

Provide `parent.parent` with no-op `debug`, deterministic `encodeCookie`, synthetic `loginCookieEncryptionKey`, `config.domains[''] = { id: '' }`, and `args = { port: 443 }`. Construct with `node//test`, `127.0.0.1`, and port 5900. Start the router, await readiness, and emit three server `connection` events with separate EventEmitter TCP sockets. Each socket needs pause/resume/write/end/destroy spies and ordinary object stringification; never assign unique stringification that would hide the original bug.

Cases: stop with three active sockets; one socket ends before stop and the other two remain tracked; relay close causes only its own TCP cleanup; repeated close/error events do not close another pair; synchronous close emission from destroy does not duplicate cleanup. Preserve relay references in test variables before production deletes them. Assert the server close spy runs once and `router.tcpServer` becomes null. Do not impose repeated `stop()` support; it is outside this plan.

**Verify**: `node --test test/ipkvm-minirouter.test.js` → every named scenario passes and no real network handles exist.

### Step 3: Run gates and document completion

Run the old-map search, focused test, suite, and syntax check. Record outcomes here; update only this index row unless reviewer-owned.

**Verify**: `npm test && npm run check && git diff --name-only` → exit 0 and only scoped changes.

## Test plan

New `test/ipkvm-minirouter.test.js`, using the VM loading pattern from `test/small-correctness.test.js:49-56`. Required cases are three active sockets, one early disconnect, relay-originated disconnect, repeated event cleanup, and synchronous destroy reentrancy. Assert counts per socket, not just total counts. `node --test test/ipkvm-minirouter.test.js`, `npm test`, and `npm run check` must pass. Real appliance integration is not exercised.

## Done criteria

- [ ] Tracking uses socket identity and the old indexed map search returns no matches.
- [ ] Stop destroys all three simultaneously active TCP sockets and closes all three relay sockets.
- [ ] Early close affects only its own pair; remaining sockets are destroyed on stop.
- [ ] Reentrant and repeated close events do not duplicate cleanup.
- [ ] No public factory export or network-dependent test was added.
- [ ] Focused test, `npm test`, and `npm run check` exit 0.
- [ ] Scope check contains only allowed paths; evidence/index updated or reviewer ownership recorded.

## STOP conditions

Stop for target drift, two failed verification attempts, or required out-of-scope edits. Stop if callers require stop to drain pending TCP bytes rather than terminate the router; do not silently change that contract. Stop if the test loader cannot isolate both net and ws without global require mutation. Never alter cookie or TLS behavior to make the test pass.

## Maintenance notes

Set deletion must precede close/destroy because socket callbacks can reenter cleanup. Keep normal half-close behavior separate from forced router shutdown. Review per-socket assertions carefully: aggregate counts can hide one socket being closed repeatedly while others leak. No appliance, TLS endpoint, or live relay is covered by these fake-socket tests.
