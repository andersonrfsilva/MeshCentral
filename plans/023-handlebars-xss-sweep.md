# Plan 023: Classify and secure every server-string HTML sink in the three device views

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the STOP conditions occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer dispatched you and maintains the index.
>
> **Drift check (run first)**: `git diff --stat 4d8f043f..HEAD -- views/default.handlebars views/default3.handlebars views/default-mobile.handlebars test/xss-sweep-default.md test/xss-sweep.test.js plans/023-handlebars-xss-sweep.md plans/README.md`
> Compare changed target code with Current state before proceeding. A mismatch is a STOP condition. Plan 016 changes may need integration into this stack before starting; reconcile them explicitly rather than applying its old line numbers. Documentation-only changes are not source drift.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-test-baseline.md`, `plans/017-small-correctness-fixes.md`; retain/integrate `plans/016-xss-in-views-and-player.md` fixes
- **Category**: security
- **Planned at**: commit `4d8f043f`, 2026-11-05

## Why this matters

Plan 016 covered selected session-name, path, and player sites, not every sink in the three main views. Server-provided names, descriptions, messages, notes, and file names can become executable HTML when inserted unescaped. This plan is a complete, recorded source-to-sink sweep, not a fixed list of replacements or a claim that regex matching proves XSS absence.

## Current state

Repository: `/home/anderson/Desenvolvimento/oss/meshcentral`. Evidence was read from `/home/anderson/Desenvolvimento/oss/.wt/mc-017`, branch `advisor/017-small-correctness-fixes`, commit `4d8f043f`. Execute on the completed prerequisite stack. Do not assume the older main checkout contains the test harness or every executed branch.

The three `views/*.handlebars` files contain embedded browser JavaScript and intentional HTML construction. `plans/016-xss-in-views-and-player.md:25-50,92-98` scopes selected getUserName/path fixes and player metadata; this plan does not reopen the player or replace that work.

`views/default.handlebars:4143-4147` and `views/default3.handlebars:5046-5050` contain this candidate sink:

```javascript
case 'stopped': { // Server is stopping.
    // Disconnect
    autoReconnect = false;
    QH('p0span', message.msg);
    break;
}
```

This is evidence of direct insertion, not proof about the producer's trust or intended markup. Trace the `message.msg` producer during classification before changing the presentation contract.

An already-escaped example is `views/default.handlebars:5378`:

```javascript
if (x != '') { setDialogMode(2, "Sessions" + ' - ' + EscapeHtml(node.name), 1, null, x, 'SESSIONS-' + node._id); } else { setDialogMode(0); }
```

An indirect safe flow spans `views/default-mobile.handlebars:3612-3614,3668`:

```javascript
var name = EscapeHtml(node.name);
if (showRealNames == true && node.rname != null) name = EscapeHtml(node.rname);
if (name.length == 0) { name = '<i>' + "None" + '</i>'; }
```

```javascript
div.innerHTML = '<div>' + devNotify + '<div class="i' + icon + ' devList2"></div><div class=devList3><div class=devList4><b>' + name + '</b></div><div class=devList5>' + nodestate + '</div></div></div>';
```

Classify each interpolated value separately; this proves the name flow, not every other value in that expression.

Read-only helper definitions at `public/scripts/common-0.0.1.js:16-18,38` establish the APIs:

```javascript
function QV(x, y) { try { QS(x).display = (y ? '' : 'none'); } catch (x) { } }  // "Q" visible
function QA(x, y) { Q(x).innerHTML += y; }                                      // "Q" append
function QH(x, y) { Q(x).innerHTML = y; }                                       // "Q" html
```

```javascript
function EscapeHtml(x) { if (typeof x == 'string') return x.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); if (typeof x == 'boolean') return x; if (typeof x == 'number') return x; }
```

Important correction: `QV` controls visibility; it is not a text/value setter and cannot replace an HTML text sink. Use `Q(id).textContent = value` for plain text. Use an element's `.value` for input values. Preserve existing QV visibility calls independently.

Tests use CommonJS, `node:test`, `node:assert/strict`, four spaces, and single quotes. `test/small-correctness.test.js:7-19` imports filesystem/path helpers and reads repository files using `path.join(__dirname, '..')`. Follow that pattern. `package.json:39-41,62-64` defines `node --test test/`, `npm run check`, and Node >=20. The syntax script does not parse embedded Handlebars browser scripts.

## Commands you will need

Run from the executor worktree root. These inventory commands are starting points, not complete data-flow analysis.

| Purpose | Command | Expected on success |
|---|---|---|
| Default count | `grep -n 'innerHTML\|QH(' views/default.handlebars \| wc -l` | Record actual candidate-line count; zero is not expected |
| Alternate count | `grep -n 'innerHTML\|QH(' views/default3.handlebars \| wc -l` | Record actual candidate-line count |
| Mobile count | `grep -n 'innerHTML\|QH(' views/default-mobile.handlebars \| wc -l` | Record actual candidate-line count |
| Full sink inventory | `grep -nE 'innerHTML\|QH[[:space:]]*\(\|QA[[:space:]]*\(\|format[[:space:]]*\(' views/default.handlebars views/default3.handlebars views/default-mobile.handlebars` | Inventory includes all four forms |
| Source-field leads | `grep -nE '\.(name\|rname\|host\|desc\|realname\|email\|notes\|msg)\b\|events\[\|filetree\|chat' views/default.handlebars views/default3.handlebars views/default-mobile.handlebars` | Leads for alias and multiline tracing |
| Focused gate | `node --test test/xss-sweep.test.js` | All tests pass; zero known-bad shape matches |
| Full suite | `npm test` | All pass |
| Syntax baseline | `npm run check` | Exit 0; not a template parser |
| Scope | `git diff --name-only` | Only in-scope paths |

In the rendered table, `\|` escapes Markdown pipes. Shell commands use ordinary `|` for pipelines and regex alternation, retaining `\|` only for the basic-grep expressions in the first three rows. For copy-safe inventory, use the fenced commands in Step 1.

## Scope

**In scope**:
- `views/default.handlebars`
- `views/default3.handlebars`
- `views/default-mobile.handlebars`
- `test/xss-sweep-default.md` (create and commit the worksheet for all three views)
- `test/xss-sweep.test.js` (create)
- `plans/023-handlebars-xss-sweep.md` (execution/manual-check evidence)
- `plans/README.md` (this status row only)

**Out of scope**: shared helper implementation, other views including player, server-side schema/data changes, HTML sanitizer or browser dependencies, CSP changes, translations, generated/minified assets, and redesigning intentional rich-text features. Read producer/helper code outside Scope to classify values, but do not edit it.

## Git workflow

- Branch `advisor/023-handlebars-xss-sweep` from the prerequisite stack containing `4d8f043f`, preserving plan 016's fixes where integrated.
- Commit the worksheet with the fixes and regression tests. Use logical commits such as `fix: escape server strings across device views`; observed `4d8f043f` uses `test: regression cases for plan 017 small correctness fixes`.
- Do not push, open a PR, or publish security details without operator instruction.

## Steps

### Step 1: Enumerate sinks and trace every relevant value

Run these exact commands and record counts in `test/xss-sweep-default.md`:

```sh
grep -n 'innerHTML\|QH(' views/default.handlebars | wc -l
grep -n 'innerHTML\|QH(' views/default3.handlebars | wc -l
grep -n 'innerHTML\|QH(' views/default-mobile.handlebars | wc -l
grep -nE 'innerHTML|QH[[:space:]]*\(|QA[[:space:]]*\(|format[[:space:]]*\(' views/default.handlebars views/default3.handlebars views/default-mobile.handlebars
```

Walk every candidate in all three files, not only lines containing field names. Read entire multiline expressions and trace aliases, accumulated strings such as `x`, helper returns, format arguments, and their final destination. Also search the named fields independently to find source assignments separated from sinks. Include `innerHTML` assignments/appends, QH, QA, and format calls carrying any device name/rname/host/desc, user name/realname/email, mesh name/desc, notes, chat/msg, file names, or `events[].msg`. Treat remote-agent strings and stored strings as untrusted, even if only privileged users usually set them.

Use per-file worksheet sections with this minimum table, adding evidence and status columns:

```text
line | sink | source field | escaped? | evidence / context | remediation
```

Use one row per source-to-sink pair, not one row per long HTML expression. `escaped?` values: `yes`, `no`, or `n/a`. `yes` requires a cited EscapeHtml boundary or a textContent/value destination. `n/a` requires proof of no HTML interpretation (for example format output consumed only as text), numeric conversion, or a trusted constant, with precise producer/consumer evidence. Never label a server string n/a because it is internal or admin-controlled. Record candidate exclusions in a separate inventory table with file:line, sink form, and reason, so every grep candidate is accounted for. Include multiline or helper-mediated discoveries beyond grep's initial line inventory. STOP if any source or output context cannot be classified from code.

Add an inventory subtest in `test/xss-sweep.test.js`: enumerate the same candidate lines in the three files, require a worksheet classification or exclusion for every one, and require evidence for each n/a classification. Treat line numbers as post-edit positions and refresh them after edits. This is a coverage gate for the worksheet, not an automatic taint analyzer.

**Verify**: `node --test --test-name-pattern='worksheet inventory' test/xss-sweep.test.js` → every candidate has an explicit worksheet entry; no unclassified/unknown rows. Unsafe `no` rows may still exist at this stage.

### Step 2: Escape untrusted text at the final HTML boundary

For each `no` row, wrap only the untrusted string with `EscapeHtml()` or switch a plain-text destination to `.textContent`. For an input, assign `.value` after element creation instead of interpolating its value into HTML. Do not replace a sink with QV. Keep intentional constant markup, icons, links, and layout intact. Do not double-escape already escaped aliases or escape the entire HTML fragment.

For format calls, trace the final destination: HTML-bound format arguments need escaping; plain-text-bound formatting does not. For attribute strings, quote the attribute and escape its text value. EscapeHtml is not sufficient for JavaScript inside event handlers or URL scheme validation: STOP if fixing a named field requires changing those contexts beyond a safe text insertion. Existing intended rich text must be classified from a documented construction/sanitization path; do not declare it safe because its string contains markup.

Update every worksheet row after the change, including final line references and the exact boundary. Keep already-safe rows with their evidence, rather than deleting them from the inventory. End with zero `escaped? = no` rows.

**Verify**: `node --test --test-name-pattern='worksheet' test/xss-sweep.test.js` → complete inventory, no unknown rows, zero no rows, and all n/a rows have evidence. This test must parse the worksheet columns, not search for the word 'no' globally.

### Step 3: Add targeted known-bad-shape regression checks

In `test/xss-sweep.test.js`, read all three full templates and collect diagnostics as `file:line: matched expression`. Maintain a short named regex list covering concrete unsafe forms found during the sweep: direct `innerHTML` assignment of node/currentNode name, direct QH/QA message.msg or user/mesh string arguments, and representative unsafe format interpolation. A starting shape is `innerHTML\s*=\s*(?:node|currentNode)\.(?:name|rname|host|desc)\s*;`; another is `Q[HA]\([^,]+,\s*message\.msg\s*\)`.

Add shapes for actual concatenation defects found, using precise raw-field positions. Do not whitelist an entire line merely because it contains one `EscapeHtml`: an escaped name beside an unescaped description is still unsafe. Do not claim regex completeness. Match multiline expressions where needed and avoid flagging field references inside EscapeHtml. Include detector self-tests with unsafe snippets that must match, safe EscapeHtml/textContent snippets that must not, and a mixed escaped/unescaped expression that must still match. Require zero matches in the real three-file scan.

Where the sweep changes a nontrivial formatter/helper, add a minimal extracted-helper assertion in this same test file using the existing VM approach, proving `<`, `>`, ampersands, and quotes are escaped once while constant markup remains. Do not add a DOM library or change production exports for tests.

**Verify**: `node --test test/xss-sweep.test.js` → all inventory, worksheet, detector self-tests, and real-file scans pass; known-bad matches equal zero.

### Step 4: Run browser checks and integration gates

On an available authorized test server, create or rename a disposable device to `<img src=x onerror=alert(1)>`. Open all three views and exercise device list, device details, search, and applicable dialogs. Require literal text, no alert, and no injected image element. Also test `A&B <test> "quoted"` to catch double escaping and broken attributes. Use disposable user/mesh descriptions, notes, chat/messages, and file-name fixtures for the source classes changed by the sweep where the server supports them. Do not use production accounts or alter real device data for this check.

Record view, action, payload, expected/observed result, and server/browser availability in this plan. If no server is available, write `NOT RUN — no test server available`; do not claim browser validation or mark that checkbox passed. Automated completion may be handed off with this explicit residual verification gap; browser-confirmed completion requires the check to run.

Run full suite and syntax baseline, then review scope. Record results and update only this index row unless reviewer-owned.

**Verify**: `npm test && npm run check && git diff --name-only` → gates pass and only scoped paths change. `grep -nE 'PASS|NOT RUN' plans/023-handlebars-xss-sweep.md` → execution record explicitly reports browser PASS results or the actual NOT RUN limitation; template instructions alone do not count as evidence.

## Test plan

- `test/xss-sweep.test.js`: exhaustive candidate-to-worksheet accounting, no unsafe/unknown worksheet rows, n/a evidence required, named known-bad regexes, positive and negative detector fixtures, mixed-safe/unsafe fixture, and zero real-template matches.
- Add focused helper behavior assertions for changed nontrivial formatting logic; use the existing node:vm source-extraction pattern without dependencies.
- `test/xss-sweep-default.md`: committed, all three files covered, field inventory and exclusions explicit, final line references current.
- Run `node --test test/xss-sweep.test.js`, `npm test`, and `npm run check`.
- Manual browser check uses the exact device-name payload above across all three views. Report NOT RUN if unavailable. Regex tests and syntax checks do not substitute for this check.

## Done criteria

- [ ] Worksheet is committed at `test/xss-sweep-default.md` and covers all three files and all four sink/call forms.
- [ ] Every named server-string field class has classified flows or documented absence backed by source search.
- [ ] Worksheet has zero `escaped? = no` and zero unknown rows; every n/a row has source/consumer evidence.
- [ ] Inventory test accounts for every candidate and records helper-mediated/multiline additions.
- [ ] Known-bad detector self-tests pass and the real-file scan reports zero matches.
- [ ] `node --test test/xss-sweep.test.js`, `npm test`, and `npm run check` exit 0.
- [ ] Browser payload check passes in all three views, or is explicitly recorded NOT RUN with the unresolved browser-verification gap.
- [ ] No new helper/dependency, double escaping, or change to intentional constant markup is introduced.
- [ ] Scope check lists only allowed files; execution evidence/index updated or reviewer ownership recorded.

## STOP conditions

Stop immediately if a sink's source cannot be classified from code, if a helper returns a mixture of trusted markup and untrusted strings without a provable boundary, or if intended rich text needs a sanitizer/product decision. Stop if a fix needs JavaScript/URL context handling beyond safe text insertion, an out-of-scope file, or a dependency. Stop for target drift, missing prerequisite fixes, or two failed gate attempts. Never turn an unknown row into n/a to get a green worksheet. Browser unavailability is a recorded verification limitation, not permission to claim success.

## Maintenance notes

The worksheet is the audit artifact; regexes only protect selected regression shapes. Update worksheet lines and evidence when these view functions change. Keep the three variants aligned without generating or reformatting them. Escape at one final HTML boundary and preserve text-only paths. QV remains a visibility helper. A passed static gate does not establish the safety of new source fields, JavaScript attributes, URLs, or other templates outside this sweep.
