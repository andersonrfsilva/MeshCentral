# Plan 003: Authorize backup password access before shared-state mutation

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions section occurs, stop and report; do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index. If that index or another documentation file is absent, skip its update and note the omission; absence is not a STOP.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- meshuser.js test/backup-password-authorization.test.js test/helpers/fake-parent.js readme.md plans/README.md`
> Compare changed files against the Current state excerpts. Expected changes from plan 001 are allowed; unexplained changes to the affected logic require STOP and review.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-test-baseline.md
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

The password command changes shared backup settings before backup authorization runs. An unprivileged session can influence a later backup or inspect whether a password exists. Moving the existing policy to the command boundary prevents both actions without changing the backup engine.

## Current state

All paths are relative to `/home/anderson/Desenvolvimento/oss/meshcentral`. Run commands from that directory. This is CommonJS and callback-based code. Match four-space indentation, single quotes, and existing compact guards; do not reformat surrounding code.

`meshuser.js:6027` registers `'serverbackuppassword': serverCommandServerBackuppassword`. `meshuser.js:6883-6890` currently does this without any permission guard:
```js
function serverCommandServerBackuppassword(command) {
    if (command.check) {
        //check for existing config.json password for requestercheckbox
        obj.send({ action: 'backuprestore', data: (Object.hasOwn(parent.parent.config.settings.autobackup, 'zippassword')), dialog: command.dialog });
    } else {
        parent.parent.config.settings.autobackup.zippasswordrequest = command.override ? parent.parent.config.settings.autobackup.zippassword : command.password;
        if (command.prepare === true) { prepareServerBackup(); }
    }
}
```
The later `prepareServerBackup` check cannot undo mutation. `meshuser.js:6895-6896` already defines the policy:
```js
if ((user.siteadmin & SITERIGHT_SERVERBACKUP) == 0) return;
if ((domain.myserver === false) || ((domain.myserver != null) && (domain.myserver.backup !== true))) return;
```
`meshuser.js:68` defines `SITERIGHT_SERVERBACKUP = 0x00000001`.

`db.js:3806-3812` reads the shared override when producing a backup:
```js
let zipPassword = null;
if ((parent.config.settings.autobackup.zippasswordrequest != '') &&
    ((typeof parent.config.settings.autobackup.zippassword == 'string') ||
     (typeof parent.config.settings.autobackup.zippasswordrequest == 'string'))) {
    zipPassword = (typeof parent.config.settings.autobackup.zippasswordrequest == 'string')
        ? parent.config.settings.autobackup.zippasswordrequest
        : parent.config.settings.autobackup.zippassword;
```
`db.js:3819` deletes `zippasswordrequest` only after consumption. An unauthorized write can therefore affect a later backup. Do not quote or load any real password. `readme.md:26` is the existing Documentation section.

### Real WebSocket fixture contract

Use plan 001's `test/helpers/fake-parent.js`; extend only explicit fields there if necessary. Construct `require('../meshuser.js').CreateMeshUser(parent, db, ws, req, args, domain, user)` from a test file. There is **no `obj.handleMessage` entry point**. `meshuser.js:554` registers `ws.on('message', processWebSocketData)`; `meshuser.js:710-724` parses `msg.toString('utf8')`, validates `action`, calls `parent.force2factorPending`, then routes through `serverCommands` or the switch. Emit `ws.emit('message', Buffer.from(JSON.stringify(command)))` after initialization. Wait for `_socket.resume()` through a readiness promise before dispatch; clear captured initialization sends/events before assertions.

The baseline fixture must provide a real EventEmitter socket with captured `send`, `close`, `_socket.setKeepAlive`, `_socket.resume`; `req.session.userid`, `req.clientIp`; `domain.id`, `domain.limits = {}`; `user._id`, `user.name`, `user.domain`, `user.siteadmin`; empty `args` without ping/pong settings. Web parent fields: `common` (real common module), `crypto` (real Node crypto), `args`, `users` containing requester, `wssessions`, `wssessions2`, `meshes`, `userGroups`, `desktoprelays`, `certificates` with synthetic `CommonName` and `AmtMpsName`, `webCertificateFullHashs[domain.id]` (synthetic binary string), `webCertificateExpire = {}`, `subscribe` returning `[]`, `getDomainUserFeatures` returning `{ features: 0, features2: 0, features3: 0 }`, `getWebServerName` returning a test hostname, `CloneSafeUser` returning a safe copy, and `force2factorPending` returning false. Root `parent.parent` needs `config.settings = { managealldevicegroups: [], autobackup: {} }`, `config.domains[domain.id]`, captured `DispatchEvent`, `RemoveAllEventDispatch`, `debug`, `getServerWarnings` returning `[]`, and `logError` that records unexpected exceptions. Leave optional services absent. These fields follow `meshuser.js:126,387-432,496,567-625,641-644,665-701`. Close the returned session in test cleanup; do not enable session-expiry or browser timers. Assert readiness, exactly one message listener, and no logged errors so initialization failures cannot make negative tests pass accidentally.

For teardown (`meshuser.js:210-234`), set `user.access` to current epoch seconds and `parent.db = db`; provide `db.SetUser` as a capture function and `db.changeStream = false`. The fake socket close must not recursively emit close when `obj.close()` calls it.


## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime | `node --version` | Node 20.19 or newer; CI uses Node 20 and 22 |
| Syntax, available now | `node -c common.js && node -c db.js && node -c meshuser.js` | Exit 0, no output |
| Test suite, after plan 001 | `npm test` | All tests pass and process exits naturally |
| Maintained syntax, after plan 001 | `npm run check` | Exit 0 |


The npm commands above are planned additions, not commands present at the planning commit. No test or install was run while writing this plan.

## Scope

**In scope** (the only files to modify):
- `meshuser.js`
- `test/backup-password-authorization.test.js` (create)
- `test/helpers/fake-parent.js` (create)
- `readme.md`
- `plans/README.md`

**Out of scope**:
- Production configuration, credentials, databases, network services, and deployment.
- Dependency upgrades, schema changes, unrelated formatting, and unrelated security findings.
- Existing public response shapes except the explicitly denied operations below.

## Git workflow

- Branch: `advisor/003-backup-password-authorization`.
- Preserve unrelated local work. Do not reset or clean the checkout.
- Use a focused commit with the repository's style, such as `security: authorize backup password access before shared-state mutation`. Add `(#NNNN)` only when a real issue number exists.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Exercise the password command through the WebSocket

Create `test/backup-password-authorization.test.js` with native test/assert imports. Use the fixture and its real `serverCommands` dispatch. Provide `parent.parent.config.settings.autobackup` with synthetic sentinel values, a capture `parent.db.performBackup`, `parent.preparedBackups = {}`, and `parent.parent.addServerWarning` as a capture function. `db.performingBackup = false`, `db.newAutoBackupFile = null` avoid the asynchronous backup polling loop. Never create a ZIP or load production configuration.

Capture outgoing packets and mutate no real state. Dispatch check, password, override, and prepare commands with requester siteadmin 0. Assert no `backuprestore` disclosure, no change/addition of `zippasswordrequest`, and zero performBackup calls. Also test restricted domain policy with a permitted bit. Use deep snapshots of autobackup for all rejected cases.

**Verify**: `node --test test/backup-password-authorization.test.js` → before the fix, unauthorized mutation/disclosure assertions fail, while fixture initialization succeeds.

### Step 2: Gate before every read and mutation

At the first statement of `serverCommandServerBackuppassword`, add the same two checks used in prepareServerBackup, with surrounding compact braced style:
```js
if ((user.siteadmin & SITERIGHT_SERVERBACKUP) == 0) { return; }
if ((domain.myserver === false) || ((domain.myserver != null) && (domain.myserver.backup !== true))) { return; }
```
Both must precede `if (command.check)`. Keep the checks in prepareServerBackup too; it has independent callers. Preserve authorized check response shape, dialog, override selection, empty-string behavior, and prepare semantics. Reject silently, matching prepareServerBackup; do not introduce a new packet or disclose whether a password exists.

**Verify**: `node --test test/backup-password-authorization.test.js && node -c meshuser.js` → all authorization and allowed-path cases pass.

### Step 3: Document the shared permission and finish

Add one short sentence near `readme.md` Documentation explaining that backup password inspection/overrides require server-backup permission and domain backup access. Missing documentation: skip and note. Update index when available and not reviewer-owned.

**Verify**: `npm test && npm run check && git diff --check` → exit 0 for all gates.


## Test plan

Cases: denied siteadmin 0 for check=true, password assignment, override=true, and prepare=true; unrelated bit 2 denied; permission bit 1 permitted; full siteadmin permitted. Domain policy cases: undefined myserver allowed, false denied, `{}` denied, `{ backup: false }` denied, `{ backup: true }` allowed. Authorized check preserves `action: 'backuprestore'`, boolean data and dialog. Authorized override picks synthetic configured password, direct assignment preserves supplied synthetic password including empty string, prepare calls performBackup once. Denied tests retain a pre-existing override unchanged and also cannot create a missing override. Use no real ZIP output; the permitted prepare case may emit the existing backup-error response because no backup file exists. Assert no errors were logged by dispatch.

## Done criteria

- [ ] Denied commands leave autobackup deeply unchanged and emit no password-presence response.
- [ ] All myserver policy cases pass with and without the backup permission bit.
- [ ] Authorized check, override, assignment, and prepare semantics remain covered.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` lists only the scoped files for this change; preserve pre-existing unrelated work.
- [ ] Update the index row, or note that the reviewer owns it or the file was absent.

## STOP conditions

- If `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` fails, STOP: plan 001 has not landed. Do not substitute ad hoc tests.
- STOP if prepareServerBackup now uses a different permission/domain policy; reconcile both guards before proceeding.
- STOP if the test attempts actual backup generation, filesystem archives, or a live config; replace these with the specified DB capture fixture.
- STOP if global override ownership must be redesigned to satisfy the requirement; this plan only fixes authorization, not concurrent-backup semantics.

A live server is not required. Skip live checks and note that limitation instead of stopping.

## Maintenance notes

The override remains shared and one-shot; concurrent authorized requests are outside this plan. Retain independent prepareServerBackup authorization. The check operation is sensitive even though it returns only password presence.
