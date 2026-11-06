# Plan 007: Require device visibility before reading its events

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before continuing. Stop and report when a STOP condition occurs; do not improvise. Update this plan's row in `plans/README.md` when done, unless the dispatching reviewer maintains the index. If the index is absent, skip and note.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshuser.js test/device-events-visibility.test.js plans/007-device-events-require-visibility.md plans/README.md`
> Compare changed source with Current state; stop on a material mismatch. Baseline tests and index updates from earlier plans are expected.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 001, test baseline (`plans/001-*.md`)
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

A device can exist without being visible to the requesting user. The events command currently treats existence as sufficient, then reads device event history. Respect the rights helper's visibility result before either event database query.

## Current state

`meshuser.js` handles WebSocket commands. The device-filtered `events` branch at `meshuser.js:1153-1154` currently checks only existence:

```js
parent.GetNodeWithRights(domain, user, command.nodeid, function (node, rights, visible) {
    if (node == null) { try { ws.send(JSON.stringify({ action: 'events', events: [], nodeid: command.nodeid, tag: command.tag })); } catch (ex) { } return; }
```

At `meshuser.js:1165-1173`, non-admin restricted users use `GetNodeEventsSelfWithLimit`; everybody else uses `GetNodeEventsWithLimit`:

```js
if (((rights & MESHRIGHT_LIMITEVENTS) != 0) && (rights != MESHRIGHT_ADMIN)) {
    // Send the list of most recent events for this nodeid that only apply to us, up to 'limit' count
    db.GetNodeEventsSelfWithLimit(node._id, domain.id, user._id, limit, filter, function (err, docs) {
```

`webserver.js` owns `GetNodeWithRights`. It initializes `var rights = 0, visible = false, r = user.links[nodeid];` (`webserver.js:9907`) and ultimately calls `func(nodes[0], rights, visible);` (`webserver.js:9947`). A user with unrelated links can therefore receive a real node with zero rights and false visibility. Do not replace visibility with a nonzero-rights test: a visible link may itself carry zero rights.

The established guard in another handler is `if ((node == null) || (visible == false)) return;` (`meshuser.js:3432`). Match that comparison style while preserving the events response.

Actual test dispatch: `meshuser.js:554` registers `ws.on('message', processWebSocketData);`. The closure parses `JSON.parse(msg.toString('utf8'))` at `meshuser.js:712`; it is not `obj.handleMessage`. The exported constructor is `CreateMeshUser(parent, db, ws, req, args, domain, user)` (`meshuser.js:23`). Use CommonJS, callback style, four spaces, and single quotes. Node >=20.19 is the execution baseline; `package.json:58-60` declares >=20. At this revision no npm test/check scripts exist; prerequisite 001 supplies them.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const p=require('./package.json'); if (!p.scripts || !p.scripts.test) process.exit(1)"` | Exit 0, otherwise STOP |
| Syntax | `node -c meshuser.js` | Exit 0, no output |
| Focused test | `node --test test/device-events-visibility.test.js` | All tests pass |
| Suite | `npm test` | Exit 0 |
| Syntax baseline | `npm run check` | Exit 0; supplied by 001 |

No build, lint, install, or live service is required.

## Scope

**In scope**:
- `meshuser.js`, device-filtered events guard only.
- `test/device-events-visibility.test.js` (create).
- `plans/007-device-events-require-visibility.md`, completion evidence.
- `plans/README.md`, own status row if present.

**Out of scope**: `webserver.js` rights computation, other event branches, response schemas, event filters/limits, dependencies, and shared baseline helper changes.

## Git workflow

- Branch `advisor/007-device-events-require-visibility`, based on completed 001; preserve unrelated work.
- One logical commit: `security: require visibility for device event history`; include a real issue suffix only if assigned.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Construct the real events-command fixture

Use plan 001's `test/helpers/fake-parent.js` with its actual API. Add `const { test } = require('node:test'); const assert = require('node:assert');`. Fake `ws` must capture `send`, expose event registration and `_socket.setKeepAlive`, and support `close`. Construct `CreateMeshUser`, await its message-listener registration, then clear startup messages. Session registration uses asynchronous `parent.crypto.randomBytes` (`meshuser.js:415-420`). Send `ws.emit('message', Buffer.from(JSON.stringify({action:'events',nodeid:'node/test/abcdefgh',tag:'test-tag'})))`.

Set `domain={id:'test',limits:{}}`, ordinary user `_id:'user/test/alice'`, `links:{}` and `siteadmin:0`. Handler fields: real `parent.common`, `parent.force2factorPending` returning false, and controlled `parent.GetNodeWithRights`. Supply both DB methods as recording callbacks: `GetNodeEventsWithLimit(nodeid, domainid, limit, filter, callback)` and `GetNodeEventsSelfWithLimit(nodeid, domainid, userid, limit, filter, callback)`. Use the same fake DB in `parent.db` and the constructor argument. Return distinctive synthetic event records.

Reuse baseline constructor stubs for session maps, crypto, `parent.parent.config.settings/domains`, `DispatchEvent`, `subscribe`, certificates/hash fields, `getDomainUserFeatures`, `getWebServerName`, and args (`meshuser.js:387-430,496-497,567-625`). Assert the actual message listener exists; never bypass startup or copy the switch case into tests. Start with missing-node and visible-node cases, which should already pass.

**Verify**: `node --test test/device-events-visibility.test.js` → characterization cases pass.

### Step 2: Add the visibility guard and regression cases

Change only the condition at the start of the callback to:

```js
if ((node == null) || (visible == false)) { try { ws.send(JSON.stringify({ action: 'events', events: [], nodeid: command.nodeid, tag: command.tag })); } catch (ex) { } return; }
```

Preserve existing empty-event semantics, canonical node IDs, tag, catches, limit, filtering, and restricted-event branch. Add all cases below. For every invisible case, assert neither DB query runs, including when the fake helper reports nonzero rights alongside false visibility.

**Verify**: `node -c meshuser.js && node --test test/device-events-visibility.test.js` → exit 0; all cases pass.

### Step 3: Record completion and run baseline gates

Record this behavior in this plan's completion evidence. Update the index row if present; otherwise skip and note. Skip optional live-server smoke testing if no server exists; do not start production services.

**Verify**: `npm test && npm run check` → exit 0 with no failures.

## Test plan

Following the 001 fixture, add at least seven named cases:

1. Missing node produces `{action:'events',events:[],nodeid,tag}` and no DB reads.
2. Real node, rights 0, visible false: same denial response, no reads.
3. Real node, nonzero rights, visible false: denied before either read.
4. Visible node with ordinary rights: general query only.
5. Visible node with rights 0: general query, preserving visibility semantics.
6. Visible node with `0x00002000` (`MESHRIGHT_LIMITEVENTS`): self query only, with the requesting user's ID.
7. Visible full administrator `0xFFFFFFFF`: general query despite the limit bit.

Include limit/filter/tag assertions in positive cases and one short node ID normalization assertion. `node --test test/device-events-visibility.test.js` must pass every case; `npm test` must remain green.

## Done criteria

- [ ] `node -c meshuser.js` exits 0.
- [ ] Invisible devices never invoke either event-history DB method in tests.
- [ ] Visible zero-rights links, limited-event rights, and admin behavior remain covered.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` shows no out-of-scope changes attributable to this plan.
- [ ] Completion evidence and own index status are updated, or absent index is noted.

## STOP conditions

- `npm test` is absent: execute plan 001 first.
- `GetNodeWithRights` no longer returns the documented `(node, rights, visible)` values, or the events handler uses another authorization path.
- Fixture setup cannot reach the actual message listener using the baseline helper; report the missing initialization dependency rather than copying production logic.
- A proposed fix requires changing rights computation or treating every zero-rights visible node as invisible.
- Verification fails twice after reasonable fixes, or an out-of-scope source edit becomes necessary.

## Maintenance notes

Existence, rights bits, and visibility are separate concepts. Future event endpoints must check visibility before choosing their history query. A missing live server or documentation index is a skip-and-note condition, never a reason to loosen the tests. No server was exercised during planning.
