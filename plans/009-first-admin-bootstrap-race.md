# Plan 009: Serialize first-administrator bootstrap within each domain

> **Executor instructions**: Follow each step and run its verification before proceeding. Stop and report on a STOP condition; do not improvise. Update this plan's row in `plans/README.md` unless the dispatching reviewer maintains it. If the index is absent, skip and note.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- webserver.js test/first-admin-bootstrap.test.js plans/009-first-admin-bootstrap-race.md plans/README.md`
> Compare changed source with Current state. Stop on material mismatch; prerequisite test and index additions are expected.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001, test baseline (`plans/001-*.md`)
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Two requests can count an empty domain before asynchronous validation completes. Both then use that stale count to grant full administrator rights. Claim the empty-domain bootstrap slot synchronously, reject overlapping bootstrap attempts, and re-count immediately before assigning administrator rights. This fixes the single-process race, not distributed bootstrap across peered servers.

## Current state

`webserver.js` owns account creation and the user cache. `webserver.js:172` initializes `obj.users = {};`. The HTTP entry point is the local `handleCreateAccountRequest(req, res, direct)` (`webserver.js:1758`), registered for POST `createaccount` at `webserver.js:7609`:

```js
obj.app.post(url + 'createaccount', obj.bodyParser.urlencoded({ extended: false }), handleCreateAccountRequest);
```

The handler counts synchronously and gates registration (`webserver.js:1809-1817`):

```js
// Count the number of users in this domain
var domainUserCount = 0;
for (var i in obj.users) { if (obj.users[i].domain == domain.id) { domainUserCount++; } }

// Check if we are allowed to create new users using the login screen
if ((domain.newaccounts !== 1) && (domain.newaccounts !== true) && (domainUserCount > 0)) {
    parent.debug('web', 'handleCreateAccountRequest: domainUserCount > 1.');
    res.sendStatus(401);
    return;
}
```

Asynchronous operations follow: `obj.db.isMaxType(domain.limits.maxuseraccounts, 'user', domain.id, function (maxExceed) {` at `webserver.js:1843`, then `obj.db.GetUserWithVerifiedEmail(domain.id, req.body.email, function (err, docs) {` at `webserver.js:1857`.

The stale count grants privileges at `webserver.js:1874`:

```js
if (domainUserCount == 0) { user.siteadmin = 4294967295; /*if (domain.newaccounts === 2) { delete domain.newaccounts; }*/ } // If this is the first user, give the account site admin.
```

The user is published before asynchronous password hashing (`webserver.js:1899-1905`):

```js
obj.users[user._id] = user;
req.session.userid = user._id;
req.session.ip = req.clientIp; // Bind this session to the IP address of the request
setSessionRandom(req);
// Create a user, generate a salt and hash the password
require('./pass').hash(req.body.password1, function (err, salt, hash, tag) {
    if (err) throw err;
```

Preserve this existing publication/hash ordering in this narrowly scoped race fix. The hash failure behavior is a separate existing concern, not a reason to keep the bootstrap claim forever.

Failure exits after the count include email-domain rejection (`1824-1838`), account limit (`1844-1848`), invalid fields/password (`1850-1854`), existing verified email (`1858-1862`), and existing username (`1865-1868`). All acquired-claim paths must release ownership or publish a user before ending.

Match the CommonJS, callback, four-space indentation, single-quote and one-line guard conventions above. Node >=20.19 is the execution baseline; `package.json:58-60` declares >=20. No test/check scripts exist at this revision; 001 adds them.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const p=require('./package.json'); if (!p.scripts || !p.scripts.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c webserver.js` | Exit 0, no output |
| Focused tests | `node --test test/first-admin-bootstrap.test.js` | All cases pass without sleeps or sockets |
| Full suite | `npm test` | Exit 0 |
| Maintained syntax | `npm run check` | Exit 0; provided by 001 |

No install, build, lint, real database, or listening server is needed.

## Scope

**In scope**:
- `webserver.js`, initialize the per-domain claim map and modify account-creation claim lifecycle/grant checks only.
- `test/first-admin-bootstrap.test.js` (create).
- `plans/009-first-admin-bootstrap-race.md`, completion evidence.
- `plans/README.md`, own status row if present.

**Out of scope**: distributed locks, schema changes, new registration response formats, other account-creation paths, password hash/publication reordering, group-assignment refactors, session refactors, dependency changes.

## Git workflow

- Branch `advisor/009-first-admin-bootstrap-race` after 001; preserve unrelated changes.
- One logical commit: `security: serialize first administrator bootstrap`; use an issue suffix only if assigned.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Create a deterministic handler harness

Confirm 001's runner exists. Use `const { test } = require('node:test'); const assert = require('node:assert');` in the new test. There is no exported account-creation method and constructing the entire webserver would introduce unrelated network setup. For this closure-only regression, use a test-local `node:vm` harness evaluating the actual handler text from `webserver.js`, not a hand-copied algorithm.

Read the source with `node:fs`, locate the exact start marker `    function handleCreateAccountRequest(req, res, direct) {` and the end marker `    // Called to process an account password reset` (`webserver.js:1758,1926`). Assert each marker occurs exactly once and in that order, slice between them, evaluate that declaration in a fresh VM context, and retrieve `handleCreateAccountRequest`. If the markers drift, fail clearly; never silently pick another function. This test-only source seam avoids adding production exports. It does not prove HTTP routing, so retain a source assertion that POST createaccount still registers this handler.

Supply `obj.users`, `obj.bootstrapClaimed` as null-prototype maps; `obj.common=require('../common.js')`; `obj.db` and lexical `db` as the same fake; `obj.userGroups={}`; `obj.parent.DispatchEvent`, `obj.CloneSafeUser`, and `obj.getLanguageCodes` as harmless captures. Supply lexical `parent.config.settings={}`, `parent.debug`, `checkUserIpAddress` returning the test domain, `getQueryPortion` returning '', `handleRootRequestEx` as a capture, and `setSessionRandom` as a no-op. Supply `require` accepting only `./pass`, whose `hash` invokes its callback with synthetic values. Do not use real hashes, sessions, mail, or timers.

Fake requests have distinct valid usernames/emails, matching passwords, `body`, `session:{}`, `query:{}`, and `clientIp`. Domain has `id`, `url`, `limits:{}`, and chosen `newaccounts`; omit CAPTCHA, group, mail, and realm options unless a test needs them. Responses capture `sendStatus` and `redirect`. Fake `isMaxType` and `GetUserWithVerifiedEmail` queue callbacks for explicit release. Assert baseline single-account success and existing-user registration policy before changing production.

**Verify**: `node --test test/first-admin-bootstrap.test.js` → characterization tests pass; no sockets or sleeps are used.

### Step 2: Claim synchronously and release only the owner's claim

Initialize `obj.bootstrapClaimed = Object.create(null);` beside `obj.users`. In the handler, immediately after the domain count and before the first asynchronous call, initialize a request-local ownership boolean. If the count is zero and a claim already exists for `domain.id`, return HTTP 401 using the established `res.sendStatus(401); return;` pattern. Do this even when ordinary new-account registration is enabled: an overlapping request can retry once bootstrap finishes. Otherwise, when the count is zero, set `obj.bootstrapClaimed[domain.id] = true` and mark this request as owner synchronously.

Define a small handler-local release function that only deletes the domain entry when this request owns it, then clears its local ownership boolean. Never let a rejected non-owner clear another request's claim. Do not attach claim cleanup to request/response close events: the database callbacks may still complete afterward, permitting overlapping owners.

Call release before every failure response/branch listed in Current state. Treat `GetUserWithVerifiedEmail` errors as failed validation: release, use the existing generic creation-failure loginmode/messageid/redirect path, and return; do not grant on a failed lookup. Synchronous email-domain failures also release. Successful publication releases immediately after `obj.users[user._id] = user`; the populated cache then blocks further bootstrap. Thus existing hash failure occurs after claim release without changing publication order.

Immediately before the full-admin assignment, recompute the number of users in this domain from current `obj.users`. Grant `4294967295` only if this request owns the bootstrap claim and the refreshed count is zero. No asynchronous operation may occur between that refreshed check, grant, and cache insertion. If registration is disabled and another user appeared while validation was pending, release and return 401 before modifying groups or user/session state. If registration is enabled, allow an ordinary account with configured `newaccountsrights`, not an automatic bootstrap grant.

Preserve existing default rights, realm handling, comments, redirects, direct=true rendering, groups, and events. Do not interpret every configured full-admin `newaccountsrights` account as a bootstrap race: that is separate intentional policy.

**Verify**: `node -c webserver.js && node --test test/first-admin-bootstrap.test.js` → syntax and characterization tests pass.

### Step 3: Exercise concurrent callbacks and every release path

Add the test matrix below. Start A and B before releasing any callback; assert B gets 401 and never queues its first DB callback. Finish A, then retry B with a fresh request and assert normal registration policy. Reverse request arrival order in a second case. For different domains, assert both reach their independent callbacks. For release tests, fail the owner at the chosen branch, then issue another request that must acquire the domain slot. Assert no claim survives success/failure and a non-owner cannot release the original claim.

**Verify**: `node --test test/first-admin-bootstrap.test.js` → all concurrency/release cases pass deterministically.

### Step 4: Document the single-process guarantee and complete gates

Record the overlap response and multi-server limitation in this plan's completion evidence. Update the index if present; otherwise skip and note. A missing live server is not a blocker; skip manual signup checks and note it.

**Verify**: `npm test && npm run check` → exit 0 with no failures.

## Test plan

Use the actual-source VM seam described above and node:test conventions from 001. Cover:

- Single empty-domain account gets bootstrap admin.
- Two overlapping requests in an empty domain yield one bootstrap owner, with registration disabled and enabled separately.
- Reverse arrival order produces the same one-owner guarantee.
- A second request cannot delete the active owner's claim.
- Separate domains bootstrap independently, including the default empty-string domain ID.
- A user inserted during queued validation prevents the stale grant; disabled registration rejects, enabled registration retains ordinary configured rights.
- Release after each failure: invalid/missing allowed email domain, disallowed email domain, account limit, invalid account/password, verified-email conflict, verified-email lookup error, and existing username.
- Successful publication clears the claim; follow-up requests obey registration policy.
- Synthetic hash error follows existing throw behavior after claim release; do not claim this plan fixes partially published users.

Do not use timers to create races. Explicitly drain fake callback queues. `node --test test/first-admin-bootstrap.test.js` and `npm test` must pass.

## Done criteria

- [ ] `node -c webserver.js` exits 0.
- [ ] Concurrent empty-domain tests produce exactly one automatic bootstrap administrator.
- [ ] Every pre-publication failure releases only its own claim; retries can claim again.
- [ ] Fresh-count tests prevent grants after another user appears.
- [ ] Domain isolation and default-domain behavior are tested.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` contains no out-of-scope changes attributable to this plan.
- [ ] Completion evidence and own index status are updated, or absent index is noted.

## STOP conditions

- `npm test` is absent: complete 001 first.
- Source marker/handler structure no longer matches; do not run a stale VM-extracted algorithm.
- Registration can yield between the final count and cache insertion, or another bootstrap path bypasses this handler within the same request flow.
- Correctness requires publishing users only after password hashing; that is a larger lifecycle change, outside this plan.
- The requested guarantee is cluster-wide across multiple server processes. An in-memory map cannot provide it; request a transactional database claim design instead.
- Verification fails twice after reasonable correction, or out-of-scope changes are required.

## Maintenance notes

The claim protects one Node process only. Peered servers can each see an empty cache and claim independently; do not advertise distributed first-admin safety. Review every newly added return/failure branch between claim and publication for cleanup. Existing pre-hash cache publication and fatal hash-error behavior remain unchanged and must not be hidden by these tests. The VM seam tests actual handler logic but not middleware or HTTP wiring; keep its explicit source-boundary assertions. Planning did not run account creation or tests.
