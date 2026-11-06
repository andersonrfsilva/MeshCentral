# Plan 020: Make database disposal repeatable and remove closed-session listeners

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer dispatched you and maintains the index.
>
> **Drift check (run first)**: `git diff --stat 4d8f043f..HEAD -- db.js meshuser.js test/db-nedb.test.js test/dispose-and-close.test.js plans/020-db-dispose-and-close-listeners.md plans/README.md`
> Compare changed files with the Current state excerpts before proceeding. A mismatch in the target logic is a STOP condition. Documentation-only changes are not source drift.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-test-baseline.md`, `plans/017-small-correctness-fixes.md`
- **Category**: bug
- **Planned at**: commit `4d8f043f`, 2026-11-05

## Why this matters

Database disposal dereferences null members and can leave cleanup unfinished. User-session cleanup passes an array where EventEmitter expects one event name, leaving handlers attached. Make cleanup safe for null members, preserve callable disposal for a second invocation, and remove exactly the three owned socket event types.

## Current state

Repository: `/home/anderson/Desenvolvimento/oss/meshcentral`. Evidence was read from `/home/anderson/Desenvolvimento/oss/.wt/mc-017`, branch `advisor/017-small-correctness-fixes`, commit `4d8f043f`. Execute against that completed-plan stack, not the older main checkout. Paths below are relative to the executor worktree.

`db.js` configures backend-specific database methods. Six copies contain this exact statement:

```javascript
obj.dispose = function () { for (var x in obj) { if (obj[x].close) { obj[x].close(); } delete obj[x]; } };
```

Backend attribution, confirmed from enclosing branches:

| Dispose location | Branch evidence | Backend |
|---|---|---|
| `db.js:1783` | `db.js:1667`: `if (obj.databaseType == DB_SQLITE) {` | SQLite |
| `db.js:2055` | `db.js:1982`: `} else if (obj.databaseType == DB_ACEBASE) {` | AceBase |
| `db.js:2341` | `db.js:2272`: `} else if (obj.databaseType == DB_POSTGRESQL) {` | PostgreSQL |
| `db.js:2605` | `db.js:2535`: `} else if ((obj.databaseType == DB_MARIADB) || (obj.databaseType == DB_MYSQL)) {` | MariaDB/MySQL |
| `db.js:2927` | `db.js:2787`: `} else if (obj.databaseType == DB_MONGODB) {` | MongoDB |
| `db.js:3158` | `db.js:3089`: `// Database actions on the main collection (NeDB and MongoJS)` | NeDB/MongoJS |

Changing only the first three copies does not fix NeDB. The loop also deletes `dispose` itself, so a null check alone cannot make two direct `db.dispose()` calls succeed.

`meshuser.js:226-236` performs aggressive session cleanup, including:

```javascript
obj.ws.removeAllListeners(['message', 'close', 'error']);
```

`test/helpers/fake-parent.js:30-33,76,84` provides a real session and EventEmitter websocket:

```javascript
const ws = new EventEmitter();
ws.send = function (data) { sent.push(data); };
ws.close = function () { closeCalls++; }; // Does not emit 'close', so obj.close() cannot recurse.
```

```javascript
const obj = require('../../meshuser.js').CreateMeshUser(parent, db, ws, req, args, domain, user);
```

The returned fixture exposes `obj`, `ws`, and `close: function () { obj.close(0); }`.

`test/db-nedb.test.js:24-41` creates a temporary directory, calls `CreateDB(createDbParent(dir), resolve)`, captures four stores, drains each with `store.find({}, resolve)`, then calls `store.stopAutocompaction()`. Its teardown currently tolerates the defect:

```javascript
if (db != null) { try { db.dispose(); } catch (ex) { assert.ok(ex instanceof TypeError); } }
```

Use CommonJS, callbacks, four-space indentation, and single quotes. `test/db-nedb.test.js:3-8` imports `node:test`, `node:assert`, and `createDbParent`. `package.json:39-41,62-64` defines `npm test` as `node --test test/`, syntax checking as `npm run check`, and Node >=20.

## Commands you will need

Run from the executor worktree root. No new dependencies or install are required.

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime | `node --version` | Node 20 or newer |
| Focused tests | `node --test test/db-nedb.test.js test/dispose-and-close.test.js` | All pass; process exits |
| Unsafe disposal search | `grep -nF 'if (obj[x].close)' db.js` | No matches; exit 1 |
| Listener search | `grep -nF "removeAllListeners(['message', 'close', 'error'])" meshuser.js` | No matches; exit 1 |
| Full suite | `npm test` | All pass |
| Syntax | `npm run check` | Exit 0 |
| Scope | `git diff --name-only` | Only in-scope files |

## Scope

**In scope**:
- `db.js`
- `meshuser.js`
- `test/db-nedb.test.js`
- `test/dispose-and-close.test.js` (create)
- `plans/020-db-dispose-and-close-listeners.md` (execution evidence)
- `plans/README.md` (this status row only)

**Out of scope**: database-driver migrations, async shutdown redesign, SQL integration infrastructure, shared fixture refactoring, unrelated socket event ownership, and suppression of errors thrown by real `close()` methods.

## Git workflow

- Create `advisor/020-db-dispose-and-close-listeners` from the completed prerequisite stack containing `4d8f043f`; do not edit the evidence worktree in place.
- Use logical commits, such as `fix: make database disposal and session listener cleanup safe`. Observed commit `4d8f043f` uses `test: regression cases for plan 017 small correctness fixes`.
- Do not push or open a PR without operator instruction.

## Steps

### Step 1: Correct all six disposal implementations and their NeDB regression

At every listed disposal body, skip the `dispose` key before closing/deleting properties. Replace the close predicate with `if ((obj[x] != null) && (typeof obj[x].close == 'function'))`. Keep calls bound as `obj[x].close()`. Preserve real close errors; do not catch and discard them. Retaining only `dispose` makes a second direct call a no-op without adding another lifecycle flag or helper.

Update the existing NeDB teardown to require successful disposal instead of allowing TypeError. Capture and drain all stores and stop their compaction timers before disposal; never access deleted database properties afterward. Add a dedicated NeDB disposal test following the existing `withDb` setup: create its own temporary directory with `createDbParent`, await `CreateDB`, capture the four stores, drain them, and stop their compaction timers before invoking disposal. Inject null, undefined, a non-function `close`, and a close spy with a receiver assertion. Assert two direct `db.dispose()` calls do not throw, the spy runs once, and all injected properties are removed. In finally, use captured store references to stop timers if setup failed, dispose only after drainage, and remove the temporary directory. Do not dispose inside an ordinary `withDb` body before its initialization-drain phase.

**Verify**: `node --test test/db-nedb.test.js` → all pass, including the repeated-disposal case, and the process exits without retained timers.

### Step 2: Remove session listeners one event name at a time

Replace the array argument in `meshuser.js` with a loop over `['message', 'close', 'error']` that calls `obj.ws.removeAllListeners(eventName)`. Do not use the argument-free form: other event types are outside this cleanup contract.

Create `test/dispose-and-close.test.js`, importing `createMeshUserFixture`. Await the fixture, add a listener for each target event if necessary, and assert nonzero pre-close counts. Add an unrelated sentinel event listener. Call `fixture.obj.close(0)` once, assert all three target counts are zero, and assert the sentinel remains. The fixture's fake `ws.close` does not emit recursively. Do not require repeated MeshUser close to be idempotent; that is not this plan's contract.

**Verify**: `node --test test/dispose-and-close.test.js` → all three event counts are zero and the unrelated listener survives.

### Step 3: Run integration gates and record evidence

Run both old-pattern searches, the focused tests, full suite, and syntax check. Record commands/results here and update only this index row, unless the reviewer owns it.

**Verify**: `npm test && npm run check && git diff --name-only` → tests and syntax pass, changed paths stay within Scope.

## Test plan

- Extend `test/db-nedb.test.js`: real NeDB construction; actual null members; injected undefined and non-callable close; close receiver preserved; close called once; two direct disposals succeed.
- Follow its store-drain and compaction-stop pattern, not a fake database-only test.
- Add `test/dispose-and-close.test.js`: real MeshUser factory through the existing fake-parent fixture; remove message, close, and error handlers while retaining another event type.
- Run `node --test test/db-nedb.test.js test/dispose-and-close.test.js`, then `npm test` and `npm run check`. No live SQL backend is claimed by these tests.

## Done criteria

- [ ] All six backend disposal bodies use the null-and-function guard and retain `dispose`.
- [ ] Two direct NeDB `db.dispose()` calls pass without thrown errors; injected close runs once.
- [ ] NeDB teardown no longer tolerates TypeError.
- [ ] Session listener regression passes for all three names and preserves the sentinel event.
- [ ] Both unsafe-pattern searches return no matches.
- [ ] Focused tests, `npm test`, and `npm run check` exit 0.
- [ ] `git diff --name-only` contains only in-scope paths.
- [ ] Execution evidence and this plan's index row are updated, or reviewer ownership is recorded.

## STOP conditions

Stop and report if the target excerpts drift, backend attribution changes, or a verification fails twice after a reasonable fix attempt. Stop if retained `dispose` conflicts with a documented caller that requires an entirely empty object. Stop if NeDB cannot drain and stop timers without accessing disposed state, or if the fixture needs production event dispatch to close. Do not solve those failures by swallowing exceptions, deleting unrelated handlers, adding drivers, or editing outside Scope.

## Maintenance notes

Keep all backend disposal copies consistent until a separately approved consolidation. Review the method-retention detail: null safety alone is not repeated-call safety. Native NeDB coverage does not prove that every external driver closes its pool; driver-specific shutdown semantics remain outside this change. Listener cleanup must remain explicit about event ownership.
