# Plan 015: Verify integration TLS by default and remove credentials from debug logs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- firebase.js meshsms.js meshipkvm.js meshcentral.js meshcentral-config-schema.json webserver.js mpsserver.js db.js test/integration-tls.test.js test/credential-logging.test.js plans/015-tls-verification-and-credential-logging.md plans/README.md`
> Compare changed source against Current state before proceeding. Unexplained source mismatch is a STOP condition. Changes only to plan/index text are not source drift.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: Plan 001 (test harness)
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Several integrations disable TLS certificate verification while carrying credentials or notification data. Debug logs also copy authentication secrets and database dump command lines. Secure defaults and explicit integration-local exceptions prevent silent trust bypasses; redaction preserves diagnostics without exposing passwords. Existing self-signed deployments will need a CA bundle or an explicit insecure opt-out.

## Current state

Repository root: `/home/anderson/Desenvolvimento/oss/meshcentral`. Node >=20 is declared at `package.json:58-60`; there are no baseline test/build/lint scripts. Plan 001 provides `npm test`, `npm run check`, and `test/helpers/fake-parent.js`. Follow CommonJS, callbacks, four-space indentation, and single-quoted new server strings, as in `meshsms.js:151-155`.

Configuration readers and TLS sites:

- `firebase.js:155,173,189` constructs the relay using the existing `parent.config.firebaserelay` object:

```javascript
module.exports.CreateFirebaseRelay = function (parent, url, key) {
```
```javascript
if (parent.config.firebaserelay && (parent.config.firebaserelay.log === true)) {
```
```javascript
obj.wsclient = new WebSocket(relayUrl.href + (key ? ('?key=' + key) : ''), { rejectUnauthorized: false })
```

- `meshsms.js:55` reads `parent.config.sms.provider`. The URL provider at `meshsms.js:153` builds:

```javascript
const options = { hostname: sms.hostname, port: sms.port ? sms.port : 443, path: sms.pathname + sms.search, method: 'GET', rejectUnauthorized: false };
```

- `meshipkvm.js:67-85` reads appliance location and credentials from `mesh.kvm`, then calls `CreateRaritanKX3Manager(obj, host, port, mesh.kvm.user, mesh.kvm.pass)` or `CreateWebPowerSwitch` with the same arguments. The owning domain is `mesh._id.split('/')[1]`. Global configuration remains on the outer `parent.config` object.
- `meshipkvm.js:395,423,585,898` each set `rejectUnauthorized: false` and `checkServerIdentity: onCheckServerIdentity`. The hooks at lines 347-349 and 794-796 are not pins:

```javascript
function onCheckServerIdentity(cert) {
    console.log('TODO: Certificate Check');
}
```

- `meshipkvm.js:662-665` creates the appliance websocket options:

```javascript
const options = {
    rejectUnauthorized: false,
    servername: 'raritan', // We set this to remove the IP address warning from NodeJS.
    headers: { Cookie: 'pp_session_id=' + obj.authCookie + '; view_length=32' }
};
```

- `meshipkvm.js:1041-1045` is a DIFFERENT trust target: the internal MeshCentral websocket, not the appliance:

```javascript
const options = { rejectUnauthorized: false };
const protocol = (parent.parent.args.tlsoffload) ? 'ws' : 'wss';
var domainadd = '';
if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
```

The following URL connects to `localhost` at the MeshCentral port. It includes an authentication cookie; do not reproduce actual URLs or cookies in test logs. `domain` comes from `parent.parent.config.domains[domainid]` at line 1038. `meshcentral.js:1915,1924` exposes the server certificate name as `obj.certificates.CommonName` and optional domain name as `obj.config.domains[i].dns`.

- `meshcentral-config-schema.json:1507-1511` currently declares domain `ipkvm` as boolean, default false. `meshcentral.js:2312` enables managers only for true:

```javascript
for (var i in obj.config.domains) { if (obj.config.domains[i].ipkvm == true) { ipKvmSupport = true; } }
```

- Schema root properties begin at `meshcentral-config-schema.json:10`; no `firebaserelay` property is declared. SMS URL configuration is the object variant at lines 4669-4687 with `provider: 'url'` and `url` properties. Add TLS keys there, not to SDK providers.

Credential logging sites:

- `webserver.js:5762,5766` logs Intel AMT passwords. The first call is:

```javascript
parent.debug('webrelaydata', 'INTERCEPTOR1', { host: node.host, port: port, user: node.intelamt.user, pass: node.intelamt.pass });
```

Line 5763 passes real credentials to `CreateHttpInterceptor`; line 5767 does likewise for `CreateRedirInterceptor`. Those authentication arguments must remain unchanged.
- `mpsserver.js:616,624,631,650,659` logs the APF password. Examples:

```javascript
parent.debug('mpscmd', '--> USERAUTH_REQUEST user=' + username + ', service=' + serviceName + ', method=' + methodName + ', password=' + password);
parent.debug('mps', 'Incorrect password', username, password);
```

Line 615 also contains a commented password log; redact that example rather than leaving a dangerous copy-paste recipe.
- `db.js:3718,3733,3760` prints entire dump commands:

```javascript
parent.debug('backup','Mongodump cmd: ' + cmd);
parent.debug('backup','Maria/MySQLdump cmd: ' + cmd);
parent.debug('backup','Postgresqldump cmd: ' + cmd);
```

PostgreSQL command construction at lines 3756-3759 includes encoded DB user/password. Error callbacks at lines 3723,3739,3765 stringify `error` or `error.message`; child-process errors may embed the same command. The catch at line 3771 prints `ex` and `ex.message` to a server warning.

## Commands you will need

Run from repository root. Do not install dependencies for this plan.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const s=require('./package.json').scripts; if(!s || !s.test || !s.check) process.exit(1)"` | Exit 0, otherwise STOP for Plan 001 |
| TLS tests | `node --test test/integration-tls.test.js` | All pass |
| Logging tests | `node --test test/credential-logging.test.js` | All pass |
| Schema syntax | `node -e "JSON.parse(require('node:fs').readFileSync('meshcentral-config-schema.json','utf8'))"` | Exit 0 |
| Syntax | `npm run check` | Exit 0 |
| Suite | `npm test` | All pass |
| Scope | `git diff --name-only` | Only listed paths |

## Scope

**In scope** (only files to modify):
- `firebase.js`, `meshsms.js`, `meshipkvm.js`, `meshcentral.js`
- `meshcentral-config-schema.json`
- `webserver.js`, `mpsserver.js`, `db.js`
- `test/integration-tls.test.js`, `test/credential-logging.test.js` (create)
- `plans/015-tls-verification-and-credential-logging.md` (operator migration notes and results)
- `plans/README.md` (status)

**Out of scope**:
- `meshctrl.js:1381`: its connection pins identity through `checkServerIdentity`; do not change it.
- Other TLS clients, appliance credential storage, database dump invocation semantics, SDK SMS providers, and broad logging refactors.
- Real production config files, credential values, deployment restarts, or global `NODE_TLS_REJECT_UNAUTHORIZED` changes.

## Git workflow

- Branch: `advisor/015-tls-verification-and-credential-logging`.
- Use logical commits such as `security: verify integration TLS by default` and `security: redact authentication and backup logs`.
- Preserve unrelated work. Do not push/open a PR without instruction.

## Steps

### Step 1: Define integration-local configuration without weakening defaults

Add optional `tlsverify` (boolean, default true) and `ca` (string PEM file path) to:
1. Root `firebaserelay` object. Add its existing `url`, `key`, and `log` fields to the schema alongside the new fields, since this object currently lacks a schema definition.
2. The SMS `provider: 'url'` schema variant.
3. Domain `ipkvm`: change its schema to accept either the existing boolean or an object with `tlsverify` and `ca`. Preserve boolean false/default and boolean true. An object enables IP KVM. Update the one enable check in `meshcentral.js:2312` to accept true or a non-null object, not arbitrary truthy strings.

Use `config.tlsverify !== false`; missing config, true, null, or a non-boolean value must never disable verification. Resolve a relative `ca` against `parent.datapath` (the MeshCentral data directory), leave an absolute path absolute, and read the PEM once when initializing that integration/manager. Do not synchronously read it per request. Invalid/missing configured CA files must fail that integration closed with a generic path/configuration diagnostic, not retry with verification disabled. Do not log PEM contents.

Document in schema descriptions and this plan: the CA bundle can contain several PEM certificates; `tlsverify: false` disables identity protection only for that integration. The IP KVM bundle must trust the appliance and, for routed access, the MeshCentral loopback endpoint. Existing self-signed installs must configure trust before deploying, or explicitly accept the opt-out risk.

Create `test/integration-tls.test.js` with `node:test` and `node:assert/strict`. Add schema-shape tests and fake configuration cases for unset, true, false, relative CA, absolute CA, and unreadable CA. Use temporary directories cleaned by test teardown; no real config.

**Verify**: `node --test test/integration-tls.test.js` and the schema syntax command → exit 0.

### Step 2: Apply options to Firebase relay and URL SMS

Read `parent.config.firebaserelay || {}` in `CreateFirebaseRelay` and `parent.config.sms` in `CreateMeshSMS`. Construct their TLS options once, using the policy above. Replace the explicit false at Firebase line 189 and SMS line 153. Leave HTTP behavior and SDK providers unchanged. Preserve existing request error callbacks/reconnect behavior; an invalid CA must not start the connection.

In tests, intercept the `ws` constructor and `https.request` with scoped module fakes, restored after each test. Follow Plan 001's fake-parent pattern. Assert passed `rejectUnauthorized`, PEM bytes in `ca`, and that no request is made on CA-load failure. Do not merely test a duplicate options object inside the test.

**Verify**: `node --test test/integration-tls.test.js` → Firebase and SMS runtime option cases pass, including default true and explicit false.

### Step 3: Apply appliance and loopback TLS with the correct peer identity

In `startManagement`, obtain the domain `ipkvm` object (boolean true means empty options). Pass the resolved policy to both manager factories and onward to `CreateMiniRouter`; update both local call sites. Keep factory ownership inside `meshipkvm.js`.

At all six TLS sites (395,423,585,663,898,1041), apply verified defaults and the CA bundle. Replace both placeholder `onCheckServerIdentity` functions with actual identity checks using `require('tls').checkServerIdentity(expectedHost, cert)`, returning its error. The Node callback signature is `(hostname, cert)`, not the existing single `cert` argument. For appliance HTTPS/WSS, expectedHost is the original appliance hostname, even when the TCP connection uses the local router. Remove hard-coded `servername: 'raritan'`; supply the original DNS hostname for SNI, omitting SNI for IP literals. Keep the explicit built-in identity check for IP SAN verification and routed connections.

For MiniRouter's MeshCentral connection, expectedHost is `domain.dns || parent.parent.certificates.CommonName`, not the appliance host or `localhost`. Keep the actual TCP URL local. Set TLS SNI and hostname checking for that server identity, using the integration CA bundle if provided. Do not reuse the appliance identity callback for this hop. If `tlsoffload` selects plain `ws`, keep that existing transport behavior.

Use mocked constructors to cover both appliance models, direct and routed HTTPS, appliance WSS, and loopback WSS. Assert every connection receives the same verification policy but the correct expected hostname. Test the callback against a matching and mismatched certificate object using Node's `tls.checkServerIdentity`, and assert mismatch returns an Error. Verify the local CA is never interpreted as an opt-out. Add a source assertion that neither placeholder certificate hook nor the literal `servername: 'raritan'` remains.

**Verify**: `node --test test/integration-tls.test.js` → all six sites, both managers, routed identity, and loopback identity cases pass. `npm run check` → exit 0.

### Step 4: Redact authentication logs without modifying authentication

In the two `webrelaydata` debug objects, change only `pass` to `'***'`. Leave real credentials passed to interceptors untouched. In the five active MPS password logs and the commented example, replace password output with the literal `'***'`; preserve username and useful failure reason. Authentication must still receive the original password/cookie.

Create `test/credential-logging.test.js`. Use sentinel fake passwords and captured debug calls to prove the sentinel never reaches a log while the interceptor/auth decoder receives it. Also add narrowly scoped source guards for the five MPS debug calls if executing the parser requires excessive setup. Source guards supplement, not replace, a runtime credential-forwarding check.

**Verify**: `node --test test/credential-logging.test.js` → sentinel absent from captured logs; authentication input unchanged.

### Step 5: Log dump executable names, not command lines or command-bearing errors

Replace backup command debug text with fixed executable labels (`mongodump`, `mysqldump`, `pg_dump`) only. Do not parse the shell command to redact it; passwords may be escaped or embedded in URIs. Leave `cmd` passed to `child_process.exec` unchanged.

For the three exec error callbacks, retain failure flags, callback sequencing, and a generic database/executable failure message. Do not log `error`, `error.message`, `error.cmd`, stdout, or stderr. If an exit code is useful, include it only when it is a number. Apply the same safe generic-message rule to the encompassing catch/server warning because it may carry command details. Do not change SQLite SQL logging or implement a new dump runner.

Extend tests with fake `exec` errors whose `message`, `cmd`, and stderr contain sentinel credentials, including URL-encoded values. Capture console/debug/server-warning sinks. Assert no sentinel or command arguments are logged, executable names remain, the command received by exec is unchanged, `BACKUPFAIL_DBDUMP` is set on failure, and `createBackupfile` continues as before.

**Verify**: `node --test test/credential-logging.test.js` → all redaction and failure-path tests pass. `npm test && npm run check` → exit 0.

### Step 6: Record migration and completion

Record the accepted configuration locations, relative-path semantics, and self-signed compatibility warning in this plan. Schema descriptions serve as the operator-facing configuration documentation. With a development appliance/server, optionally test trusted CA success, untrusted CA refusal, hostname mismatch refusal, and explicit opt-out success. No live appliance is required to complete automated gates; record unavailable manual validation explicitly. Update the index status, or record completion here if the index is absent.

**Verify**: `git diff --name-only` → only Scope paths. `node --test test/integration-tls.test.js test/credential-logging.test.js` → all pass.

## Test plan

Use `node:test`, `node:assert/strict`, and Plan 001's fake-parent approach. No external TLS endpoint or production credentials. Test default verification, explicit false, custom CA bytes, missing CA fail-closed, and correct hostname verification on direct/routed/loopback paths. Cover schema backward compatibility for boolean `ipkvm` and new object enablement. Capture actual module option construction with fakes rather than copying the desired code into tests.

Logging tests must cover success and error sinks, both interceptor modes, all APF logging call sites, and each command-building backup backend. Fake errors must contain synthetic secrets so tests detect secondary leaks through error serialization. Keep test output itself free of sentinel command contents on failure.

## Done criteria

- [ ] Both new test files pass; `npm test` and `npm run check` exit 0.
- [ ] All eight selected TLS connections (one Firebase, one SMS, six IP KVM) verify by default.
- [ ] Each integration accepts only explicit boolean false as a verification opt-out, and supports PEM CA paths.
- [ ] Appliance and loopback hostname checks target different, correct identities.
- [ ] No selected log includes passwords, command arguments, or command-bearing error strings.
- [ ] Real credentials still reach authentication and backup subprocess execution unchanged.
- [ ] Schema documentation and migration notes are present; manual-test availability is recorded.
- [ ] Only Scope paths changed; index row updated or completion recorded here.

## STOP conditions

- Plan 001 has not supplied `npm test`/`npm run check`.
- A source excerpt has unexplained drift, or any selected TLS connection has a real certificate pin not described here.
- Passing policy to a manager requires changing an external/public caller rather than the local factories shown here.
- Correct loopback server identity cannot be obtained from the existing domain/certificate fields; do not silently use `localhost` or bypass identity checking.
- A test needs production credentials or a real external service to pass; use fakes instead, and report if impossible within scope.
- A verification fails twice after a reasonable fix, or implementation requires an out-of-scope source change.
- Missing documentation files or no live server/appliance are not STOP conditions.

## Maintenance notes

Review the two TLS hops separately. A configured CA is not hostname verification, and a hostname callback that returns nothing can bypass identity checking. The insecure escape hatch is intentionally local and explicit; never fall back to it after errors. Backup error objects are as sensitive as command lines. A wider logging/TLS audit is deferred; this plan fixes only the listed sites and does not claim all repository logs are safe.
