# Plan 012: Contain plugin extraction and load only completed HTTPS downloads

> **Executor instructions**: Follow each step and run its verification command before proceeding. Stop and report on a STOP condition; do not improvise. Update this plan's row in `plans/README.md` unless the reviewer owns the index. If the index is absent, skip and note it.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- pluginHandler.js test/plugin-install.test.js plans/012-plugin-install-path-containment.md plans/README.md`
> Compare changed source against Current state before proceeding. Plan 001's test infrastructure is expected; changed installation behavior requires reconciliation.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-test-baseline.md`
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Plugin installation turns downloaded archive paths into filesystem writes and then executes downloaded JavaScript. Unsafe entry names or plugin identifiers can escape the plugin directory, including during removal. Unrestricted redirects weaken the download boundary, and loading before writable streams finish can execute incomplete installations.

## Current state

`pluginHandler.js` exports `pluginHandler(parent)` at line 24. The object exposes `fs`, `path`, and `pluginPath`; the latter is `parent.path.join(parent.datapath, 'plugins')` (lines 27-34). Use these existing boundaries in tests rather than adding dependency-injection infrastructure.

```js
// pluginHandler.js:227-229
    typeof conf.name == 'string'
    && typeof conf.shortName == 'string'
    && typeof conf.version == 'string'
// pluginHandler.js:444-446
if (response.headers.location) {
    file.close(() => obj.fs.unlink(fileName, () => {}));
    return obj.installPlugin(id, version_only, response.headers.location, func);
// pluginHandler.js:463-464
let pluginPath = obj.parent.path.join(obj.pluginPath, plugin.shortName);
let pathReg = new RegExp(/(.*?\/)/);
// pluginHandler.js:466
let filePath = obj.parent.path.join(pluginPath, entry.fileName.replace(pathReg, '')); // remove top level dir
```

`installPlugin` selects `downloadUrl`, `version_only.url`, or `force_url`, then accepts HTTP or HTTPS (`pluginHandler.js:423-437`). Its request currently drops the query string (`path: q.pathname`). Preserve URL query parameters when constructing the validated request.

```js
// pluginHandler.js:475-481
readStream.on('end', function () { zipfile.readEntry(); });
if (process.platform == 'win32') {
    readStream.pipe(obj.fs.createWriteStream(filePath));
} else {
    var fileMode = (entry.externalFileAttributes >> 16) & 0x0fff;
    if( fileMode <= 0 ) fileMode = 0o644;
    readStream.pipe(obj.fs.createWriteStream(filePath, { mode: fileMode }));
}
// pluginHandler.js:486-488
zipfile.on('end', function () {
    setTimeout(function () {
        try { obj.fs.unlinkSync(fileName); } catch (ex) { }
// pluginHandler.js:495
obj.plugins[plugin.shortName] = require(obj.pluginPath + '/' + plugin.shortName + '/' + plugin.shortName + '.js')[plugin.shortName](obj);
// pluginHandler.js:579-582
let pluginPath = obj.parent.path.join(obj.pluginPath, plugin.shortName);
if (obj.fs.existsSync(pluginPath)) {
    try {
        obj.fs.rmSync(pluginPath, { recursive: true, force: true });
```

The deletion is Node's `fs.rmSync`, not a shell `rm -rf`. Do not invent a shell-command fix. Startup also loads database names and manual-list names from paths (`pluginHandler.js:38-62`), so identifier validation must cover existing records, not only incoming config.

Use CommonJS, callback style, four spaces and single quotes. Match existing `func(null)` completion at `pluginHandler.js:490-492`; failures should invoke `func(error)` once without reporting success. `package.json:56` already includes `yauzl`; add no dependencies. Node >=20.19 is the working baseline. Plan 001 supplies tests; none existed at the planned commit.

## Commands you will need

Run from `/home/anderson/Desenvolvimento/oss/meshcentral`.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "if (!require('./package.json').scripts?.test) process.exit(1)"` | Exit 0; otherwise STOP |
| Syntax | `node -c pluginHandler.js` | Exit 0 |
| Focused tests | `node --test test/plugin-install.test.js` | All pass |
| Full tests | `npm test` | All pass |
| Scope | `git diff --name-only` | Only Scope paths changed |

## Scope

**In scope**:
- `pluginHandler.js`
- `test/plugin-install.test.js` (create)
- `plans/012-plugin-install-path-containment.md` (completion evidence)
- `plans/README.md` (status only, if present)

**Out of scope**: pre-existing filesystem symlinks and TOCTOU protection, sandboxing trusted plugins, atomic installation/rollback, zip bombs and size quotas, plugin npm support, config/version-fetch transport, proxy redesign, external plugin repositories, new dependencies. The containment guarantee is lexical only.

## Git workflow

- Branch: `advisor/012-plugin-install-path-containment`.
- Preserve unrelated user edits.
- Logical commit: `security: contain plugin installation paths`; add a real `(#NNNN)` issue suffix only when supplied.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Establish testable path and identifier rules

STOP if `npm test` is absent. Add `test/plugin-install.test.js` with `const { test } = require('node:test'); const assert = require('node:assert');` and Plan 001's conventions.

Add a small `safePluginEntryPath(root, name)` function in `pluginHandler.js`, exported as a named helper for direct testing while preserving `module.exports.pluginHandler`. Return an absolute contained path, or throw an Error. ZIP names use forward slashes: reject NUL, backslashes, POSIX absolute paths, Windows drive/UNC paths, and any `..` component before stripping anything. Preserve current archive layout semantics by removing exactly one leading directory component when a slash exists. A wrapper-directory entry such as `repo/` maps to the root and is skipped as a directory; a file mapping to the root must be rejected by the extraction caller. Use `path.resolve(root, relativeName)` and `path.relative(resolvedRoot, candidate)`; reject `..`, a relative result beginning with `..` plus the platform separator, or an absolute relative result. Never use a plain string prefix test. Allow ordinary nested files and single root-level files.

Define one identifier predicate requiring a string matching `/^[a-z0-9_-]{1,64}$/i`. Use it in `isValidConfig`, at install/remove entry after the database record is returned, and before startup database/manual-list paths are used. Invalid existing names must not trigger a write, require, or deletion. Return an error for install/remove; skip invalid startup names with a diagnostic. Do not silently sanitize names into a different plugin identity. Guard malformed config objects before dereferencing `conf.repository` so invalid input returns false.

**Verify**: `node -c pluginHandler.js && node --test test/plugin-install.test.js` → syntax passes; path/name tests pass for normal nested paths, wrapper directory, root file, traversal, absolute/drive/UNC names, backslashes, NUL, empty/65-character/invalid identifiers and valid mixed-case identifiers.

### Step 2: Enforce extraction and deletion boundaries

Route every archive entry through the helper before `mkdirSync` or `createWriteStream`. Reject symlink entries when `((entry.externalFileAttributes >>> 16) & 0xF000) === 0xA000`, even if the name looks safe. Preserve existing regular-file permission behavior. Validate `plugin.shortName` before calculating its directory and before starting a download. Use the same validated identifier for removal and startup loads.

Handle invalid entries by aborting extraction, closing the archive, destroying active streams, and failing the callback once. Do not set installed status, run `require`, or call plugin startup on failure. Remove the temporary archive when resources have closed; do not recursively delete an existing plugin installation as error cleanup. Do not claim rollback of files already extracted.

**Verify**: `node --test test/plugin-install.test.js` → traversal and symlink fixtures produce one failure callback, zero outside-root writes, zero plugin loads; invalid removal identifiers produce zero `rmSync` and `deletePlugin` calls.

### Step 3: Constrain installation download URLs

Before opening the temporary file/request, parse the selected initial URL and require `https:`. Preserve the public `installPlugin(id, version_only, force_url, func)` call shape. Replace recursive public-method redirection with a local request function carrying the initial URL and a redirect count. Resolve a Location with `new URL(location, currentUrl)`. Require HTTPS and the same `.host` as the original URL (hostname plus effective port); reject cross-host and downgrade redirects before making the next request. Use a fixed maximum of five redirects to terminate same-host cycles. Follow only redirect statuses; handle other non-success responses as failure. Include `pathname + search` in request options and preserve existing configured proxy behavior. Drain/destroy redirected responses and close old resources before reuse.

Same-host is deliberately strict: an HTTPS URL on a code-hosting site that redirects to a separate archive host will now fail. Use the final HTTPS archive-host URL as the configured URL; do not add a permissive host allowlist.

**Verify**: `node --test test/plugin-install.test.js` → HTTPS success, same-host relative redirect and query preservation pass; HTTP initial URLs, HTTPS-to-HTTP, cross-host/port redirects, malformed Location, and redirect loops fail without issuing a disallowed request.

### Step 4: Wait for every writable stream before loading

Track `pendingWrites`, `zipEnded`, `failed`, and a one-shot finalization flag in this installation operation. Increment pending writes before piping; attach destination `finish` and both source/destination `error` listeners first. Decrement only on successful destination `finish`, never on source `end`. Source `end` may continue lazy entry reading, but ZIP `end` only sets `zipEnded`. Finalize exactly once when `zipEnded && pendingWrites === 0 && !failed`.

Remove the `setTimeout` completion heuristic. Only the success gate may load the plugin, read its completed config, update installation status/version and invoke completion. Preserve startup/update behavior, but never report successful installation after a read/write/archive error. Keep errors bounded to this installation; do not introduce a job framework.

**Verify**: `node --test test/plugin-install.test.js` → after ZIP end with a withheld writable `finish`, no require/startup/status-success occurs; releasing all finishes permits exactly one completion. A write error after ZIP end never loads the plugin or reports success.

### Step 5: Record results and compatibility constraint

Document the HTTPS/same-host restriction and lexical-only guarantee in completion notes here; update the index if present. Run the full suite. A live plugin repository/server is optional; skip and note it when absent.

**Verify**: `npm test && git diff --name-only` → all tests pass and only Scope files changed.

## Test plan

All tests belong in `test/plugin-install.test.js`. Start from Plan 001's Node test/fake-parent conventions. Construct the public factory with `parent.path = require('path')`, temporary `datapath`, `config.settings.plugins.list = []`, `db.getPlugin`, `db.setPluginStatus`, `db.updatePlugin`, `db.deletePlugin`, and `updateMeshCore` spies. Setting an empty list avoids startup DB loading in install-focused tests; test startup validation separately.

Use `fs.mkdtempSync` and remove only test-owned temporary directories in teardown. Stub `https.get` and `yauzl.open` with EventEmitter/stream fakes inside non-concurrent tests, restore originals with test teardown, and never access the network. `obj.fs` is already exposed; use it to inject delayed writable streams. A tiny generated plugin fixture can export a factory that records startup on the fake parent; this observes real `require` without executing third-party code. Source stream `end` and destination `finish` must be separately controllable; otherwise the race test is meaningless. Clear fixture require-cache entries during teardown.

Cover every named path/name/download case, symlink mode, directory entry, nested files, installation callback once, archive/read/write errors, delayed finish after ZIP end, and successful complete loading. Test both Windows-style and POSIX malicious names even on Linux. `node --test test/plugin-install.test.js` and `npm test` must pass without network access.

## Done criteria

- [ ] Syntax and all focused/full tests pass.
- [ ] Unsafe names, traversal and ZIP symlink entries cannot reach filesystem mutation or require.
- [ ] Removal rejects invalid names before `rmSync` and database deletion.
- [ ] Every install request is HTTPS and every redirect preserves the initial host/port.
- [ ] ZIP end alone cannot load a plugin; all destination finishes are required.
- [ ] Failures do not mark installation successful or invoke completion more than once.
- [ ] No dependencies or files outside Scope changed; completion notes/index updated or missing index noted.

## STOP conditions

- Plan 001 has not provided `npm test`.
- Drift changes the install API, archive layout, or stream ownership described here.
- A required supported plugin uses a different archive layout that cannot satisfy single-wrapper removal; report the concrete archive layout instead of guessing.
- Maintainers require cross-host redirects to continue working: obtain a separate explicit policy decision rather than silently weakening same-host enforcement.
- Fixing the stream lifecycle requires changes outside Scope, or verification fails twice after a reasonable correction.

## Maintenance notes

Lexical containment does not defend against an existing directory symlink or a concurrent filesystem attacker. Plugin JavaScript still executes with server privileges; this is not a sandbox. Review Windows separators, the pre-strip traversal check, same-host comparison, and the finish/error race. Partial extraction rollback and stronger filesystem containment remain explicitly deferred. No live download is necessary to establish these unit-test guarantees.
