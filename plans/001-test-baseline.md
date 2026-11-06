# Plan 001: Establish a native test and syntax baseline

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions section occurs, stop and report; do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index. If that index or another documentation file is absent, skip its update and note the omission; absence is not a STOP.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- package.json test/common.test.js test/db-nedb.test.js test/helpers/fake-parent.js .github/workflows/test.yml readme.md plans/README.md`
> Compare changed files against the Current state excerpts. Expected changes from plan 001 are allowed; unexplained changes to the affected logic require STOP and review.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

The project has no npm test or syntax gate. Native tests create a cheap safety net for subsequent authorization fixes without introducing a framework. Real NeDB contract tests also expose callback and resource-lifecycle mistakes before production.

## Current state

All paths are relative to `/home/anderson/Desenvolvimento/oss/meshcentral`. Run commands from that directory. This is CommonJS and callback-based code. Match four-space indentation, single quotes, and existing compact guards; do not reformat surrounding code.

`package.json:39-40` already supplies the database dependency:
```json
"dependencies": {
  "@seald-io/nedb": "4.1.2",
```
`package.json:58-60` declares `"node": ">=20.0.0"`; the package has no scripts block. Use Node >=20.19 for the locked dependency tree. Do not add a test framework dependency.

`common.js:190-192` exports `validateString`, `validateInt`, and `validateArray`. `validateInt` checks `typeof int == 'number'` and range comparisons, not integerness. Preserve this behavior in baseline tests. `common.js:25,29` supplies unsigned big-endian `ReadInt` and `IntToStr`. `common.js:37` is:
```js
module.exports.joinPath = function (base, path_) { return path.isAbsolute(path_) ? path_ : path.join(base, path_); }
```
`common.js:141` escapes `&<>"'` plus backtick, equals, slash. `common.js:35` rejects filenames beginning with a dot, reserved DOS names, and slash/backslash characters. These compact CommonJS exports are the style exemplar.

`meshcentral.js:1013-1016` shows that `CreateDB` takes a parent and calls back with the DB, **not `(err, db)`**:
```js
require('./db.js').CreateDB(obj,
    function (db) {
        obj.db = db;
        obj.db.SetupDatabase(function (dbversion) {
```
`db.js:3312` confirms `func(obj);`. `meshcentral.js:4200-4206` resolves data files using `obj.path.join(obj.datapath, filename)` unless config overrides them. The test must never use real config overrides.

`db.js:1377-1384` chooses NeDB when all backend selectors are absent and constructs `{ filename: parent.getConfigFilePath('meshcentral.db'), autoload: true }`. `db.js:1410,1419,1427,1438` each calls `setAutocompactionInterval(86400000)`. The four stores are `file`, `eventsfile`, `powerfile`, `serverstatsfile`; plugins are disabled and no SMBIOS store is created. `db.js:3158` disposal deletes object members; it does not explicitly stop these timers.

`db.js:3090-3094` uses `file.update(..., { upsert: true }, func)` for Set. `db.js:3111-3113` returns `func(err, performTypedRecordDecrypt(docs))`. `db.js:3146,3150` implement GetAllType and Remove through NeDB callbacks. `db.js:3161` is:
```js
obj.isMaxType = function (max, type, domainid, func) { if (max == null) { func(false); } else { obj.file.count({ type: type, domain: domainid }, function (err, count) { func((err != null) || (count > max), count); }); } }
```
The comparison is `count > max`, not `>=`. This is a characterization baseline, not a behavior change.

`readme.md:26-29` already has `## Documentation`; add a short testing section nearby.

Exact root JavaScript check inventory at the planning commit (49 files; `pkcs7-modified.js` is the sole excluded root file):
```text
agentbuilds.js
agenttypes.js
amt-ider.js
amtevents.js
amtmanager.js
amtprovisioningserver.js
amtscanner.js
amtscript.js
apprelays.js
authenticode.js
backup.js
certoperations.js
common.js
crowdsec.js
db.js
exeHandler.js
firebase.js
interceptor.js
letsencrypt.js
macosinstaller.js
mcrec.js
meshaccelerator.js
meshagent.js
meshbot.js
meshcentral.js
meshctrl.js
meshdesktopmultiplex.js
meshdevicefile.js
meshipkvm.js
meshmail.js
meshmessaging.js
meshrelay.js
meshscanner.js
meshsms.js
meshuser.js
migrate-volume-info.js
monitoring.js
mpsserver.js
mqttbroker.js
multiserver.js
pass.js
pluginHandler.js
redirserver.js
swarmserver.js
taskmanager.js
webauthn.js
webrelayserver.js
webserver.js
winservice.js
```

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
- `package.json`
- `test/common.test.js` (create)
- `test/db-nedb.test.js` (create)
- `test/helpers/fake-parent.js` (create)
- `.github/workflows/test.yml` (create)
- `readme.md`
- `plans/README.md`

**Out of scope**:
- Production configuration, credentials, databases, network services, and deployment.
- Dependency upgrades, schema changes, unrelated formatting, and unrelated security findings.
- Existing public response shapes except the explicitly denied operations below.

## Git workflow

- Branch: `advisor/001-test-baseline`.
- Preserve unrelated local work. Do not reset or clean the checkout.
- Use a focused commit with the repository's style, such as `fix: establish a native test and syntax baseline`. Add `(#NNNN)` only when a real issue number exists.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Establish native tests and the fake parents

Create `test/helpers/fake-parent.js` with two explicit factories: `createDbParent(datapath)` and asynchronous `createMeshUserFixture(options)`. Export these named functions through CommonJS. Keep captures on the returned fixture; do not simulate authorization decisions globally. Follow the WebSocket contract above; add one fixture readiness/cleanup smoke test in `test/common.test.js` so this shared helper is exercised immediately.

For `createDbParent`, required fields are `datapath`, `args: {}`, `config: { settings: { plugins: false }, domains: {} }`, and `getConfigFilePath(name)` using `path.join(datapath, name)`. Include `crypto: require('node:crypto')` and a no-op `debug` for database error reporting/encryption compatibility. Never pass SQL selectors or encryption keys. These fields cover `db.js:40-41,65,74,722-737,1384-1449`; no server startup is necessary.

Add `scripts.test = "node --test test/"`. Create `test/common.test.js` using `const { test } = require('node:test'); const assert = require('node:assert');` and `require('../common.js')`. Test all eight exports named above (IntToStr and ReadInt count separately, with a shared round-trip table).

**Verify**: `node --test test/common.test.js` → all helper cases and fixture smoke test pass, no initialization errors, process exits naturally.

### Step 2: Characterize real NeDB callbacks with isolated disk state

Create `test/db-nedb.test.js`. Use `fs.mkdtempSync(path.join(os.tmpdir(), 'meshcentral-test-'))` per test fixture, then `await new Promise(resolve => require('../db.js').CreateDB(parent, resolve))`. The root-relative equivalent is `require('./db.js').CreateDB(parent, cb)`; do not mistakenly import `test/db.js`. Do not rely on assigning CreateDB's return value inside its callback: that callback can run before the function returns.

Register cleanup before assertions. Capture the four store objects. Wait for a callback-based `find({}, cb)` on every store before cleanup so initialization and queued operations have drained. Stop every autocompaction timer using the installed driver's `stopAutocompaction()` method; if exposed through `store.persistence`, call `store.persistence.stopAutocompaction()` instead. Check the installed driver API, not a guessed private timer property. Only then call `db.dispose()` and recursively remove this unique temporary directory in `finally`. Do not call `process.exit`, use forced test exits, or mock NeDB. No real data directory may be passed.

Await each Set/Get/Remove/GetAllType callback. Assert error-first callbacks have null/undefined errors; Get returns an array; missing IDs return `[]`; Set then overwrite keeps one row; Remove reports one removed row and a subsequent Get returns `[]`. Seed two `node` rows in domain `test`, another node in another domain, and a different type. GetAllType returns all nodes across domains and retains type. For `isMaxType`, capture arguments directly rather than using generic promisify: max null returns only `false`; max 2 returns `(false, 2)`; max 1 returns `(true, 2)`; no matching records with max 0 returns `(false, 0)`. Count exactly one callback per operation. Use synthetic IDs and no sensitive content.

**Verify**: `node --test test/db-nedb.test.js` → all callback-contract tests pass and the process exits without lingering compaction timers.

### Step 3: Add the maintained-file syntax gate and CI

Add `scripts.check` as a Node one-liner that uses `fs.readdirSync('.')` to select every root name ending `.js` except `pkcs7-modified.js`, adds `agents/meshcore.js`, `agents/meshcmd.js`, and every `.js` in `agents/modules_meshcore/`, sorts the list, and invokes `spawnSync(process.execPath, ['-c', file], { stdio: 'inherit' })` for each. Exit nonzero immediately on a spawn error or nonzero status. This should be a package script, not another new utility file. Use `JSON.stringify` when constructing the package.json string so quotes remain valid. The dynamic inventory must include the explicit root inventory above; never silently exclude more files to turn the gate green.

Create `.github/workflows/test.yml`: push and pull_request triggers, read-only contents permission, ubuntu-latest, matrix node `[20, 22]`, checkout, setup-node with npm cache, `npm ci`, `npm run check`, then `npm test`. No secrets, server, database service, coverage framework, lint tool, or deployment steps.

**Verify**: `npm run check && npm test` → exit 0; all root and specified agent JavaScript syntax passes, all tests pass. Workflow runs the same commands on both Node versions.

### Step 4: Document the baseline and finish

Add exactly three content lines near the existing Documentation section in `readme.md`: heading `## Tests`, a sentence saying Node >=20.19 and `npm ci` are required, and a sentence saying `npm test` runs native tests while `npm run check` checks maintained JavaScript syntax. Update the plan index row unless reviewer-owned; missing documentation is skip-and-note.

**Verify**: `git diff --check && npm test && npm run check` → no whitespace errors; both gates exit 0.


## Test plan

Eight common exports, one WebSocket fixture smoke case, and real NeDB Set/Get/Remove/GetAllType/isMaxType cases are required. Use Node native test/assert imports as shown. Cover boundaries, wrong types, empty arrays, absolute versus relative joinPath, HTML metacharacters, filenames such as `report.txt`, `.hidden`, `CON.txt`, `a/b`, and unsigned round trips for 0, 1, 0x80000000, 0xFFFFFFFF. `validateInt(1.5, 0, 2)` is currently true: characterize it, do not fix it. Each test owns its fixtures and closes resources. Run `npm test` twice consecutively; both runs must exit 0 without data leakage.

## Done criteria

- [ ] Eight named common exports have assertions, including unsigned integer boundaries.
- [ ] The NeDB suite uses only uniquely allocated temporary directories and proves documented callback shapes.
- [ ] All four NeDB compaction timers are stopped before disposal.
- [ ] The check script covers the exact 49 root files and requested agent files.
- [ ] CI has both Node 20 and 22 jobs and runs npm ci, check, and test.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` lists only the scoped files for this change; preserve pre-existing unrelated work.
- [ ] Update the index row, or note that the reviewer owns it or the file was absent.

## STOP conditions

- STOP if the installed NeDB driver offers neither a public store nor persistence stopAutocompaction method; report the API rather than forcing process exit.
- STOP if any proposed fixture path resolves outside its newly created temporary directory.
- STOP if the syntax inventory fails on another file: report the failing file, do not expand the exclusion list or edit production source.
- STOP if baseline assertions require changing production behavior; this plan only characterizes it.

A live server is not required. Skip live checks and note that limitation instead of stopping.

## Maintenance notes

Later plans depend on these scripts and fixtures. Preserve backend-specific callback signatures; do not pretend isMaxType is error-first. Keep check inventory dynamic. CI verifies syntax, not execution compatibility of agent runtimes. SQL backend integration is intentionally deferred; NeDB tests do not cover SQL.
