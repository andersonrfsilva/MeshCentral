# Plan 010: Bind messenger relay participants to authenticated identities

> **Executor instructions**: Follow this plan step by step. Run each verification and confirm its expected result. Stop and report on a STOP condition; do not improvise or ship a partial fix. Update this plan's row in `plans/README.md` unless the dispatching reviewer maintains it. If the index is absent, skip and note.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshrelay.js test/messenger-relay-binding.test.js plans/010-messenger-relay-user-binding.md plans/README.md`
> Compare changed source with Current state; stop on a material mismatch. Test/index additions from prerequisite 001 are expected.
>
> **Known blocking prerequisite**: The assumed authenticated agent-side messenger transport does not exist in the inspected flow. The agent opens a browser; that browser connects directly to the relay without a node-authentication credential. Step 1 must stop at the planned revision. This plan is BLOCKED, not an authorization implementation ready to execute. Do not silently reject every legitimate device-side browser or ship only the authenticated-user half.

## Status

- **Priority**: P2
- **Effort**: S (original relay-only estimate; revise after the blocked protocol decision)
- **Risk**: MED
- **Depends on**: Plan 001, test baseline (`plans/001-*.md`), plus an approved node-side messenger identity contract
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

User-to-node messenger sessions have a missing participant-binding check. Their predictable ID names a user and node, but naming a participant is not proof of identity. The authenticated user must match the named user; the unauthenticated device-side browser also needs an independently verified node-bound credential. The existing flow cannot supply that second proof with a relay-only patch.

## Current state

`meshrelay.js` implements relay admission and pairing. Its public factory takes `(parent, ws, req, domain, user, cookie)` (`meshrelay.js:82-92`) and calls the private `CreateMeshRelayEx`. Inside `performRelay`, the mixed-participant branch is empty (`meshrelay.js:338-348`):

```js
if (obj.id.startsWith('meshmessenger/')) {
    if ((obj.id.startsWith('meshmessenger/user/') == true) && (user == null)) { try { obj.close(); } catch (e) { } return null; } // If user-to-user, both sides need to be authenticated.
    var x = obj.id.split('/'), user1 = x[1] + '/' + x[2] + '/' + x[3], user2 = x[4] + '/' + x[5] + '/' + x[6];
    if ((x[1] != 'user') && (x[4] != 'user')) { try { obj.close(); } catch (e) { } return null; } // MeshMessenger session must have at least one authenticated user
    if ((x[1] == 'user') && (x[4] == 'user')) {
        // If this is a user-to-user session, you must be authenticated to join.
        if ((user._id != user1) && (user._id != user2)) { try { obj.close(); } catch (e) { } return null; }
    } else {
        // If only one side of the session is a user
        // !!!!! TODO: Need to make sure that one of the two sides is the correct user. !!!!!
    }
}
```

The later same-user check excludes messenger (`meshrelay.js:379-382`):

```js
// Check that both connection are for the same user
if (!obj.id.startsWith('meshmessenger/')) {
    var u1 = obj.user ? obj.user._id : obj.ruserid;
    var u2 = relayinfo.peer1.user ? relayinfo.peer1.user._id : relayinfo.peer1.ruserid;
```

The general no-authentication rejection also excludes messenger (`meshrelay.js:190`). Merely comparing `req.query.nodeid` or the node part of `obj.id` would trust client-controlled input. The existing `rauth` decoder (`meshrelay.js:184-186`) populates only `obj.ruserid` or `obj.rnouser`; it does not establish a messenger node identity.

**The actual device-side connection is a browser, not the agent socket:**

- `meshuser.js:2211-2222` checks `MESHRIGHT_CHATNOTIFY`, builds a messenger URL, and routes an `openUrl` command:

```js
var url = "https://" + parent.getWebServerName(domain, req) + ":" + httpsPort + "/" + xdomain + "messenger?id=meshmessenger/" + encodeURIComponent(command.nodeid) + "/" + encodeURIComponent(user._id);

// Open a web page on the remote device
routeCommandToNode({ 'action': 'openUrl', 'nodeid': command.nodeid, 'userid': user._id, 'username': user.name, 'url': url });
```

- `agents/meshcore.js:2079-2083` opens a local browser:

```js
case 'openUrl': {
    // Open a local web browser and return success/fail
    //sendConsoleText('OpenURL: ' + data.url);
    MeshServerLogEx(20, [data.url], "Opening: " + data.url, data);
    if (data.url) { mesh.SendCommand({ action: 'openUrl', url: data.url, sessionid: data.sessionid, success: (openUserDesktopUrl(data.url) != null) }); }
```

- `views/messenger.handlebars:756-758` creates an ordinary browser WebSocket:

```js
var url = window.location.protocol.replace('http', 'ws') + '//' + window.location.host + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + '/meshrelay.ashx?id=' + args.id;
if ((args.auth != null) && (args.auth != '')) { url += '&auth=' + args.auth; }
socket = new WebSocket(url);
```

The node-side URL above supplies no `auth` value. The page handler validates user identity only for user-to-user IDs (`webserver.js:4042-4054`) and renders the messenger page (`webserver.js:4076-4078`). No trusted agent identity is transferred by opening a browser. Searching `meshmessenger/` in `meshagent.js` and `agents/meshcore.js` found no literal messenger-specific path. `meshagent.js:1303-1304` routes normal agent messages with `obj.dbNodeKey`, but that authenticated node key is not attached to the independently created browser socket:

```js
// Route a message
parent.routeAgentCommand(command, obj.domain.id, obj.dbNodeKey, obj.dbMeshKey);
```

Match CommonJS, callbacks, four spaces, single quotes and existing close guards. Node >=20.19 is the execution baseline (`package.json:58-60` declares >=20). Test/check scripts depend on 001 and do not exist at the planned revision.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Test prerequisite | `node -e "const p=require('./package.json'); if (!p.scripts || !p.scripts.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Browser transport evidence | `rg -n 'openUserDesktopUrl\(data.url\)|new WebSocket\(url\)' agents/meshcore.js views/messenger.handlebars` | Prints browser launch and WebSocket creation; confirms blocker, not fix success |
| URL issuance evidence | `rg -n "routeCommandToNode\(.*openUrl" meshuser.js` | Prints openUrl routing, including messenger |
| Syntax, only after unblocking | `node -c meshrelay.js` | Exit 0 |
| Focused tests, only after unblocking | `node --test test/messenger-relay-binding.test.js` | All identity-binding cases pass |
| Suite, only after unblocking | `npm test && npm run check` | Exit 0; scripts supplied by 001 |

No install, build, lint, or production service access is required to confirm the blocker.

## Scope

**In scope** (original bounded change; do not expand without an amended plan):
- `meshrelay.js`, messenger admission before relay registration/pairing.
- `test/messenger-relay-binding.test.js` (create only after unblocking).
- `plans/010-messenger-relay-user-binding.md`, blocker/approved-contract and completion evidence.
- `plans/README.md`, own status row if present.

**Out of scope**: `meshuser.js`, `webserver.js`, `meshagent.js`, `agents/meshcore.js`, `views/messenger.handlebars`, other views, protocol/token issuance changes, general relay policy, WebRTC, recording, mobile push, peering. They are read-only evidence here. A complete credential-bearing design will likely need an explicitly expanded scope; that is why this plan is blocked.

## Git workflow

- Do not create a source-fix commit while blocked. Record BLOCKED in the index if present.
- Once the contract and revised scope are approved, use `advisor/010-messenger-relay-user-binding` after 001.
- Intended commit style: `security: bind messenger relay participants`; add only a real issue suffix.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Resolve the missing node-side identity contract before editing

Confirm 001 exists, then follow the quoted URL/openUrl/browser flow. At this revision, STOP and report: there is no authenticated agent path at relay admission and no credential binding the anonymous browser to the node. A missing live server is not the reason to stop; the source itself disproves the required transport assumption.

The owner must approve a protocol design and revise this plan before further steps. The recommended direction for review is a server-issued, short-lived messenger-specific capability delivered only through the existing authenticated command to the intended node. It must bind the entire messenger session ID, node ID, user ID, domain, role, and expiry, and must be validated server-side before pairing. This is a design prerequisite, not authorization to implement a generic token or reuse any arbitrary `auth`/`rauth` cookie. Decide replay/reconnect behavior, browser credential leakage controls, and peered-server validation before granting an executor a broader scope. The existing openUrl logging shown above also needs review before putting a bearer credential in that URL.

**Verify**: `rg -n 'openUserDesktopUrl\(data.url\)|new WebSocket\(url\)' agents/meshcore.js views/messenger.handlebars` → both browser operations are present. Record BLOCKED; do not proceed until an amended plan identifies a concrete verified node-identity source and all issuer/transport/validator files.

### Step 2: Bind the authenticated user after the contract is approved

This step is conditional and must not be shipped alone. Parse and validate the messenger identifier as exactly two canonical user/node participants. Preserve user-to-user authorization. In the one-user/one-node branch, identify `expectedUserId` from whichever participant starts with `user/` and `expectedNodeId` from the `node/` participant. If `user != null`, require `user._id === expectedUserId`; otherwise close with the existing `obj.close()` guard and return before inserting into `parent.wsrelays` or connecting peers.

Address the current early `meshmessenger/user/` null-user guard when supporting reverse participant order: it currently treats any user-first ID as user-to-user before parsing. Classify participants before applying that guard. Reject malformed IDs and invalid participant types before dereferencing `user`.

Use the exported `CreateMeshRelay(parent, ws, req, domain, user, cookie)` in tests, not a copied predicate. Build fake WebSockets/EventEmitters capturing send/close and socket pause/resume/keepalive; fake `parent.wsrelays`, session counters, traffic stats, parent args/config/debug, and timer cleanup using the baseline helper's actual API. Assert denial occurs before waiting/pairing; do not rely on its 15-second timeout to close invalid connections (`meshrelay.js:654-656`).

**Verify**: `node -c meshrelay.js && node --test test/messenger-relay-binding.test.js` → authenticated expected-user cases pass; unrelated users close before relay registration. Do not mark complete without Step 3.

### Step 3: Bind and distinguish the node participant using the approved proof

Require the amended plan's concrete server-verified node identity for every `user == null` mixed-participant connection. It must equal `expectedNodeId` and match session, domain, user, role and validity window. Never accept ID text, query `nodeid`, source IP, User-Agent, Referer, `nouser`, or a generic user relay cookie as node proof. At pairing, require the approved role contract rather than accepting two browser connections claiming the same side. Preserve legitimate reconnect behavior as explicitly specified by the amended protocol.

Complete the test matrix below through the real relay factory, including end-to-end credential issuance/transport verification in the files admitted by the amended scope. Until those files and the proof contract are specified, STOP rather than inventing `req.agent`, `req.nodeid`, `cookie.nid`, or another trusted field.

**Verify**: `node --test test/messenger-relay-binding.test.js` → valid user/node pairs connect in both arrival orders; every absent/mismatched/expired proof is rejected before pairing.

### Step 4: Record the completed protocol guarantee and run gates

Only after both roles are verified, document the actual approved proof contract and limitations in this plan. Update the index row. If no live test server/device exists, skip manual chat smoke testing and note it; automated issuer/consumer coverage remains required.

**Verify**: `npm test && npm run check` → exit 0; no identity-binding regressions.

## Test plan

Use node:test and node:assert: `const { test } = require('node:test'); const assert = require('node:assert');`. Reuse the 001 fixture convention, but call the real exported relay factory. The suite must cover:

- Named authenticated user accepted for user/node sessions in both participant orders.
- Unrelated authenticated user rejected, with no waiting relay entry or peer forwarding.
- Anonymous browser without node proof rejected; proof for another node/domain/user/session rejected.
- Malformed IDs and IDs with neither/excess user participants rejected without throwing.
- Valid node-side proof plus named user pairs in both connection arrival orders.
- Two connections presenting the same role do not impersonate a valid user/node pair.
- Expired/tampered proof rejected; reconnect/replay behavior follows the approved contract.
- User-to-user sessions still require either named logged-in user; anonymous and unrelated users fail.
- Non-messenger same-user checks and public-sharing behavior remain unchanged.

The issuer/transport tests cannot be specified as executable tests until the blocked contract is amended. Do not create placeholder tests that always pass, or tests accepting a fabricated trusted-node property. After unblocking, `node --test test/messenger-relay-binding.test.js` and `npm test` must pass.

## Done criteria

- [ ] An approved node-proof contract and expanded scope replace the known blocker; both roles are implemented together.
- [ ] `node -c meshrelay.js` exits 0.
- [ ] Unrelated users and unauthenticated/unproven node-side browsers cannot register or pair a relay.
- [ ] Legitimate browser-on-device messenger connections still work with verified node proof.
- [ ] Both ID participant orders and arrival orders are covered; user-to-user and non-messenger behavior remain covered.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] Changes match the approved scope; check with `git diff --name-only`.
- [ ] Completion evidence and index reflect DONE only after full binding; otherwise remain BLOCKED.

## STOP conditions

- **Already confirmed at 2e7ec138:** node-side messenger is an ordinary browser opened by the agent, not an authenticated agent relay connection. No trusted node identity reaches the current relay-only scope.
- `npm test` is absent; complete 001 first, but that alone does not unblock this protocol issue.
- The proposed node proof is any caller-controlled ID/header, or a generic cookie without explicit messenger role/session binding.
- The executor would need to disable legitimate node-side browser chat or ship only the user-identity half to finish within the original S scope.
- The credential would be exposed through the existing openUrl logging without an approved handling change.
- Verification fails twice after reasonable correction or requires files outside the amended approved scope.

## Maintenance notes

The original S estimate cannot honestly cover a new node-to-browser capability protocol. Re-estimate after the owner approves issuance, transport, expiry, replay, logging, mobile/push and multi-server handling. Anonymous does not mean agent-authenticated. Planning confirmed the user-binding gap and disproved the presumed agent-path fix; no runtime exploit, production chat, or credential issuance was attempted.
