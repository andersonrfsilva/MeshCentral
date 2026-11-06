# Plan 016: Escape stored names, remote paths, and recording metadata at HTML sinks

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update this plan's status row in `plans/README.md`, unless a reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 2e7ec138..HEAD -- views/default.handlebars views/default3.handlebars views/default-mobile.handlebars views/player.handlebars test/view-output-escaping.test.js plans/016-xss-in-views-and-player.md plans/README.md`
> Compare changed source against the excerpts below before proceeding. Unexplained source mismatches are a STOP condition. Plan/index changes alone are not source drift.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 001 (test harness)
- **Category**: security
- **Planned at**: commit `2e7ec138`, 2026-11-05

## Why this matters

Stored account names, agent-controlled paths, and recording metadata reach HTML-building functions without escaping. These values must display as text, not create elements or event handlers. Fix the existing sinks without changing recording formats, account storage, or browser dependencies.

## Current state

Paths below are relative to `/home/anderson/Desenvolvimento/oss/meshcentral`. Browser scripts are embedded in Handlebars files; do not pass whole templates to `node -c`. Server code uses CommonJS and four-space indentation. Match existing view helpers rather than adding an escaping library.

- `views/default.handlebars:21809-21817`, `views/default3.handlebars:24629-24637`, and `views/default-mobile.handlebars:8402-8410` define the same HTML-oriented name helper. Their guest suffix and fallback are already escaped, but stored names are not:

```javascript
if ((useridsplit.length == 4) && (useridsplit[3].startsWith('guest:'))) { guestname = ' - ' + EscapeHtml(decode_utf8(atob(useridsplit[3].substring(6)))); }
if (users && users[userid2] != null) { if (users[userid2].realname != null) return (users[userid2].realname + guestname); else return (users[userid2].name + guestname); }
if (currentNode && currentNode.links && currentNode.links[userid] && currentNode.links[userid].name != null) { return (currentNode.links[userid].name + guestname); }
if (userid == userinfo._id) { return (userinfo.name + guestname); }
```

The next two branches return `nodes[a].links[b].name + guestname` and `meshes[a].links[b].name + guestname`. The final return is already `EscapeHtml(useridsplit[2]) + guestname`.

- `views/default.handlebars:5329` consumes the return as HTML:

```javascript
x += addHtmlValue2(getUserName(j), ((node.sessions.kvm[j] == 1)?"1 session":nobreak(format("{0} sessions", node.sessions.kvm[j]))) + trash);
```

Equivalent session sinks occur at lines 5339, 5346, 5353, 5360, 5367, and 5374. The device title already uses `EscapeHtml(node.name)` at line 5378.

- `views/default.handlebars:12608` creates a remote-path attribute:

```javascript
setDialogMode(2, "Go To Folder", 3, p13gotofolderEx, '<input type=text id=p13folderinput value="' + (isWindowsNode(currentNode) ? p13targetpath.replaceAll('/','\\') + '\\' : p13targetpath + '/') +'" style=width:100% placeholder="'+(isWindowsNode(currentNode) ? 'C:\\' : '/var/www')+'" />');
```

`p13folderset` at lines 12616-12618 obtains this path from `p13filetree.dir[x].n`. `views/default3.handlebars:14599` repeats the attribute interpolation in `setModalContent`; lines 14608-14610 obtain the path from the same remote directory structure.

- `views/player.handlebars:386-390` already distinguishes text from intentional HTML:

```javascript
function addInfo(name, value) { if (value == null) return ''; return addInfoNoEsc(name, EscapeHtml(value)); }
```

The unsafe call sites are `views/player.handlebars:419,428,507`:

```javascript
x += addInfoNoEsc("Protocol", p);
x += addInfoNoEsc("Seeking", format("Indexed every {0} seconds", recFileMetadata.indexInterval));
QH('deskstatus', recFile.name);
```

At lines 415-417, known protocol labels contain `Intel&reg;`. `recFileMetadata` is parsed from recording JSON at line 396. `QH('metadatadiv', x)` at line 506 renders the combined metadata HTML.

- Existing escaping implementation, read-only exemplar: `public/scripts/common-0.0.1.js:38`:

```javascript
function EscapeHtml(x) { if (typeof x == 'string') return x.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); if (typeof x == 'boolean') return x; if (typeof x == 'number') return x; }
```

Search `EscapeHtml` in each view before editing; use the helper already used throughout these files. Do not redefine it.

## Commands you will need

Run commands from the repository root. Node must be at least 20 (`package.json:58-60`). The baseline package has no scripts; Plan 001 supplies these gates.

| Purpose | Command | Expected on success |
|---|---|---|
| Prerequisite | `node -e "const s=require('./package.json').scripts; if(!s || !s.test || !s.check) process.exit(1)"` | Exit 0; otherwise STOP for Plan 001 |
| Focused tests | `node --test test/view-output-escaping.test.js` | All tests pass |
| Suite | `npm test` | All tests pass |
| Syntax baseline | `npm run check` | Exit 0; not a template parser |
| Scope | `git diff --name-only` | Only in-scope paths |

No install, template bundler, or new browser package is required.

## Scope

**In scope** (only files to modify):
- `views/default.handlebars`
- `views/default3.handlebars`
- `views/default-mobile.handlebars`
- `views/player.handlebars`
- `test/view-output-escaping.test.js` (create)
- `plans/016-xss-in-views-and-player.md` (completion and manual-test record)
- `plans/README.md` (status row)

**Out of scope**:
- Shared escaping helper implementation, other views, translations, account data migrations, CSP changes, and generated/minified assets.
- Replacing all `addInfoNoEsc` calls: constant HTML callers remain valid.
- Running `node -c` on Handlebars templates or importing them as Node modules.

## Git workflow

- Branch: `advisor/016-xss-in-views-and-player`.
- Commit logical units with `security: escape stored names in browser views` and `security: escape recording metadata and file names` style.
- Preserve unrelated changes. Do not push or open a PR unless instructed.

## Steps

### Step 1: Escape every stored-name return exactly once

In `getUserName` in all three default views, wrap only each raw name operand in `EscapeHtml`: real name, account name, current-node link name, own name, node-link name, and mesh-link name. Keep `guestname` concatenation outside the call. Leave the already-escaped guest and fallback branches unchanged. Do not add another escape around `getUserName` at session sinks.

Create `test/view-output-escaping.test.js` using `node:test`, `node:assert/strict`, and `node:fs`. Read templates with `readFileSync(path, 'utf8')`. Extract the `getUserName` function using its exact function header and the next function header, asserting that both markers exist. Regex-assert all six raw-name return operands are wrapped with `EscapeHtml`. Assert fallback and guest escaping remain present. Test all three templates in a loop. Tests must read production source, not a copied fixed implementation.

**Verify**: `node --test test/view-output-escaping.test.js` → the three view-name cases pass, with no missing-marker false positives.

### Step 2: Set the folder input value through the DOM

In both desktop `p13gotofolder` functions, render an input with no interpolated `value` attribute. After `setDialogMode` or `setModalContent` has created it, set `Q('p13folderinput').value` to the existing Windows/non-Windows path expression. Keep the placeholder constants and focus behavior. For default3, assign after the modal content exists, before focus.

Add text-based tests scoped to each `p13gotofolder` function. Require `.value =` with the original path expression and reject concatenation of `p13targetpath` into its HTML string. Cover both templates. This preserves quotes, ampersands, and Unicode in the actual path rather than changing the stored value.

**Verify**: `node --test test/view-output-escaping.test.js` → both path-sink cases and all prior cases pass.

### Step 3: Render recording metadata and filename as text

Change the `Protocol` and `Seeking` calls to `addInfo`, not `addInfoNoEsc`. Change the known protocol labels from `Intel&reg;` to the literal Unicode `Intel®`, so escaping does not expose the entity spelling. Keep the numeric protocol mapping unchanged. Replace `QH('deskstatus', recFile.name)` with `Q('deskstatus').textContent = recFile.name`. Leave `QH('metadatadiv', x)` because `x` is deliberately constructed HTML with escaped values.

Add regex assertions that `Protocol` and `Seeking` call `addInfo`, their old unescaped calls are absent, `deskstatus` uses `.textContent`, and the known protocol labels use the literal registered mark. Do not reject `addInfoNoEsc` globally; `addInfo` itself delegates to it.

**Verify**: `node --test test/view-output-escaping.test.js` → player call-site checks and all view checks pass.

### Step 4: Record browser observations and close the plan

When a development browser/server is available, perform the manual cases below. If unavailable, record "not run: no live browser/server" in this plan; this is not a STOP condition and does not waive automated tests. Record the security behavior and any residual manual validation risk. Update the index row; if the index is absent, record completion here for its owner instead of stopping or inventing another documentation file.

**Verify**: `npm test && npm run check` → exit 0. `git diff --name-only` → only Scope paths.

## Test plan

Use Plan 001's Node test setup and `test/helpers/fake-parent.js` only if useful; these static browser regressions need no server fake. Use at least eight top-level cases: three name helpers, two path dialogs, two metadata fields, one filename sink. Add assertions for guest/fallback escaping and protocol label display within those cases.

Manual checks:
- Name a disposable device `Lab <b>bold</b>` and open its Sessions dialog. The title must show literal `<b>bold</b>`, with no bold element. This already-safe device-name control must remain safe.
- Give a disposable account a real name `User <b>bold</b>`, start a session, and inspect Sessions on default, default3, and mobile. The account label must show literal angle brackets, not bold text. Guest names must not become double-escaped (`&lt;` must not display literally for an original `<`).
- On a POSIX test agent, open a directory containing a double quote and `<b>` in its name. Go To Folder must show the exact path in the input and create no extra elements or attributes. Submit an ordinary Windows path too; separators must remain unchanged.
- Open a disposable recording with protocol/indexInterval strings containing `<b>probe</b>` and a filename containing `<b>probe</b>`. Values must display literally, create no `<b>` elements, and run no event handlers. Valid numeric protocol labels must still display `Intel®` correctly. Use harmless markup, never an external exfiltration endpoint.

## Done criteria

- [ ] `node --test test/view-output-escaping.test.js` passes all eight or more cases.
- [ ] `npm test` and `npm run check` exit 0.
- [ ] All six stored-name operands in each helper are escaped once.
- [ ] Both folder dialogs assign `.value`, and player filename assigns `.textContent`.
- [ ] `Protocol` and `Seeking` no longer use `addInfoNoEsc`.
- [ ] Browser observations, or their explicit unavailability, are recorded in this plan.
- [ ] Only Scope files changed; index row updated or completion recorded here if absent.

## STOP conditions

- Plan 001 has not supplied `npm test` and `npm run check`.
- Source markers or excerpts have unexplained drift; do not add broad regexes that silently match another function.
- An existing consumer requires unescaped `getUserName` output for a non-HTML operation and cannot be preserved within the listed files.
- A verification fails twice after a reasonable fix attempt, or a fix requires another source file.
- Do not stop merely because the index, another documentation file, or a live server is unavailable.

## Maintenance notes

The `getUserName` return is HTML-safe, not raw text. Keep raw persistence values unchanged and escape at this established boundary. Template regex tests are intentional tripwires, not a browser security proof; preserve the manual cases when changing modal rendering. Any future move to DOM text nodes must remove redundant escaping at that sink to avoid visible entities.
