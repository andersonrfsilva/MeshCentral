# Plan 018: Deduplicate event recipients in linear time and reuse fetched device documents

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshcentral.js meshuser.js webserver.js test/device-dispatch-perf.test.js scripts/dispatch-timing.js plans/018-device-list-and-dispatch-perf.md plans/README.md`
> Compare source with Current state. Plan 017 intentionally changes detailed-list initialization/completion; read its final diff and carry those fixes forward. Unexplained mismatch, rather than the expected prerequisite change, is a STOP condition. Plan/index text changes alone are not source drift.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001 (test harness); `plans/017-small-correctness-fixes.md` (device-detail callback correctness)
- **Category**: perf
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Detailed device export reads each node twice and then loads its system and network records. Event dispatch repeatedly scans a growing recipient array to avoid duplicate notifications. Reuse the fetched node without bypassing authorization, and use Set membership without changing delivery order. Keep more invasive database batching, subscription indexing, and viewer backpressure changes explicitly separate.

## Current state

Repository root: `/home/anderson/Desenvolvimento/oss/meshcentral`. `package.json:58-60` requires Node >=20. The baseline has no test/build/lint scripts; Plan 001 supplies `npm test`, `npm run check`, and `test/helpers/fake-parent.js`. Follow CommonJS, callback APIs, four-space indentation, and single-quoted new strings. Callback-style exemplar: `webserver.js:9895` uses `db.Get(nodeid, function (err, nodes) {`.

### Device-detail query path

`meshuser.js:8761` fetches the node documents already:

```javascript
db.GetAllTypeNoTypeFieldMeshFiltered(links, extraids, domain.id, 'node', null, obj.deviceSkip, obj.deviceLimit, obj.deviceFilter, function (err, docs) {
```

At `meshuser.js:8771,8791,8798,8804`, it cleans the documents but fetches each node again through the rights helper, then fetches two metadata records:

```javascript
parent.cleanDevice(docs[i]);
db.Get('if' + getNodeSysInfoFunc.nodeid, getNodeNetInfoFunc);
db.Get('si' + getNodeFunc.nodeid, getNodeSysInfoFunc);
parent.GetNodeWithRights(domain, user, docs[i]._id, getNodeFunc);
```

For N visible returned nodes, this is `1 + 3N` logical DB calls: one list, N node reads, N sysinfo reads, N ifinfo reads. This count excludes backend-internal operations. Paged mode at `meshuser.js:8810-8842` only has IDs in `obj.visibleDevices`, not node documents; it still needs each node read.

`webserver.js:9882-9896` is the shared authorization entry point:

```javascript
obj.GetNodeWithRights = function (domain, user, nodeid, func) {
```
```javascript
if ((domain != null) && (snode[1] != domain.id)) { func(null, 0, false); return; } // Invalid domain
```
```javascript
db.Get(nodeid, function (err, nodes) {
    if ((nodes == null) || (nodes.length != 1)) { func(null, 0, false); return; } // No such nodeid
```

The remaining body (lines 9898-9947) checks super-user domain management, direct device links, mesh links, and user-group links, then calls `removeUserRights`. Critically, visibility is separate from rights bits: lines 9907-9912 initialize `visible = false` and set it true when a direct link exists, even if its rights are zero. The final callback at line 9947 is `func(nodes[0], rights, visible)`. Do not replace this with `GetNodeRights(...) !== 0`; that would change authorization/visibility semantics.

### Existing multi-get capability and its limits

A typed multi-get DOES exist. `db.js:1757-1761`:

```javascript
obj.GetAllIdsOfType = function (ids, domain, type, func) {
    sqlDbQuery('SELECT doc FROM main WHERE (id IN (' + dbMergeSqlArray(ids) + ')) AND domain = $1 AND type = $2', [domain, type], function (err, docs) {
        if (docs != null) { for (var i in docs) { delete docs[i].type; if (docs[i].links != null) { docs[i] = common.unEscapeLinksFieldName(docs[i]); } } }
        func(err, performTypedRecordDecrypt(docs));
    });
}
```

`db.js:2044` implements the AceBase variant with `_id in ids`, domain, and type filters, returning decrypted docs without the same explicit type removal. `db.js:2896,3147` have Mongo/NeDB variants. This is not an untyped arbitrary multi-get with a documented identical output shape. A batching follow-up must compare it with individual `Get` records on each supported backend and preserve exported fields, null/missing semantics, and failure handling. Do not claim that no batching API exists.

### Event dispatch

`meshcentral.js:2545-2553` deduplicates using a linear search per candidate:

```javascript
const targets = []; // List of targets we dispatched the event to, we don't want to dispatch to the same target twice.
for (var j in ids) {
    const id = ids[j];
    const eventsDispatch = obj.eventsDispatch[id];
    if (eventsDispatch) {
        for (var i in eventsDispatch) {
            if (targets.indexOf(eventsDispatch[i]) == -1) { // Check if we already displatched to this target
                targets.push(eventsDispatch[i]);
                try { eventsDispatch[i].HandleEvent(source, event, ids, id); } catch (ex) { console.log(ex, eventsDispatch[i]); }
```

`RemoveAllEventDispatch` at `meshcentral.js:2503-2516` scans every subscription bucket:

```javascript
for (var i in obj.eventsDispatch) {
    const j = obj.eventsDispatch[i].indexOf(target);
```

It deliberately replaces lists rather than modifying in-flight arrays (line 2511):

```javascript
const newList = []; // We create a new list so not to modify the original list. Allows this function to be called during an event dispatch.
```

### Viewer queue (separate traffic direction)

`meshdesktopmultiplex.js:452-477`:

```javascript
if (viewer.sending) {
    viewer.sendQueue.push(data);
} else {
    viewer.sending = true;
```

Its overflow check at lines 473-476 counts packets, not bytes, and pauses the agent only when every viewer is overflowing:

```javascript
if ((viewer.sendQueue.length > 5) || ((viewer.dataPtr != null) && (viewer.dataPtr != obj.lastData))) {
    viewer.overflow = true;
    obj.viewersOverflowCount++;
    if ((obj.viewersOverflowCount >= obj.viewers.length) && obj.agent && (obj.agent.paused == false)) { obj.agent.paused = true; obj.agent.ws._socket.pause(); }
}
```

One slow viewer therefore has no hard byte limit. Dropping arbitrary desktop packets can corrupt a stateful display stream; this cannot be treated as a generic discard-oldest queue.

## Commands you will need

Run from repository root; no install or external service is needed.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const s=require('./package.json').scripts; if(!s || !s.test || !s.check) process.exit(1)"` | Exit 0; otherwise STOP for Plan 001 |
| Prior correctness | `node --test --test-name-pattern=device-details test/small-correctness.test.js` | Plan 017's case passes |
| Focused tests | `node --test test/device-dispatch-perf.test.js` | All pass |
| Timing | `node scripts/dispatch-timing.js` | Prints sizes, candidate counts, timings, matching delivery checksums; exit 0 |
| Syntax | `node -c meshcentral.js && node -c meshuser.js && node -c webserver.js && node -c scripts/dispatch-timing.js` | Exit 0 |
| Full gates | `npm test && npm run check` | Exit 0 |
| Scope | `git diff --name-only` | Only Scope paths |

The timing script is created by this plan, not an existing command. A timing improvement is reported, not used as a flaky wall-clock test threshold.

## Scope

**In scope** (only files to modify):
- `meshcentral.js` (DispatchEvent membership only)
- `meshuser.js` (non-paged detailed export node reuse only)
- `webserver.js` (shared rights helper supplied-document path)
- `test/device-dispatch-perf.test.js` (create)
- `scripts/dispatch-timing.js` (create)
- `plans/018-device-list-and-dispatch-perf.md` (timing results, decisions, completion)
- `plans/README.md` (status)

**Out of scope**:
- `db.js`: no new query API, batching, indexes, or backend changes in this implementation.
- `meshdesktopmultiplex.js`: Step C below explicitly scopes out viewer queue policy; Plan 017 separately fixes the opposite, agent-bound queue.
- `RemoveAllEventDispatch`: do not add reverse subscription maps, change list mutation semantics, or optimize teardown here.
- Public response formats, permission semantics, caching node data across requests, pagination redesign, and dependency additions.

## Git workflow

- Branch: `advisor/018-device-list-and-dispatch-perf`.
- Commit logical units with repository-style subjects such as `fix: deduplicate event recipients with Set` and `fix: reuse fetched nodes in detailed device export`.
- Base this work on completed Plan 017. Preserve unrelated work and prior tests.
- Do not push/open a PR unless instructed.

## Steps

### Step A1: Replace only recipient membership tracking

In `DispatchEvent`, change `const targets = []` to `const targets = new Set()`, the membership condition to `!targets.has(eventsDispatch[i])`, and insertion to `targets.add(eventsDispatch[i])`. Keep nested traversal order unchanged. Add to the Set before calling `HandleEvent`, just as the old array records the recipient before calling it. Preserve event storage, logging, peer dispatch, exception isolation, and the local `eventsDispatch` snapshot. Do not change subscription bucket storage to Sets.

Create `test/device-dispatch-perf.test.js` using `node:test`, `node:assert/strict`, and Plan 001 fake-parent patterns. For this large factory, a narrowly extracted production `obj.DispatchEvent` function executed with `node:vm` and a fake obj is acceptable. Assert extraction starts at its exact assignment and ends before the next documented method, or fail. Do not test a hand-copied implementation.

Test duplicate recipients across and within buckets, repeated IDs, empty/unknown IDs, two distinct objects with the same properties, a throwing handler, and a handler that removes a subscription while dispatch is running. Assert exact recipient order, one call per object, first matching bucket ID passed to the handler, continued delivery after an exception, unchanged StoreEvent and multiServer call counts, and no dispatch when obj.db is absent. Include independent reentrant dispatch: its Set must not leak into the outer call.

**Verify**: `node --test --test-name-pattern=dispatch test/device-dispatch-perf.test.js` → dispatch cases pass. `node -c meshcentral.js` → exit 0.

### Step A2: Add an explicit, reproducible timing script

Create `scripts/dispatch-timing.js` using only built-in Node modules. Load the actual production `DispatchEvent` method with the same bounded VM extraction strategy; never start the server. Supply fake db/handlers and use `event.nolog` so storage cost does not hide membership cost. Compare against the old array/indexOf traversal retained only inside this timing script as a clearly labeled baseline, not a production fallback.

Use deterministic bucket fixtures with 100, 1000, and 10000 unique recipient objects, ten overlapping buckets, and repeated IDs. Warm up each implementation, run five measured samples with `process.hrtime.bigint()`, and print median milliseconds, candidate count, unique count, and old/new ratio. Assert ordered delivered IDs match for every size before timing; retain a checksum to ensure work is consumed. No network, disk writes, dependency installs, or timing thresholds. Keep the fixture seed/data construction outside measured intervals.

Record actual output in this plan after execution. Do not invent a speedup in advance. If timings are noisy, report them as such; functional equality and Set membership are the deterministic acceptance criteria.

**Verify**: `node scripts/dispatch-timing.js` → three size rows, matching ordered deliveries/checksums, exit 0. `node -c scripts/dispatch-timing.js` → exit 0.

### Step B1: Allow the existing rights helper to authorize an already-fetched node

First enumerate callers with `rg -n 'GetNodeWithRights' --glob '*.js'`; only the detailed non-paged export will supply the new parameter. Keep existing four-argument callers valid because they still require database lookup, not because of a deprecated compatibility shim.

Extend `obj.GetNodeWithRights(domain, user, nodeid, func)` with an optional fifth argument `node`. Keep ALL current user and node-ID prevalidation. Move the existing `db.Get` callback body into a local named function, retaining the same nodes-array and callback semantics. With no supplied document, call `db.Get(nodeid, thatFunction)` as before. With a supplied document, require it to be a non-null object whose `_id` equals nodeid and whose `domain` matches the validated node-ID domain (and the provided domain when present). Invalid supplied data must return `func(null, 0, false)`, not fall back to DB lookup. Valid supplied data calls the same authorization body with a one-element array. Do not require a `type` field: the listing intentionally uses a no-type-field API.

Do not duplicate or approximate the super-user/direct/mesh/user-group permission logic. Keep `removeUserRights`, visibility separate from rights, and callback ordering. The extra document is an internal server result, never a client-provided object. Do not expose it through a command field or retain it beyond this request.

Tests must execute the actual rights helper with fake DB, users, groups, and restrictions. Cover legacy four-argument lookup once, supplied-document lookup zero times, mismatched ID/domain rejection, user-group/direct/mesh visibility, zero-rights visible links, denied users, managed-domain superusers, restricted rights, and nonexistent database nodes. Assert supplied and fetched versions return the same `(node, rights, visible)` for equivalent inputs.

**Verify**: `node --test --test-name-pattern=rights test/device-dispatch-perf.test.js` → authorization-equivalence cases pass. `node -c webserver.js` → exit 0.

### Step B2: Reuse nodes only in the non-paged detailed export

At the non-paged `GetNodeWithRights` call formerly at `meshuser.js:8804`, pass the already-fetched `docs[i]` as the fifth argument. Keep `cleanDevice(docs[i])` at its current point and keep `CloneSafeNode` on output. Do not send the original DB object directly to the browser. The paged branch has only IDs, so keep its four-argument call and node reads.

Carry forward Plan 017's initialized state, exact-once completion, empty-list handling, and array response. Preserve the two per-visible-node `si` and `if` reads. Test with a fake DB call counter: for N=0,1,10 fully visible non-paged nodes, logical calls become `1 + 2N`; node Get calls are zero. Paged mode stays `3N` for N IDs. Denied nodes do not trigger metadata reads. Compare complete output against a baseline fixture, including sanitized node fields and missing sys/net behavior. Run callback permutations and synchronous callbacks, not just the default scheduling order.

**Verify**: `node --test test/device-dispatch-perf.test.js` and `node --test --test-name-pattern=device-details test/small-correctness.test.js` → call-count, authorization, output, and prior completion cases pass.

### Step B3: Record the batching boundary instead of adding a database abstraction

Keep typed si/if batching out of this implementation even though `GetAllIdsOfType` exists. The initial N-call saving requires no backend changes and has deterministic per-node output equivalence. Typed batching requires validating backend-specific field removal, domain/type filtering, errors, ordering, and maximum ID-list sizes. Record this as a follow-up in Maintenance; do not claim the existing API is absent, do not add an untyped multi-get, and do not leave scaffolding in production.

**Verify**: `git diff -- db.js` → empty. `node --test --test-name-pattern=device-list test/device-dispatch-perf.test.js` → measured non-paged calls are exactly `1 + 2N`, not an untested batching claim. Name the call-count tests `device-list` so this command selects them.

### Step C: Explicitly defer byte-bounded viewer queues

No queue code changes in this plan. The evidence shows a real unbounded-byte risk, but a drop-oldest/drop-newest policy can corrupt delta-encoded desktop state. Selecting a safe byte budget requires frame-size measurements and testing viewer removal, overflow accounting, delayed sends, and shared retained desktop data. That is a separate medium-risk backpressure change, not a safe addition to recipient deduplication.

A follow-up should choose a documented per-viewer byte limit and disconnect a slow viewer on overflow rather than dropping arbitrary packets. It must count UTF-8 string bytes/Buffer bytes, decrement accounting on drain, clear it on disconnect, and preserve other viewers. This plan neither implements that policy nor claims viewer memory is bounded. Record this residual risk in the completion summary.

**Verify**: `git diff -- meshdesktopmultiplex.js` → no change attributable to this plan; an existing Plan 017 commit is not reverted. `git diff --name-only` → only Scope paths.

### Step D: Run gates and publish measured results locally

Run the commands below once the implementation is complete. Record call counts, timing rows, and the two explicit deferrals in this plan. Update the index status. If the index is absent, record completion here for its owner. No live server is required.

**Verify**: `npm test && npm run check && node scripts/dispatch-timing.js` → exit 0, all regressions pass, timing output recorded. `git diff --name-only` → only Scope paths.

## Test plan

`test/device-dispatch-perf.test.js` uses built-in Node tests/assertions and source-bound VM extraction only where exported factories would start unrelated services. Assert extraction markers to prevent empty or wrong-source tests. Use top-level names containing `dispatch`, `rights`, and `device-list` for the focused commands above. At least three test groups must cover all cases specified in A1, B1, and B2.

Machine acceptance is ordered recipient equivalence, exact-once callbacks, authorization equivalence, and counted DB calls. Timing is supporting evidence with reproducible workload metadata, not a pass/fail speed threshold. Keep Plan 017's `device-details` regression unchanged and passing. Do not add tests that assert performance by sleeping or using production services.

## Done criteria

- [ ] DispatchEvent uses Set membership while preserving first-delivery order and bucket identity.
- [ ] Dispatch tests cover duplicate IDs/targets, mutation, exceptions, and reentrancy.
- [ ] Shared rights-helper tests prove identical authorization for supplied and DB-fetched nodes.
- [ ] Non-paged visible-device counts are `1 + 2N`; paged counts remain `3N`.
- [ ] Plan 017 exact-once array-output tests still pass.
- [ ] Timing script exits 0 and three actual result rows are recorded.
- [ ] `npm test`, `npm run check`, and explicit script syntax checks exit 0.
- [ ] DB batching, reverse subscription indexing, and viewer-byte bounds are explicitly deferred, with no scaffolding or false completion claim.
- [ ] Only Scope paths changed; plan/index completion recorded.

## STOP conditions

- Plan 001 has not supplied `npm test`/`npm run check`, or Plan 017's detailed-list regression is absent/failing.
- Unexplained source drift changes authorization, callback output, or dispatch iteration semantics.
- Supplied-node and fetched-node authorization differ on any test; never trade access control for query savings.
- Listing documents lack `_id` or domain identity needed for validation, or reuse requires removing sanitization.
- An implementation requires changing DB backends, desktop queue behavior, public command schemas, or another out-of-scope source file.
- Verification fails twice after a reasonable fix attempt.
- Missing documentation or no live server is not a STOP condition. No timing speedup alone is not a STOP: report measurements honestly.

## Maintenance notes

Future batching can use `GetAllIdsOfType` only after backend output equivalence is demonstrated; it is available, not assumed missing. Do not cache supplied nodes across requests because permissions and records may change. The listing remains a snapshot rather than a transaction; reusing it removes a redundant read, not an authorization check.

`RemoveAllEventDispatch` still scans all buckets. A reverse index would add lifecycle synchronization across registration/removal and is deferred until teardown cost is measured. Viewer queues still lack a byte cap; a separate plan must disconnect over-budget slow viewers safely rather than dropping stateful packets. The present performance claim is limited to recipient deduplication and N fewer logical node reads per non-paged export.
