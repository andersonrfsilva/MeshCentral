# Plan 022: Complete explicit-node device details exactly once with an array

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer dispatched you and maintains the index.
>
> **Drift check (run first)**: `git diff --stat 4d8f043f..HEAD -- meshuser.js test/device-detailed-info.test.js plans/022-device-detailed-info-single-completion.md plans/README.md`
> Compare changed target code against Current state before proceeding. A mismatch is a STOP condition; documentation-only changes are not source drift.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-test-baseline.md`, `plans/017-small-correctness-fixes.md`
- **Category**: bug
- **Planned at**: commit `4d8f043f`, 2026-11-05

## Why this matters

Explicit-node detail requests can finish prematurely or twice when callbacks complete synchronously. An empty explicit list never completes, and the hidden-node path can return a string instead of the expected array. Apply the already-established all-device completion pattern without changing authorization or response formats.

## Current state

Repository: `/home/anderson/Desenvolvimento/oss/meshcentral`. Evidence comes from `/home/anderson/Desenvolvimento/oss/.wt/mc-017`, branch `advisor/017-small-correctness-fixes`, commit `4d8f043f`. Execute on that prerequisite stack, not the older main checkout.

`meshuser.js:8695-8701` increments pending work while dispatching:

```javascript
function getDeviceDetailedInfo(nodeids, type, func) {
    if (nodeids == null) { getAllDeviceDetailedInfo(type, func); return; }
    var results = [], resultPendingCount = 0;
    for (var i in nodeids) {
        // Fetch the node from the database
        resultPendingCount++;
```

`meshuser.js:8707-8709` finishes inside the final network-information callback:

```javascript
resultPendingCount--;
getNodeNetInfoFunc.results.push({ node: parent.CloneSafeNode(getNodeNetInfoFunc.node), sys: getNodeNetInfoFunc.sysinfo, net: netinfo });
if (resultPendingCount == 0) { func(getNodeFunc.results, type); }
```

`meshuser.js:8723-8732` has another completion check:

```javascript
    db.Get('si' + getNodeFunc.nodeid, getNodeSysInfoFunc);
} else { resultPendingCount--; }
if (resultPendingCount == 0) { func(getNodeFunc.results.join('\r\n'), type); }
```

This second check is inside the rights callback, not after the outer loop. Fully deferred DB callbacks alone may not reproduce duplicate completion; synchronous and mixed schedules are required. The empty loop has no completion point.

Plan 017 already fixed `getAllDeviceDetailedInfo`. Copy its exact counting structure from `meshuser.js:8754-8776`:

```javascript
function getDetailedInfo(nodeids) {
    resultPendingCount = nodeids.length;
    if (resultPendingCount == 0) { func(results, type); return; }
    const nodeDone = function () { if (--resultPendingCount == 0) { func(results, type); } };
    for (var i = 0; i < nodeids.length; i++) {
        const nodeid = nodeids[i];
```

```javascript
var sysinfo = null;
if ((err == null) && (docs != null) && (docs.length == 1)) { sysinfo = docs[0]; }
```

```javascript
results.push({ node: parent.CloneSafeNode(node), sys: sysinfo, net: netinfo });
nodeDone();
```

That function also calls `nodeDone()` for invisible/missing nodes. It has a single final completion point per node, not a generic done flag that hides partial results.

The caller at `meshuser.js:5492-5495` expects array records:

```javascript
getDeviceDetailedInfo(command.nodeids, command.type, function (results, type) {
    for (var i = 0; i < results.length; i++) {
        // Remove any device system and network information is we do not have details rights to this device
        if ((parent.GetNodeRights(user, results[i].node.meshid, results[i].node._id) & MESHRIGHT_DEVICEDETAILS) == 0) {
```

`test/small-correctness.test.js:103-147` tests the all-device sibling through `createMeshUserFixture`, stubbing `GetNodeWithRights`, `CloneSafeNode`, `db.Get`, and response serialization. Its assertions include:

```javascript
assert.equal(replies.length, 1, 'completion callback count');
assert.equal(replies[0].type, 'json');
const data = JSON.parse(replies[0].data);
assert.ok(Array.isArray(data));
```

For direct callback counting, that file's `extractFunction` and `compileFunction` helpers at lines 21-46 extract the real four-space-indented nested declaration and compile it with `node:vm`. Reuse the same local test pattern, not a copy of the production algorithm. `test/helpers/fake-parent.js:76-84` returns `obj`, `ws`, `parent`, `db`, and `close()` for real MeshUser command tests. CommonJS, four spaces, single quotes, `node:test`, and `node:assert/strict` are the conventions. `package.json:39-41,62-64` provides the test/check commands and requires Node >=20.

## Commands you will need

Run from the executor worktree root. No dependency installation is needed.

| Purpose | Command | Expected on success |
|---|---|---|
| Focused regressions | `node --test test/device-detailed-info.test.js test/small-correctness.test.js` | New explicit-node and existing all-device cases pass |
| Full suite | `npm test` | All pass |
| Syntax | `npm run check` | Exit 0 |
| Scope | `git diff --name-only` | Only in-scope paths |

## Scope

**In scope**:
- `meshuser.js` (`getDeviceDetailedInfo` only)
- `test/device-detailed-info.test.js` (create)
- `plans/022-device-detailed-info-single-completion.md` (execution evidence)
- `plans/README.md` (this status row only)

**Out of scope**: changing `getAllDeviceDetailedInfo`, command validation, rights checks, CSV/JSON serialization, response ordering guarantees, batching DB queries, production test exports, and shared fixture refactoring.

## Git workflow

- Branch `advisor/022-device-detailed-info-single-completion` from the prerequisite stack containing `4d8f043f`; preserve the evidence worktree.
- Commit the fix and its tests as a logical unit, for example `fix: complete explicit device detail queries once`. Observed history includes `4d8f043f test: regression cases for plan 017 small correctness fixes`.
- Do not push or open a PR without operator instruction.

## Steps

### Step 1: Apply the established counted-completion pattern

Preserve the leading null-nodeids delegation unchanged. Set `resultPendingCount = nodeids.length` before dispatching any callback. Complete an empty array immediately with `func(results, type); return;`. Use the sibling's exact `nodeDone` shape and an indexed loop with per-iteration `const nodeid`.

Keep `parent.GetNodeWithRights(domain, user, nodeid, callback)` as the visibility boundary. Missing/invisible nodes call `nodeDone()` and perform no system/network DB reads. Visible nodes query `db.Get('si' + nodeid, ...)`, then `db.Get('if' + nodeid, ...)`. Preserve error handling: missing/error/multiple documents produce null metadata; initialize both sys and net to null as the sibling does. Append one `{ node: parent.CloneSafeNode(node), sys: sysinfo, net: netinfo }` record, then call `nodeDone()` once. Delete the function-property transport and both old completion checks. Never join the results array into a string.

Add direct callback tests in the same change, extracting the real function using the existing VM pattern. Inject `parent`, `db`, `domain`, `user`, and a `getAllDeviceDetailedInfo` delegation spy. The injected `db` is the fixture's `parent.db`, not a separate unrelated object.

**Verify**: `node --test test/device-detailed-info.test.js` → empty, one-node, and three-node direct cases each complete once with an array.

### Step 2: Exercise timing, visibility, and the actual command boundary

For each of 0, 1, and 3 node IDs, use `setImmediate` in the fake `parent.db.Get`. Count callback invocations explicitly; do not rely on a Promise resolving only once. Drain all scheduled callbacks and at least one extra `setImmediate` before checking the final count. Add fully synchronous, reverse-order queued, and mixed schedules; otherwise the original duplicate behavior can evade detection.

Cover all-visible, all-hidden, mixed-visible, missing node, absent metadata, and DB callback error cases. Assert full visible-ID membership, record count, array type, unchanged type argument, null metadata on failures, and no metadata reads for hidden/missing nodes. Assert null nodeids delegates once to the sibling. A duplicate driver callback is not part of the supported contract; do not add a broad done guard to conceal it.

Add a real command case using `createMeshUserFixture` and the existing `device-details` test setup. Emit `getDeviceDetails` with `type: 'json'` and explicit `nodeids`. Stub the same connectivity, rights, last-connect, and list-query functions as that exemplar. Clear initial captures, await the deferred work, and require exactly one reply containing the expected records. Close the fixture in finally. Keep existing all-device tests unchanged.

**Verify**: `node --test test/device-detailed-info.test.js test/small-correctness.test.js` → all schedules, explicit commands, and prior all-device regressions pass.

### Step 3: Run gates and record results

Record focused test, suite, and syntax results here. Update only this index row unless the reviewer owns it.

**Verify**: `npm test && npm run check && git diff --name-only` → tests and syntax pass; modified files stay within Scope.

## Test plan

Create `test/device-detailed-info.test.js` following `test/small-correctness.test.js` VM extraction and fake-parent patterns. Required cardinalities: 0, 1, and 3. Required schedules: setImmediate-deferred, synchronous, reverse completion, and mixed. Required branches: visible, hidden, missing node, absent/error metadata, and null-list delegation. Verify exactly one callback after all work settles, array response type, correct membership, and unchanged type argument. Include at least one explicit-node command test through real MeshUser. Run the focused command, `npm test`, and `npm run check`.

## Done criteria

- [ ] Pending count is initialized before dispatch; empty lists complete once.
- [ ] Each node has one completion path; no string join remains in this function.
- [ ] Direct callback tests pass for 0, 1, and 3 IDs under deferred and synchronous schedules.
- [ ] Visibility and metadata failures preserve the documented array contract.
- [ ] Explicit command produces one JSON reply; existing all-device tests still pass.
- [ ] Focused tests, `npm test`, and `npm run check` exit 0.
- [ ] Scope check lists only allowed files; evidence/index updated or reviewer ownership recorded.

## STOP conditions

Stop for target drift, two failed gate attempts, or required edits outside Scope. Stop if callers accept a non-array nodeids value that the sibling's length/index pattern cannot support. Stop if a rights callback legitimately fires more than once or callers require string results. Do not silence repeated callbacks or relax tests to accept partial results. If all-device behavior differs from the quoted plan-017 code, reconcile the prerequisite stack first.

## Maintenance notes

Pre-counting prevents early completion; a done flag alone does not. Keep the explicit and all-device functions aligned on null metadata and array results without introducing a broader refactor here. Timing tests must retain synchronous callbacks because deferred-only tests can miss this regression. Result order remains completion order, not a new API guarantee.
