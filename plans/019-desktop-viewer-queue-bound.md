# Plan 019: Bound each desktop viewer's pending bytes without slowing healthy viewers

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before proceeding. Stop and report under the conditions below; do not improvise. Update this plan's status row in `plans/README.md` when finished, unless the dispatcher maintains the index.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshdesktopmultiplex.js meshcentral-config-schema.json test/desktopmultiplex-queue.test.js plans/019-desktop-viewer-queue-bound.md plans/README.md`
> Compare changed source against the excerpts below. Expected prerequisite changes from Plans 001, 017, and 018 are not unexplained drift: preserve them. Stop for incompatible changes, not merely changed line numbers or plan/index edits.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-test-baseline.md` and `plans/018-device-list-and-dispatch-perf.md`
- **Category**: perf
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Desktop controls can accumulate indefinitely for a viewer whose WebSocket stops draining. Desktop images also have a separate shared linked-list delivery path, so limiting only the array does not bound that viewer's pending work. Bound each viewer independently, discard images only when a proven full-screen replacement makes them obsolete, and disconnect viewers that still exceed the budget. Healthy viewers must keep receiving without an agent pause caused by one slow viewer.

## Current state

Paths and roles:

- `meshdesktopmultiplex.js`: private multiplexer factory, image retention, viewer queues, overflow counters, and exported authenticated relay wrapper.
- `meshcentral-config-schema.json`: configuration documentation and schema; the existing multiplex enable switch is server-level, not a domain object.
- `plans/001-test-baseline.md`: establishes native Node tests and maintained syntax commands.
- `plans/017-small-correctness-fixes.md`: owns the opposite-direction agent queue bug.
- `plans/018-device-list-and-dispatch-perf.md`: owns recipient deduplication and device-list work, explicitly excluding these queues.

Use CommonJS, Node >=20 (baseline recommends 20.19+), four-space JavaScript indentation, and single-quoted new strings. Preserve existing comments and schema indentation. The queue functions below are the local style exemplar.

Factory and initialization, `meshdesktopmultiplex.js:62-69,119-124,198-203`:

```javascript
function CreateDesktopMultiplexor(parent, domain, nodeid, id, func) {
    var obj = {};
    obj.id = id;                        // Unique identifier for this session
    obj.nodeid = nodeid;                // Remote device nodeid for this session
    obj.parent = parent;                // Parent web server instance
    obj.agent = null;                   // Reference to the connection object that is the agent.
    obj.viewers = [];                   // Array of references to all viewers.
    obj.viewersOverflowCount = 0;       // Number of viewers currently in overflow state.
```

```javascript
peer.lastImageNumberSent = null;
peer.dataPtr = obj.firstData;
peer.sending = false;
peer.overflow = false;
peer.sendQueue = [];
peer.paused = false;
```

```javascript
// Setup the agent
obj.agent = peer;
peer.sending = false;
peer.overflow = false;
peer.sendQueue = [];
peer.paused = false;
```

Opposite-direction bug, `meshdesktopmultiplex.js:376-380`:

```javascript
if (obj.agent.sending) {
    obj.agent.sendQueue.push(data);

    // Flow control, pause all viewers is the queue is backing up
    if (obj.agent.sendQueue > 10) {
```

Plan 017 Step 15 (`plans/017-small-correctness-fixes.md:304-308`) sets agent `sending = true` before direct send and uses `sendQueue.length > 10`. Preserve that fix and its `agent-flow` test. Do not change the agent queue's `shift()` here.

Unbounded viewer queue, `meshdesktopmultiplex.js:452-462`:

```javascript
obj.sendToViewer = function (viewer, data) {
    if ((viewer == null) || (obj.viewers == null)) return;
    //console.log('SendToViewer', data.length);
    if (viewer.sending) {
        viewer.sendQueue.push(data);
    } else {
        viewer.sending = true;
        if (viewer.slowRelay) {
            setTimeout(function () { try { viewer.ws.send(data, function () { sendViewerNext(viewer); }); } catch (ex) { } }, viewer.slowRelay);
        } else {
            try { viewer.ws.send(data, function () { sendViewerNext(viewer); }); } catch (ex) { }
```

Shared flow control, `meshdesktopmultiplex.js:471-477`:

```javascript
function checkViewerOverflow(viewer) {
    if ((viewer.overflow == true) || (obj.viewers == null)) return;
    if ((viewer.sendQueue.length > 5) || ((viewer.dataPtr != null) && (viewer.dataPtr != obj.lastData))) {
        viewer.overflow = true;
        obj.viewersOverflowCount++;
        if ((obj.viewersOverflowCount >= obj.viewers.length) && obj.agent && (obj.agent.paused == false)) { obj.agent.paused = true; obj.agent.ws._socket.pause(); }
    }
}
```

Drain, `meshdesktopmultiplex.js:493-499`:

```javascript
if (viewer.sendQueue.length > 0) {
    // Send from the pending send queue
    if (viewer.sending == false) { viewer.sending = true; }
    if (viewer.slowRelay) {
        setTimeout(function () { try { viewer.ws.send(viewer.sendQueue.shift(), function () { sendViewerNext(viewer); }); } catch (ex) { } }, viewer.slowRelay);
    } else {
        try { viewer.ws.send(viewer.sendQueue.shift(), function () { sendViewerNext(viewer); }); } catch (ex) { }
```

Images do NOT ordinarily enter that queue. `meshdesktopmultiplex.js:503-509`:

```javascript
if (viewer.dataPtr != null) {
    // Send the next image
    //if ((viewer.lastImageNumberSent != null) && ((viewer.lastImageNumberSent + 1) != (viewer.dataPtr))) { console.log('SVIEW-S1', viewer.lastImageNumberSent, viewer.dataPtr); } // DEBUG
    var image = obj.images[viewer.dataPtr];
    viewer.lastImageNumberSent = viewer.dataPtr;
    //if ((image.next != null) && ((viewer.dataPtr + 1) != image.next)) { console.log('SVIEW-S2', viewer.lastImageNumberSent, image.next); } // DEBUG
    viewer.dataPtr = image.next;
```

Frame classification, `meshdesktopmultiplex.js:678-686,700-708`:

```javascript
const jumboData = data;
var command = data.readUInt16BE(0);
var cmdsize = data.readUInt16BE(2);
//console.log('AgentData', data.length, command, cmdsize);
if ((command == 27) && (cmdsize == 8)) {
    // Jumbo packet
    if (data.length >= 12) {
        command = data.readUInt16BE(8);
        cmdsize = data.readUInt32BE(4);
```

```javascript
case 3: // Tile, check dimentions and store
    if ((data.length < 10) || (obj.lastData == null)) break;
    var x = data.readUInt16BE(4), y = data.readUInt16BE(6);
    var dimensions = require('image-size').imageSize(data.slice(8));
    var sx = (x / 16), sy = (y / 16), sw = (dimensions.width / 16), sh = (dimensions.height / 16);
    obj.counter++;

    // Keep a reference to this image & how many tiles it covers
    obj.images[obj.counter] = { next: null, prev: obj.lastData, data: jumboData };
```

The jumbo parser accepts padding and slices the logical body at lines 690-691. Classify the logical body, but count/send the original wire Buffer. Type 3 is a tile, NOT automatically a full frame. A safe full-screen replacement has x=y=0 and decoded width/height exactly equal to the current screen dimensions. Type 7 supplies screen size and resets shared history (`:754-780`); it is not image data. Type 4 is ignored (`:752-753`); do not implement copy frames here. Controls 11, 12, 17, 18, 65, 82, 87, 88 and console JSON use broadcast paths (`:785-824`, `:669-672`). Preserve controls, unknown queued messages, and strings; never treat a jumbo wrapper itself as proof of an image.

Shared image pruning already redirects viewer pointers, `meshdesktopmultiplex.js:733-734`:

```javascript
// If any viewers are currently on image "oi" must be moved to "d.next"
for (var l in obj.viewers) { const v = obj.viewers[l]; if (v.dataPtr == oi) { v.dataPtr = d.next; } }
```

Viewer removal deletes send state at `:303-314`; overflow-count decrement and conditional agent resume occur at `:248-252`. Preserve those semantics while clearing new byte/cursor/timer state. Recording has independent flow-control state at `:530-538`; do not remove recording safeguards.

There is no exported `CreateDesktopMultiplexor`. `meshdesktopmultiplex.js:963-970,985`:

```javascript
parent.db.Get(nodeid, function (err, nodes) {
    if ((err != null) || (nodes.length != 1)) { func(null); return; }
    obj.meshid = nodes[0].meshid;
    obj.icon = nodes[0].icon;
    obj.name = nodes[0].name;
    recordingSetup(domain, function () { func(obj); });
});
return obj;
```

```javascript
module.exports.CreateMeshRelay = function (parent, ws, req, domain, user, cookie) {
```

That wrapper does not return the inner relay, and starts authentication/routing machinery. Do not pretend `require(...).CreateMeshRelay(...)` returns this multiplexer. Use a test-only VM evaluation of the actual source to obtain the private factory, as specified below; do not add a production export.

Schema evidence, `meshcentral-config-schema.json:715-718`:

```json
"desktopMultiplex": {
  "type": "boolean",
  "default": false,
  "description": "When true, enabled a server modules that efficiently splits a remote desktop stream to multiple browsers. Also allows slow browsers to not slow down the session for fast ones, this comes at the cost of extra server memory and processing for all remote desktop sessions."
```

The domain insertion point is `meshcentral-config-schema.json:1340-1345`:

```json
"domains": {
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "properties": {
      "dns": {
```

No domain multiplex settings object currently exists. Add one there; do not convert the existing server boolean into an object.

Dependency boundary, `plans/018-device-list-and-dispatch-perf.md:214-218`:

> No queue code changes in this plan. The evidence shows a real unbounded-byte risk, but a drop-oldest/drop-newest policy can corrupt delta-encoded desktop state.
>
> It must count UTF-8 string bytes/Buffer bytes, decrement accounting on drain, clear it on disconnect, and preserve other viewers.

This plan implements that deferred bound. Coalescing is allowed only with proof of image supersession, not arbitrary packet dropping. Plan 001 (`plans/001-test-baseline.md:162`) supplies `scripts.test = "node --test test/"`; its lines 125-129 distinguish future npm gates from commands present at the planning commit. No implementation checks were run while drafting this plan.

## Commands you will need

Run from the repository root.

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime | `node --version` | Node 20.19+ |
| Focused tests | `node --test test/desktopmultiplex-queue.test.js` | All queue tests pass; process exits naturally |
| Opposite-direction regression | `node --test --test-name-pattern=agent-flow test/small-correctness.test.js` | Existing Plan 017 test passes |
| Syntax | `node -c meshdesktopmultiplex.js` | Exit 0 |
| Parse schema | `node -e "JSON.parse(require('node:fs').readFileSync('meshcentral-config-schema.json','utf8'))"` | Exit 0 |
| Full tests, after 001 | `npm test` | All tests pass |
| Maintained checks, after 001 | `npm run check` | Exit 0 |
| Change boundary | `git diff --name-only` | Only Scope paths from this work |

Do not install dependencies or start a server as part of these instructions. Report missing prerequisites rather than changing dependency versions.

## Scope

**In scope** (only files to modify):

- `meshdesktopmultiplex.js`
- `meshcentral-config-schema.json`
- `test/desktopmultiplex-queue.test.js` (create)
- `plans/019-desktop-viewer-queue-bound.md` (completion evidence and policy documentation)
- `plans/README.md` (status row only, unless dispatcher owns it)

**Out of scope**:

- Agent-bound queue behavior owned by Plan 017.
- Dispatch/device-list changes owned by Plan 018; do not modify its plan or implementation.
- Protocol changes, new image codecs, refresh requests that affect healthy viewers, global shared-image cache eviction, recording policy, authentication, and public relay APIs.
- Dependency additions, real credentials, services, deployment, or broad formatting.

## Git workflow

- Branch: `advisor/019-desktop-viewer-queue-bound`.
- Preserve unrelated work; do not reset or clean the checkout.
- Commit logical units using the observed `fix:` style, for example `fix: bound desktop viewer pending bytes`. Existing history includes `fix: size the agent-to-Assistant IPC frame in UTF-8 bytes (#8331)`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Build the real-factory fixture and characterize both delivery paths

Create the test file using `node:test`, `node:assert/strict`, `node:fs`, `node:vm`, and `node:module`. Read the actual module source with an absolute path resolved from `__dirname`. Evaluate it once per fixture in a VM context containing `module: { exports: {} }`, `exports`, `Buffer`, `console`, `Date`, module-relative `require` from `createRequire`, and controlled `setTimeout`/`clearTimeout`. Retrieve `CreateDesktopMultiplexor` by evaluating that identifier in the same context. Assert it is a function and assert the exported `CreateMeshRelay` is present. Do not copy or reimplement production functions.

Construct it with `(parent, domain, 'node/test/device', 'test-session', readyCallback)`. Capture the object from `readyCallback`, not an assignment assuming asynchronous construction. Required fake fields:

- `parent.trafficStats.desktopMultiplex = { sessions: 0 }`.
- `parent.db.Get(id, cb)` synchronously calls `cb(null, [{ _id: id, meshid: 'mesh/test/group', icon: 1, name: 'fixture' }])`.
- `parent.users = {}`, `parent.wsagents = {}`, `parent.meshes = {}`, `parent.userGroups = {}`.
- `parent.parent.debug(category, message)` and `parent.parent.DispatchEvent(targets, source, event)` capture calls.
- `domain = { id: 'test', sessionrecording: false, desktopmultiplex: { maxviewerqueuebytes: 4096 } }`. Omit the object for default tests.
- Each viewer peer: `req: { query: { browser: 1 } }`, `user: { _id: 'user/test/healthy' or 'user/test/slow', name: 'fixture' }`, `viewOnly: false`, `ws`, and idempotent `close()`.
- Each fake `ws`: `send(data, cb)` captures data and callbacks, `bufferedAmount: 0`, `_socket: { bytesRead: 0, bytesWritten: 0, pause(), resume() }`. Count pause/resume calls. `close()` on the peer marks closed and invokes `multiplexer.removePeer(peer)` exactly once; do not recursively emit close.
- Agent peer: same socket shape and close behavior, `req: { query: {} }`; no user is needed.

Add viewers before agent to avoid joining-event assumptions about absent users. Let initial `c` and metadata sends drain before switching the slow viewer to held callbacks. Healthy sends use an explicit callback pump, avoiding a synchronous-recursion-only fixture; also include a synchronous callback variant. No real filesystem recording, DB, authentication, EventEmitter transport, or network is needed for this private factory path: recording false short-circuits at `:833` and `:865-883`.

Characterize controls sent through `processAgentData` and images through type 7 followed by valid type 3 image data. Embed a small valid PNG Buffer in the test; use the real installed `image-size`, not a mock dimension oracle. Build padded jumbo packets from that fixture. Add baseline teardown and FIFO cases that pass before the policy changes.

**Verify**: `node --test test/desktopmultiplex-queue.test.js` → baseline fixture, FIFO, image parsing, and teardown tests pass without a live server.

### Step 2: Define the configuration and exact byte invariant

Add `desktopMultiplex` as an object under `domains.additionalProperties.properties`. Add its `maxViewerQueueBytes` integer property, minimum 1, default 8388608. Document bytes, per-viewer scope, safe coalescing followed by disconnect, and that server-level `settings.desktopMultiplex` still controls enablement. Runtime reads the normalized `domain.desktopmultiplex.maxviewerqueuebytes`. Read it once per multiplexer; accept only positive safe integers, otherwise use 8388608. Do not rely on a JSON Schema default to initialize runtime state. No separate disable/unlimited mode.

Initialize `viewer.pendingBytes = 0`, a queue cursor, and explicit in-flight byte state. The invariant is: pendingBytes counts unsent queue entries, unsent linked-list image/screen-size entries reachable by this viewer, and the one in-flight or delayed-send payload. Strings use `Buffer.byteLength(data, 'utf8')`; Buffers use `data.length`. Account each original wire payload once. Queued-to-in-flight transfer does not change the total; successful send callback subtracts in-flight bytes. Dropping superseded pending images subtracts their bytes. Disconnect clears everything.

Use `Math.max(viewer.pendingBytes, viewer.ws.bufferedAmount || 0)` for the admission-pressure comparison, not their sum: transport bytes and in-flight payloads can overlap. Test this separately; a non-draining socket's first in-flight message must remain accounted. The hard limit applies to retained per-viewer pending work after every public operation. Reject an oversized incoming payload before retaining it; close and clear rather than briefly leaving a giant queued allocation. The already received agent Buffer and shared desktop snapshot are not a new per-viewer allocation.

Record wire byte length on shared image entries when created. Maintain viewer linked-backlog bytes as existing image append/prune/pointer-reset operations occur: append adds bytes to every active viewer that will receive the entry; pruning subtracts only when that viewer has not passed the entry; dequeue subtracts from linked backlog while transferring to in-flight; refresh and screen reset recompute the replaced backlog. Use current linked-list pointer/monotonic image indices to establish unsent membership. Never decrement in-flight bytes when a shared entry is pruned. A full traversal on initialization, refresh, or overflow coalescing is acceptable; do not scan the whole history on every ordinary send. No per-viewer image Buffer copies or full duplicate linked lists.

**Verify**: `node --test test/desktopmultiplex-queue.test.js` → added configuration, UTF-8, Buffer, in-flight, append/prune/reset accounting tests pass. `node -c meshdesktopmultiplex.js` and the schema parse command → exit 0.

### Step 3: Bound admission and coalesce only independently replaceable images

Implement one private admission/coalescing path used before direct viewer sends and queue admission, and after image-backlog changes. Run it even when `viewer.sending` is true; the current overflow check only on sending is insufficient. Keep controls in FIFO order.

Reuse parsed image coordinates/dimensions from `processAgentData`, adding full-screen metadata to shared entries instead of decoding each image per viewer. A full-screen candidate must be type 3 at (0,0), exactly match the current type-7 dimensions, and belong to the same screen-size generation. Jumbo envelopes are unwrapped for classification only. Invalid/unknown data is non-droppable. Do not change malformed-frame handling as a side task.

On attempted overflow, find the newest unsent proven full-screen replacement. Retain that replacement and all images after it. Remove only older pending image payloads superseded by it; retain every non-image control, including the applicable screen-size command, in its existing relative order. Never discard an in-flight/delayed payload. Never jump `dataPtr` straight to `lastData`: that might be one tile rather than a complete screen. If screen-size precedes the replacement, send that control before resuming at the replacement; use explicit per-viewer resume state, not a mutation of the shared list for one viewer. If no proven full-screen replacement exists, keep the images and proceed to the close decision. Existing global pruning may already have removed obsolete tiles; accounting must not subtract them twice.

Recompute pressure after safe coalescing. If it still exceeds the cap, mark this viewer closing first, capture a single `parent.parent.debug('relay', ...)` reason containing `DesktopRelay: viewer queue byte limit exceeded`, pending bytes, and limit, then call `viewer.close()` exactly once. Do not log payloads, cookies, or tokens. A close releases controls as connection teardown, not as silent coalescing. Guard reentrant metadata broadcasts during removal; clear timers, queue references, linked pointer state, and byte counts even if transport callbacks arrive late.

A viewer may close during `sendToAllViewers`, `sendToAllInputViewers`, or image iteration. Iterate safely without skipping the next healthy viewer when removal splices `obj.viewers`. Avoid an unconditional per-frame array copy: use an index that advances only if the current element remains, or equivalent mutation-safe traversal. Retain the existing all-viewers-overflow policy and recording exception; one slow viewer with one healthy viewer must never cause `_socket.pause()` on the agent. Overflow counters must not underflow or outlive removal.

**Verify**: `node --test test/desktopmultiplex-queue.test.js` → safe full-frame coalescing, control preservation, cap close, jumbo, resize, removal-during-broadcast, and two-viewer isolation cases pass.

### Step 4: Drain viewer queues with a cursor and safe callbacks

Replace viewer queue `shift()` calls with indexed reads. Clear the consumed slot immediately so it does not retain a Buffer. Reset array and cursor when empty; compact a consumed prefix only after it is substantial (for example at least 64 entries and half the array), not on every send. Use active length `sendQueue.length - sendQueueHead` in both overflow and underflow checks. Leave the agent queue untouched.

Select and account one payload before scheduling `slowRelay`; store/cancel its timer. The timer callback and send callback must reject removed/closing viewers. Preserve exactly one send in flight, FIFO controls, and existing priority between control queue and linked image delivery. Route thrown send errors and callback errors through idempotent viewer cleanup rather than leaving accounted bytes and `sending` stuck forever. Callbacks after close must not send another frame, subtract twice, or recreate deleted fields. Do not allow unbounded consumed empty slots to remain in a long-lived queue.

**Verify**: `node --test test/desktopmultiplex-queue.test.js` → cursor FIFO, repeated partial drains, timer cancellation, send throw/error, callback-after-close, and synchronous callback tests pass. `node --test --test-name-pattern=agent-flow test/small-correctness.test.js` → existing opposite-direction regression passes.

### Step 5: Run final gates and document the policy

Run the focused and repository commands. Record exact commands, results, chosen default, accounting definition, and deterministic fixture payload sizes here. Update the index row only if delegated ownership permits it. The schema description plus this plan are the configuration/policy documentation; no extra documentation file is needed.

**Verify**: `node --test test/desktopmultiplex-queue.test.js && npm test && npm run check` → exit 0. `git diff --name-only` → this work changes only Scope paths. If no live server/agent is available, report the optional real-session check as not run; that is not a STOP condition.

## Test plan

Use Plan 001's native `node:test`/assert style (`plans/001-test-baseline.md:158-164`). Tests must execute the actual factory; a copied queue implementation or test-only production export is not acceptable. At least these named top-level groups must exist:

1. `viewer-config`: default 8388608, override 4096, invalid zero/negative/fraction/string/unsafe integer fallback; schema object/default/minimum assertions.
2. `viewer-bytes`: exact boundary accepted, one byte over rejected; UTF-8 non-ASCII strings; Buffers; held in-flight bytes; zero double-counting with bufferedAmount; oversized first payload; accounting equals independently summed active entries plus in-flight and linked backlog after each operation.
3. `viewer-isolation`: two viewers and an agent. After initial handshake drains, slow socket never invokes another send callback and exposes high bufferedAmount. Send repeated type-17 controls through the real agent path. Assert slow retained bytes never exceed cap after a call, it closes exactly once with the reason, healthy viewer receives every admitted control, and agent pause count stays zero. Test slow viewer first and last in the viewer array. Include a separate accumulating-queue variant with bufferedAmount zero so a high transport value does not hide the queue bug.
4. `viewer-coalescing`: valid PNG tiles/full-screen frames and padded jumbo frames; keep newest proven full frame and later tiles, preserve control FIFO, and close rather than dropping required deltas without a full frame. Type 7 alone is not a replacement. Test resize generations, refresh, shared pruning and pointer advancement, and control-only overflow. A full frame larger than cap must close, not bypass the limit.
5. `viewer-cursor`: enough entries and drain cycles to exercise compaction, no viewer-side shift, bounded physical array growth, released consumed references, exact byte decrement, and FIFO order.
6. `viewer-lifecycle`: callback and thrown send errors, disconnect with pending callback, controlled slowRelay timer, callback after close, last-viewer disposal, and overflow-count cleanup. Confirm recording-related resume guards are preserved without requiring recording files.

Use deterministic callback pumping, not sleeps or timing thresholds. Measure application-retained byte sums rather than noisy process RSS. Optional real-session smoke: one fast browser and one throttled browser should show uninterrupted fast updates and a logged slow-viewer disconnect. Report this as not run when no server or agent exists.

## Done criteria

- [ ] Domain schema exposes the object and byte limit; the server boolean remains unchanged.
- [ ] Runtime default is exactly 8388608 bytes; invalid values fall back safely.
- [ ] All six test groups exist and pass through `node --test test/desktopmultiplex-queue.test.js`.
- [ ] Tests prove pending bytes remain within cap after each operation or are cleared on viewer close.
- [ ] Controls survive coalescing, partial frames are not discarded without a proven replacement, and jumbo wire bytes are counted.
- [ ] Held sends, shared linked image backlog, refresh, pruning, resize, and delayed sends are accounted without double-counting.
- [ ] Healthy viewer delivery continues and agent pause count remains zero in isolation tests.
- [ ] Viewer drain uses a cursor; agent queue behavior and Plan 017 regression remain intact.
- [ ] `npm test`, `npm run check`, and schema parse exit 0.
- [ ] Only Scope paths changed; completion evidence and the index row are updated or handed to the index owner.

## STOP conditions

Stop and report if:

- Plans 001 and 018 are not complete, or their required baseline/Plan 017 regression is missing. Do not recreate their work here.
- Drift changes frame semantics, factory initialization, or queue ownership incompatibly with these excerpts.
- Full-screen independence cannot be established from type-3 position, decoded dimensions, and screen generation. Do not substitute arbitrary oldest-packet dropping.
- Required control ordering across resize/full-screen replacement cannot be preserved with the existing protocol. Report the exact failing fixture before broadening the design.
- The implementation needs out-of-scope protocol, authentication, codec, or global-cache changes to pass its tests.
- A verification gate fails twice after a reasonable targeted fix, or the installed image-size API cannot parse the valid fixture. Report the precise command and failure; do not replace real parsing with a fake.

Missing live servers or agents is never a STOP condition. Report optional integration checks as not run.

## Maintenance notes

Review the interaction among queue admission, linked image pruning, pointer resets, byte transfer to in-flight state, and close callbacks together. Adding a new image command requires proving its replacement semantics before it becomes droppable. Unknown controls remain non-droppable.

The 8 MiB default is an explicit initial policy, not a measured universal optimum. Large independent full-screen images may cause disconnects; administrators can raise the domain limit. Record representative frame sizes when live measurement is available without changing the default opportunistically.

This bounds each viewer's outstanding delivery obligation, not the process's total memory or the shared current-desktop image cache. Do not claim a global memory ceiling. Future cache budgets must preserve screen reconstruction and recording semantics separately. Dispatch optimization, backend batching, and agent-bound flow fixes remain owned by their existing plans.
