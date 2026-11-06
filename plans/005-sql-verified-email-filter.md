# Plan 005: Filter SQL verified-email lookups consistently

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions section occurs, stop and report; do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index. If that index or another documentation file is absent, skip its update and note the omission; absence is not a STOP.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- db.js common.js test/sql-verified-email-filter.test.js readme.md plans/README.md`
> Compare changed files against the Current state excerpts. Expected changes from plan 001 are allowed; unexplained changes to the affected logic require STOP and review.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-test-baseline.md
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

SQL verified-email lookups currently return unverified records indexed by email. Password reset and uniqueness checks trust this method’s name and contract. A shared JavaScript filter brings SQL backends in line with MongoDB and NeDB without migrations.

## Current state

All paths are relative to `/home/anderson/Desenvolvimento/oss/meshcentral`. Run commands from that directory. This is CommonJS and callback-based code. Match four-space indentation, single quotes, and existing compact guards; do not reformat surrounding code.

There are three SQL method definitions, not one shared definition. SQLite is `db.js:1769-1773`, PostgreSQL is `db.js:2332`, and the shared MariaDB/MySQL branch is `db.js:2596` (branch starts at `db.js:2535`). SQLite currently removes type before returning:
```js
obj.GetUserWithVerifiedEmail = function (domain, email, func) {
    sqlDbQuery('SELECT doc FROM main WHERE domain = $1 AND extra = $2', [domain, 'email/' + email], function (err, docs) {
        if (docs != null) { for (var i in docs) { delete docs[i].type; if (docs[i].links != null) { docs[i] = common.unEscapeLinksFieldName(docs[i]); } } }
        func(err, performTypedRecordDecrypt(docs));
    });
}
```
PostgreSQL (`db.js:2332`):
```js
obj.GetUserWithVerifiedEmail = function (domain, email, func) { sqlDbQuery('SELECT doc FROM main WHERE domain = $1 AND extra = $2', [domain, 'email/' + email], function (err, docs) { func(err, performTypedRecordDecrypt(docs)); }); }
```
MariaDB/MySQL (`db.js:2596`):
```js
obj.GetUserWithVerifiedEmail = function (domain, email, func) { sqlDbQuery('SELECT doc FROM main WHERE domain = ? AND extra = ?', [domain, 'email/' + email], function (err, docs) { func(err, performTypedRecordDecrypt(docs)); }); }
```
SQLite `db.js:1673,1681` and PostgreSQL `db.js:2278` populate extra from value.email without checking emailVerified:
```js
if (value.meshid) { extra = value.meshid; } else if (value.email) { extra = 'email/' + value.email; } else if (value.nodeid) { extra = value.nodeid; }
```
By contrast, MongoDB `db.js:2898` and NeDB/MongoJS `db.js:3149` query `{ type: 'user', domain: domain, email: email, emailVerified: true }`.

`webserver.js:1857-1858` treats any returned row as an already-verified email for account uniqueness. `webserver.js:2067-2075` calls GetUserWithVerifiedEmail for password resets and then removes special/locked accounts; it does not add a verification check. Fix the DB contract, not these consumers.

`db.js:1534` declares `function sqlDbQuery(query, args, func, debug)` inside CreateDB. It is not exported, so a direct stub is not feasible without module rewriting or a production injection seam. Use the explicitly permitted small common helper for deterministic characterization instead; do not build a mock SQL engine or add module-loader dependencies. `common.js:190-192` demonstrates compact exported predicate functions. `readme.md:26` is the Documentation heading.


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
- `db.js`
- `common.js`
- `test/sql-verified-email-filter.test.js` (create)
- `readme.md`
- `plans/README.md`

**Out of scope**:
- Production configuration, credentials, databases, network services, and deployment.
- Dependency upgrades, schema changes, unrelated formatting, and unrelated security findings.
- Existing public response shapes except the explicitly denied operations below.

## Git workflow

- Branch: `advisor/005-sql-verified-email-filter`.
- Preserve unrelated local work. Do not reset or clean the checkout.
- Use a focused commit with the repository's style, such as `security: filter sql verified-email lookups consistently`. Add `(#NNNN)` only when a real issue number exists.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add and test one pure shared predicate operation

In common.js next to the existing validation helpers, export `filterVerifiedEmailUsers(docs)`. Keep its entire behavior narrow:
```js
module.exports.filterVerifiedEmailUsers = function (docs) {
    if (docs == null) { return docs; }
    return docs.filter(function (doc) { return (doc.type == 'user') && (doc.emailVerified === true); });
};
```
This preserves null and undefined SQL error results rather than hiding them as an empty success. Valid query results are arrays of documents; do not coerce malformed result objects or truthy verification values. The helper must not mutate input objects, delete type, unescape links, or decrypt records.

Create `test/sql-verified-email-filter.test.js` with `const { test } = require('node:test'); const assert = require('node:assert');` and `require('../common.js')`. Use the baseline common.test.js as style pattern. Test strictly verified users, all rejected values and types, mixed ordering, empty list, null, undefined, same retained object identity, unchanged input array and properties. This is a helper characterization test, **not SQL integration coverage**.

**Verify**: `node --test test/sql-verified-email-filter.test.js && node -c common.js` → all characterization cases pass.

### Step 2: Apply filtering in all three SQL callbacks

SQLite: at the beginning of the GetUserWithVerifiedEmail query callback, before the loop that deletes docs[i].type, insert `docs = common.filterVerifiedEmailUsers(docs);`. Preserve the existing unEscapeLinksFieldName loop, type removal, decrypt call, and original error argument. Filtering after type deletion would incorrectly reject every verified user.

PostgreSQL and shared MariaDB/MySQL: apply the helper to docs before the existing performTypedRecordDecrypt call, keeping `func(err, ...)`. Do not delete type in those branches; preserve their existing response shapes. Use the same helper once in each SQL verified-email method. Do not apply it globally in sqlDbQuery and do not alter GetUserWithEmail. Keep domain/email parameterized SQL and the email index unchanged. No schema migration or data rewrite is needed.

Inspect all GetUserWithVerifiedEmail definitions with the command below. There must be three new helper uses in db.js: SQLite, PostgreSQL, and the shared MySQL/MariaDB branch. Other backend definitions keep their existing explicit emailVerified predicates.

**Verify**: `node -c db.js && node --test test/sql-verified-email-filter.test.js && rg -n 'filterVerifiedEmailUsers' db.js` → syntax and tests pass; exactly three matching adapter call sites appear, with SQLite filtering before type deletion.

### Step 3: Document coverage honestly and run full gates

Add one short statement near readme.md Documentation: verified-email lookup requires user records with emailVerified strictly true across database backends. Skip and note missing documentation. Update index if present and not reviewer-owned. In the change summary explicitly state that native tests characterize the shared predicate; no live SQL backend or email delivery was exercised. Do not claim NeDB tests validate SQL.

**Verify**: `npm test && npm run check && git diff --check` → all pass. Optional live SQLite/PostgreSQL/MySQL checks may be skipped and noted when servers/drivers are unavailable; do not install new production dependencies just for this plan.


## Test plan

Helper tests must retain `{ type: 'user', emailVerified: true }`; reject false, missing, null, 0, 1, and string 'true' flags; reject non-user and missing type even if emailVerified=true. Mixed input retains verified users in order without modifying any original record, including links. Null and undefined return unchanged; [] returns []. There must be a regression case demonstrating that filtering must occur before deleting type, with a comment explaining the SQLite ordering constraint. Check all three production call sites as a review gate; the helper suite alone cannot detect a missing call site. If an operator provides a disposable SQL setup, seed verified and unverified same-email users plus a non-user same-email row and assert only verified user IDs return, query error remains error-first, and SQLite retains its existing output transformation. No production DB, mail server, or account reset should be touched.

## Done criteria

- [ ] All three SQL GetUserWithVerifiedEmail implementations invoke the same strict filter.
- [ ] SQLite filters before deleting type and preserves its existing links/decryption transformation.
- [ ] Query parameters and error callback propagation remain unchanged.
- [ ] Helper cases cover strict boolean verification, document type, null results and nonmutation.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] `git diff --name-only` lists only the scoped files for this change; preserve pre-existing unrelated work.
- [ ] Update the index row, or note that the reviewer owns it or the file was absent.

## STOP conditions

- If `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` fails, STOP: plan 001 has not landed. Do not substitute ad hoc tests.
- STOP if SQL rows no longer expose type and emailVerified at the filtering point; locate the transformation and revise the plan rather than dropping the type check.
- STOP if performing the filter requires decrypting or changing schema to access these fields; this plan assumes their current document availability.
- STOP if a direct SQL stub requires exporting internals or patching module loaders; use the chosen common-helper route instead.
- STOP if any SQL callback starts swallowing query errors or converts null/undefined into successful empty results.

A live server is not required. Skip live checks and note that limitation instead of stopping.

## Maintenance notes

Three SQL definitions cover four engines: MariaDB and MySQL share one branch. Keep predicate centralized and ensure future adapters use the same contract. Backend output-shape normalization and real multi-engine integration tests are explicitly deferred. Filtering before SQLite projection is essential.
