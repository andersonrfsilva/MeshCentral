# Plan 017: Fix sixteen isolated callback, lookup, and state errors

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshuser.js apprelays.js amtprovisioningserver.js webserver.js amtmanager.js meshipkvm.js meshdevicefile.js meshmail.js meshdesktopmultiplex.js test/small-correctness.test.js plans/017-small-correctness-fixes.md plans/README.md`
> Compare changed source with the excerpts below. Unexplained source mismatch is a STOP condition. Changes from completed plans outside the named functions do not authorize unrelated edits; reconcile them first. Plan/index text changes are not source drift.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 001 (test harness)
- **Category**: bug
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

These small mistakes cause failed custom-core uploads, dropped network bytes, wrong-account callbacks, broken paged exports, and unbounded work from missing state transitions. Each fix is localized, but asynchronous behavior needs focused regression tests. Keep this a sequence of independent corrections, not a rewrite of the large server modules.

## Current state

Repository root: `/home/anderson/Desenvolvimento/oss/meshcentral`. `package.json:58-60` requires Node >=20. Baseline has no scripts/tests/lint; Plan 001 adds `npm test`, `npm run check`, and `test/helpers/fake-parent.js`.

The exact evidence for each site appears directly in its step, with original `file:line` markers. Those excerpts are the drift baseline. Roles: `meshuser.js` handles user commands and detailed device export; `webserver.js` handles email/reset/restore HTTP flows and DNS web relays; `apprelays.js` frames proxied HTTP bodies; `amtprovisioningserver.js` accumulates TCP input; `amtmanager.js` chooses AMT ports; `meshipkvm.js` parses appliance URLs; `meshdevicefile.js` receives file-transfer control messages; `meshmail.js` drains queued mail; `meshdesktopmultiplex.js` queues desktop traffic.

Follow CommonJS, callbacks, four-space indentation, and single-quoted new server strings. Existing callback exemplar: `meshuser.js:3722` uses `fs.readFile(file.fullpath, 'utf8', function (err, data) {`. Preserve that style and current error handling. The account count contract is independently confirmed at `db.js:2936`:

```javascript
if (max == null) { func(false); } else { obj.file.countDocuments({ type: type, domain: domainid }, function (err, count) { func((err != null) || (count > max), count); }); }
```

The SQL and AceBase implementations likewise compare `> max` (`db.js:1796,2058`). `db.js` is read-only for this plan.

## Commands you will need

Run commands from the repository root; no install is needed.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const s=require('./package.json').scripts; if(!s || !s.test || !s.check) process.exit(1)"` | Exit 0; otherwise STOP for Plan 001 |
| Focused regression | `node --test --test-name-pattern=SITE test/small-correctness.test.js` | Named test passes; SITE is the literal step tag below |
| All new regressions | `node --test test/small-correctness.test.js` | All sixteen top-level cases pass |
| Syntax | `npm run check` | Exit 0 |
| Full suite | `npm test` | All pass |
| Scope | `git diff --name-only` | Only Scope paths |

## Scope

**In scope** (only files to modify):
- `meshuser.js`
- `apprelays.js`
- `amtprovisioningserver.js`
- `webserver.js`
- `amtmanager.js`
- `meshipkvm.js`
- `meshdevicefile.js`
- `meshmail.js`
- `meshdesktopmultiplex.js`
- `test/small-correctness.test.js` (create)
- `plans/017-small-correctness-fixes.md`
- `plans/README.md`

**Out of scope**:
- Database backend implementation, batching, dispatcher optimization, viewer-facing queue limits, TLS policy, other account policy, and unrelated findings in these large modules.
- Dependencies, public exports solely for tests, formatter churn, and changes to transport formats beyond correcting the existing chunk framing.

## Git workflow

- Branch: `advisor/017-small-correctness-fixes`.
- Make independent logical commits, for example `fix: retain fragmented AMT provisioning input` or `fix: initialize paged device detail state`.
- Preserve unrelated work. Do not push or open a PR without instruction.
- Complete this plan before Plan 018; that plan changes device-detail call counts and must preserve these completion tests.

## Steps

Before Step 1, create `test/small-correctness.test.js` using `node:test` and `node:assert/strict`. Add one top-level test named with each exact SITE tag below. Follow Plan 001's fake-parent setup; extend fakes locally, not production exports. Prefer invoking exported factories with fake sockets, DB, mail, and timer dependencies. For inaccessible nested functions, load the exact production function/body with `node:vm` and explicitly injected bindings; assert extraction markers exist and include the entire function being tested. Never copy a corrected implementation into a test. Restore any require/module mocks and timers in teardown. Each step adds its own regression before its edit.

### Step 1: Send custom cores only after a successful read

Current state — `meshuser.js:3722-3726`:

```javascript
fs.readFile(file.fullpath, 'utf8', function (err, data) {
    if (err != null) {
        data = common.IntToStr(0) + data; // Add the 4 bytes encoding type & flags (Set to 0 for raw)
        parent.sendMeshAgentCore(user, domain, node._id, 'custom', data);
```

**Exact change**: Change only the read-success guard to `err == null`. Keep the four-byte prefix and existing path/rights validation. A read error must not send undefined data.

**Regression** (`custom-core`): Stub readFile with success and error callbacks. Success sends one prefixed custom core; error sends none.

**Verify**: `node --test --test-name-pattern=custom-core test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 2: Initialize detailed-list state for both branches and finish once

Current state — `meshuser.js:8765,8810-8813,8838-8842`:

```javascript
var results = [], resultPendingCount = 0;
// In the separate paged branch:
for (var id in obj.visibleDevices) {
    // Fetch the node from the database
    resultPendingCount++;
```

**Exact change**: Move result-array and pending-counter declarations into `getAllDeviceDetailedInfo`, before its paging branch. Initialize pending count from the complete work list before starting callbacks in EACH branch; do not increment while scheduling callbacks. The paged IDs are `Object.keys(obj.visibleDevices)`. Empty work lists call `func([], type)` exactly once. Give each node one completion path: absent/invisible nodes decrement and finish; successful nested net-info callbacks push then decrement and finish. Delete the trailing duplicate completion checks that currently use `results.join('\r\n')`. Always return an array, including all-invisible cases. Keep rights checks, `cleanDevice`, `CloneSafeNode`, and per-node si/if reads; performance changes belong to Plan 018.

**Regression** (`device-details`): Exercise non-paged and paged paths with zero, one, and two nodes; synchronous and delayed DB callbacks; all-invisible and mixed-visible nodes; missing sys/net records. Assert callback count exactly one, array result, unchanged type, and no ReferenceError.

**Verify**: `node --test --test-name-pattern=device-details test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 3: Send one complete HTTP chunk buffer

Current state — `apprelays.js:307`:

```javascript
req.on('data', function (data) { send(Buffer.concat([Buffer.from(data.length.toString(16) + '\r\n', 'binary'), data, send(Buffer.from('\r\n', 'binary'))])); });
```

**Exact change**: Replace the inner `send(Buffer.from('\r\n', 'binary'))` array member with `Buffer.from('\r\n', 'binary')`. Keep the outer send and final `0\r\n\r\n` end frame unchanged.

**Regression** (`chunk-frame`): Feed binary data through the registered request data callback. Assert one send per chunk, exact hexadecimal byte length, original bytes, CRLF trailer, and correct end frame.

**Verify**: `node --test --test-name-pattern=chunk-frame test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 4: Retain appended provisioning bytes

Current state — `amtprovisioningserver.js:42`:

```javascript
if (this.data == null) { this.data = data; } else { Buffer.concat([this.data, data]); }
```

**Exact change**: Assign the concatenation result: `this.data = Buffer.concat([this.data, data]);`. Keep the existing 16000-byte guard and close processing unchanged.

**Regression** (`hello-buffer`): Deliver an HTTP header in two and three pieces, including a split CRLF terminator. Assert accumulated bytes match concatenated input and one response is produced; exercise the size guard.

**Verify**: `node --test --test-name-pattern=hello-buffer test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 5: Use an index for email conflict lookup

Current state — `webserver.js:2229`:

```javascript
if ((err != null) || ((docs.length > 0) && (docs.find(function (u) { return (u._id === req.session.cuserid); }) < 0))) {
```

**Exact change**: Replace only `docs.find` with `docs.findIndex` at this site. Preserve the predicate, existing error branch, and existing conflict policy; do not redesign duplicate-email policy.

**Regression** (`email-request`): Test empty docs, current account present, different account only, and DB error. Only different-account-only and DB-error cases take the existing rejection branch.

**Verify**: `node --test --test-name-pattern=email-request test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 6: Use an index in email verification lookup

Current state — `webserver.js:2290`:

```javascript
if ((docs.length > 0) && (docs.find(function (u) { return (u._id === user._id); }) < 0)) {
```

**Exact change**: Replace only `docs.find` with `docs.findIndex` here too. Keep the existing verification response and ID predicate.

**Regression** (`email-verification`): Test empty docs, current user present, and another user only. Another-user-only must reject verification; current-user presence preserves the existing behavior.

**Verify**: `node --test --test-name-pattern=email-verification test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 7: Capture each reset account and index

Current state — `webserver.js:2088-2095,2140-2145`:

```javascript
var responseSent = false;
for (var i in docs) {
    var user = obj.users[docs[i]._id] || docs[i]; // Use the cached user, the login path checks that copy for used codes
```

**Exact change**: Use `for (let i in docs)` and `const user` for this loop. Preserve the existing cached-user preference and first-account response policy (`i == 0`). Both index AND user must be per iteration; fixing only one leaves a wrong-account callback. Do not change reset authorization or mail policy.

**Regression** (`reset-closure`): Hold two 2FA callbacks, then release them in reverse order. Verify each uses its own user for mail/2FA updates, only index zero responds, and both eligible reset emails are sent. Test first-account failure with later-account success too.

**Verify**: `node --test --test-name-pattern=reset-closure test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 8: Test AMT port membership explicitly

Current state — `amtmanager.js:614-615`:

```javascript
if (ciraconn.tag.boundPorts.indexOf('16992')) { dotls = 0; }
else if (ciraconn.tag.boundPorts.indexOf('16993')) { dotls = 1; }
```

**Exact change**: Compare both `indexOf` results with `>= 0`. Preserve preference for 16992 inside the existing authenticated CIRA tunnel and the no-port removal path.

**Regression** (`amt-port`): Test empty ports, 16992 at index zero, 16993 at index zero, both ports, and unrelated ports. Assert mode 0, mode 1, or removal as appropriate.

**Verify**: `node --test --test-name-pattern=amt-port test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 9: Read the WHATWG URL pathname

Current state — `meshipkvm.js:265-280`:

```javascript
const q = new URL(url, 'http://localhost');
const i = q.pathname.indexOf('/ipkvm.ashx/');
```

**Exact change**: In the returned object at line 280, change `preurl: q.path.substring(0, i + 76)` to `preurl: q.pathname.substring(0, i + 76)`. Keep the existing offset and node-ID checks. WHATWG URL has pathname, not path.

**Regression** (`kvm-path`): Test root-domain and domain-prefixed routes with a valid 64-character node ID and a query string. Assert correct preurl, unchanged relurl, no query in preurl, and null for an unknown port or malformed ID.

**Verify**: `node --test --test-name-pattern=kvm-path test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 10: Guard parsed file commands before dereferencing

Current state — `meshdevicefile.js:219-222`:

```javascript
var cmd = null;
try { cmd = JSON.parse(data); } catch (ex) { }
if ((cmd == null) || (typeof cmd.op == 'string')) {
    if (cmd.op == 'ok') {
```

**Exact change**: Change the entry guard to `(cmd != null) && (typeof cmd.op == 'string')`. Preserve the existing ignore behavior for invalid commands and 401 for recognized non-ok operations. Do not dereference null after parse failure.

**Regression** (`file-command`): Deliver malformed JSON, JSON null, empty object, string primitive, ok with size, and another string op. Assert no throw for malformed inputs, headers for ok, and 401 for the other op.

**Verify**: `node --test --test-name-pattern=file-command test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 11: Use the resolved restore identity

Current state — `webserver.js:6305-6319`:

```javascript
var authUserid = null;
if ((req.session != null) && (typeof req.session.userid == 'string')) { authUserid = req.session.userid; }
```

**Exact change**: Change only `const user = obj.users[req.session.userid]` after `if (authUserid == null)` to `const user = obj.users[authUserid]`. Preserve cookie verification, domain binding, expiry, and the restore-rights bit check. A valid form cookie can intentionally provide identity without req.session.

**Regression** (`restore-user`): Test valid authorized form cookie with no session, valid session alone, invalid/expired cookie without session, wrong-domain cookie, and authenticated user without restore rights. Only authorized identities proceed.

**Verify**: `node --test --test-name-pattern=restore-user test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 12: Log the SendGrid rejection variable

Current state — `meshmail.js:493,502-503`:

```javascript
parent.debug('email', 'SendGrid server failed (Skipping): ' + safeStringify(err));
console.log('SendGrid server failed (Skipping): ' + safeStringify(err));
```

**Exact change**: The containing rejection callback argument is `error`. Replace `err` with `error` in both exhaustion logs. Preserve the three-attempt limit, queue shift, retry reset, and next-mail dispatch.

**Regression** (`mail-error`): Reject the SendGrid promise three times with fake timers. Assert no ReferenceError, one skipped mail, retry resets to zero, and the next pending message is attempted.

**Verify**: `node --test --test-name-pattern=mail-error test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 13: Subtract batch size from the account-count threshold

Current state — `meshuser.js:6572; db.js:2934-2938`:

```javascript
db.isMaxType(domain.limits.maxuseraccounts + userCount, 'user', domain.id, function (maxExceed) {
```

**Exact change**: Read the configured maximum into a local value and pass `max == null ? null : max - userCount` to `db.isMaxType`. Its implementation reports `count > max`, not `>=`; therefore this threshold rejects exactly when existing count plus requested count exceeds the configured maximum. Preserve unlimited null/undefined semantics; do not pass NaN. Keep existing rejection notification and batch loop. This is not an atomic reservation or a concurrency fix.

**Regression** (`batch-limit`): For limit 10, test existing/requested counts 8/2 (allow), 9/2 (reject), 10/1 (reject), 0/11 (reject), and 0/0 (allow); null/undefined limits remain unlimited. Assert threshold passed to the fake database, not a duplicated formula only.

**Verify**: `node --test --test-name-pattern=batch-limit test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 14: Update the newly created user instead of undeclared variables

Current state — `meshuser.js:6476-6477`:

```javascript
if ((command.consent != null) && (typeof command.consent == 'number')) { if (command.consent == 0) { delete chguser.consent; } else { newuser.consent = command.consent; } change = 1; }
if ((command.phone != null) && (typeof command.phone == 'string') && ((command.phone == '') || isPhoneNumber(command.phone))) { if (command.phone == '') { delete newuser.phone; } else { newuser.phone = command.phone; } change = 1; }
```

**Exact change**: Replace `delete chguser.consent` with `delete newuser.consent`. Remove both `change = 1` assignments from these two new-account lines; this handler always persists newuser and has no change accumulator. Do not add dummy declarations. Preserve type/phone validation.

**Regression** (`new-user-fields`): Create users with zero/nonzero consent and empty/valid phone. Assert persistence targets newuser, omitted fields stay absent, no ReferenceError occurs, and no change/chguser globals appear.

**Verify**: `node --test --test-name-pattern=new-user-fields test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 15: Track in-flight agent sends and queue length

Current state — `meshdesktopmultiplex.js:373-400`:

```javascript
if (obj.agent.sending) {
    obj.agent.sendQueue.push(data);

    // Flow control, pause all viewers is the queue is backing up
    if (obj.agent.sendQueue > 10) {
```

**Exact change**: Set `obj.agent.sending = true` immediately before the first direct `obj.agent.ws.send(data, sendAgentNext)` in the else branch. Replace `obj.agent.sendQueue > 10` with `obj.agent.sendQueue.length > 10`. Keep sending true while queued sends drain; the existing line 400 sets it false only when empty. Preserve pause/resume behavior and disconnect guards. This is the viewer-to-agent queue, not the separate agent-to-viewer queue deferred in Plan 018.

**Regression** (`agent-flow`): Hold a fake send callback. Send 12 more messages: one in-flight send, 12 queued, viewers paused once when queue length exceeds 10. Release callbacks sequentially; assert FIFO, sending false after drain, and one resume per paused viewer. Disconnect during a pending callback and assert the existing guard prevents access to disposed state.

**Verify**: `node --test --test-name-pattern=agent-flow test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 16: Use the DNS web-relay cleanup timer consistently

Current state — `webserver.js:8321,8328`:

```javascript
if ((Object.keys(webRelaySessions).length == 0) && (obj.cleanupTimer != null)) { clearInterval(webRelayCleanupTimer); obj.cleanupTimer = null; }
if (obj.cleanupTimer == null) { webRelayCleanupTimer = setInterval(checkWebRelaySessionsTimeout, 10000); }
```

**Exact change**: At these DNS relay sites, test `webRelayCleanupTimer`, clear that handle, and set `webRelayCleanupTimer = null`. Do not overwrite or rename unrelated obj.cleanupTimer uses. Keep the existing 10000 ms interval and expiry function.

**Regression** (`relay-timer`): Open two fake relay sessions: assert one interval. Close one: no clear. Close last: clear exactly the created handle and reset it. Open a new session: exactly one new interval.

**Verify**: `node --test --test-name-pattern=relay-timer test/small-correctness.test.js` → named case and its subcases pass. `npm run check` → exit 0.

### Step 17: Run the combined gates and record completion

Run all focused cases together to detect shared mock or timer leaks, then the full suite. Record changed sites and results in this plan; update the index status. If the index is absent, record completion here for the owner; do not stop or create unrelated documentation. No live server is needed for these unit regressions.

**Verify**: `node --test test/small-correctness.test.js && npm test && npm run check` → exit 0, sixteen named cases pass. `git diff --name-only` → only Scope paths.

## Test plan

The sixteen SITE cases above are mandatory, not alternatives. Use asynchronous scheduling controls rather than real sleeps. In particular, detailed-list completion and reset-account tests must run callbacks in both synchronous and reverse-order asynchronous modes. Timer and socket tests must assert counts and actual Buffer bytes, not source strings alone. For other isolated expressions, execute the production expression/body in the VM; a duplicated truth table implementation does not prove the fix.

No production database, real mail provider, external agent, or live TLS server is required. Preserve Plan 001's baseline tests. Focused command: `node --test test/small-correctness.test.js`; all sixteen top-level named cases and all stated subcases must pass.

## Done criteria

- [ ] All sixteen sites have the exact bounded changes and stated regressions.
- [ ] `node --test test/small-correctness.test.js` passes sixteen named cases.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] Detailed-device callbacks run once with array output on both branches, including empty results.
- [ ] Reset callbacks retain each account/index; restore resolves the verified authUserid.
- [ ] AMT input chunks are retained; HTTP chunks have one length header and trailer.
- [ ] Agent-bound send state and DNS cleanup timer return to their idle state after drain/last close.
- [ ] No shared DB contract, public response shape, or unrelated source changed.
- [ ] Only Scope paths changed; plan/index completion recorded.

## STOP conditions

- Plan 001 is missing or `npm test`/`npm run check` are unavailable.
- A named source excerpt has unexplained drift. Reconcile a preceding plan's documented edits; do not revert them to match an old line number.
- `db.isMaxType` no longer means `count > max`, or the detailed-device consumer requires a non-array response; report the contract change instead of guessing.
- A callback completion or permission fix requires changing the public command/response contract or an out-of-scope file.
- A test fails twice after a reasonable fix, or tests require production credentials instead of injectable fakes.
- Missing documentation files or a live server are not STOP conditions.

## Maintenance notes

Keep these commits reviewable by site. The batch threshold fix does not reserve account capacity across simultaneous requests; concurrency enforcement is separate work. Detailed-list scheduling must initialize its pending count before invoking any callback because fakes and some paths can complete synchronously. Plan 018 may change DB counts but must retain exact-once completion and authorization tests. The desktop fix here concerns traffic toward the agent; it does not bound each viewer's outbound queue.
