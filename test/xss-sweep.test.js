'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const files = ['views/default.handlebars', 'views/default3.handlebars', 'views/default-mobile.handlebars'];
const sources = new Map(files.map(function (file) {
    return [file, fs.readFileSync(path.join(root, file), 'utf8')];
}));
const candidate = /innerHTML|QH\s*\(|QA\s*\(|format\s*\(/;

function worksheetRows() {
    const text = fs.readFileSync(path.join(__dirname, 'xss-sweep-default.md'), 'utf8');
    const rows = [];
    let file;
    for (const line of text.split('\n')) {
        const heading = /^## (views\/[^ ]+\.handlebars)\s*$/.exec(line);
        if (heading) { file = heading[1]; }
        if (!/^\|\s*\d/.test(line)) { continue; }
        const columns = line.split(/(?<!\\)\|/).slice(1, -1).map(function (value) { return value.trim(); });
        assert.equal(columns.length, 6, 'Expected six worksheet columns: ' + line);
        assert.ok(files.includes(file), 'Missing file heading: ' + line);
        const lines = columns[0].split(',').map(function (value) {
            assert.match(value.trim(), /^\d+$/, 'Expected explicit line numbers: ' + line);
            return Number(value.trim());
        });
        rows.push({ file: file, lines: lines, sink: columns[1], source: columns[2], escaped: columns[3], evidence: columns[4], remediation: columns[5] });
    }
    return rows;
}

test('worksheet inventory covers every candidate line', function () {
    const rows = worksheetRows();
    for (const [file, source] of sources) {
        const classified = new Set(rows.filter(function (row) { return row.file === file; }).flatMap(function (row) { return row.lines; }));
        const missing = [];
        source.split('\n').forEach(function (line, index) {
            if (candidate.test(line) && !classified.has(index + 1)) { missing.push(file + ':' + (index + 1)); }
        });
        assert.deepEqual(missing, [], 'Unclassified candidate lines');
    }
});

test('worksheet contains no unsafe or unknown classifications', function () {
    const rows = worksheetRows();
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(['yes', 'n/a'].includes(row.escaped), row.file + ':' + row.lines + ': ' + row.escaped);
        assert.ok(row.evidence.length > 0, 'Missing classification evidence');
        assert.ok(row.source.length > 0 && row.sink.length > 0, 'Missing flow context');
        assert.doesNotMatch(row.evidence, /\b(?:unclassified|TODO)\b/i);
        for (const line of row.lines) {
            assert.ok(line >= 1 && line <= sources.get(row.file).split('\n').length, 'Stale worksheet position');
        }
    }
});

// These shapes protect selected regressions, not every possible JavaScript data flow.
const detectors = [
    { name: 'direct device HTML', pattern: /innerHTML\s*=\s*(?:node|currentNode)\.(?:name|rname|host|desc)\s*;/g },
    { name: 'direct server HTML helper', pattern: /Q[HA]\([^,]+,\s*(?:message\.msg|(?:user|mesh)\.(?:name|realname|email|desc))\s*\)/g },
    { name: 'raw format template field', pattern: /format\(\s*(?:node|currentNode|user|mesh)\.(?:name|rname|host|desc|realname|email)\s*[,)]/g },
    { name: 'raw field concatenation', pattern: /\+\s*(?:node|currentNode|user|mesh)\.(?:name|rname|host|desc|realname|email)\s*\+\s*['"]</g },
    { name: 'application name JavaScript quote', pattern: /onclick=[^\n]*encodeURIComponent\(app\.name\)/g }
];

function diagnostics(file, source) {
    const matches = [];
    for (const detector of detectors) {
        detector.pattern.lastIndex = 0;
        for (const match of source.matchAll(detector.pattern)) {
            const line = source.slice(0, match.index).split('\n').length;
            matches.push(file + ':' + line + ': ' + detector.name + ': ' + match[0]);
        }
    }
    return matches;
}

test('known-bad detectors recognize unsafe, safe, and mixed expressions', function () {
    const unsafe = [
        'element.innerHTML = node.name;',
        "QH('target',\nmessage.msg)",
        "QA('target', user.email)",
        'format(currentNode.desc, 1)',
        "x = '<b>' + EscapeHtml(node.name) + '</b><span>' + node.desc + '</span>';",
        'onclick="uninstallStoreApp(\'' + "' + encodeURIComponent(app.name) + '" + '\')"'
    ];
    for (const source of unsafe) { assert.ok(diagnostics('fixture', source).length > 0, source); }
    const safe = [
        'element.textContent = node.name;',
        'element.innerHTML = EscapeHtml(node.name);',
        "QH('target', EscapeHtml(message.msg))",
        'format("Device {0}", currentNode.desc)',
        "x = '<b>' + EscapeHtml(node.name) + '</b><span>' + EscapeHtml(node.desc) + '</span>';",
        'onclick="uninstallStoreApp(\'' + "' + encodeURIComponentEx(app.name) + '" + '\')"'
    ];
    for (const source of safe) { assert.deepEqual(diagnostics('fixture', source), [], source); }
});

test('known-bad shapes absent from all three views', function () {
    const matches = [];
    for (const [file, source] of sources) { matches.push(...diagnostics(file, source)); }
    assert.deepEqual(matches, []);
});

test('view formatters escape once and retain their existing markup contracts', function () {
    const common = fs.readFileSync(path.join(root, 'public/scripts/common-0.0.1.js'), 'utf8');
    const escape = common.split('\n').find(function (line) { return line.startsWith('function EscapeHtml('); });
    const payload = '<test> & "quoted" \'single\'';
    for (const [file, source] of sources) {
        const formatter = source.split('\n').find(function (line) { return /^\s*function format\(format\)/.test(line); });
        const encoder = source.split('\n').find(function (line) { return /^\s*function encodeURIComponentEx\(/.test(line); });
        assert.ok(formatter && encoder, file + ': missing helper');
        const context = vm.createContext({});
        vm.runInContext(escape + '\n' + formatter + '\n' + encoder, context);
        const escaped = '&lt;test&gt; &amp; &quot;quoted&quot; &apos;single&apos;';
        const expected = file === 'views/default-mobile.handlebars' ? '&lt;b&gt;' + escaped + '&lt;/b&gt;' : '<b>' + escaped + '</b>';
        assert.equal(context.format('<b>{0}</b>', payload), expected, file);
        const encoded = context.encodeURIComponentEx(payload);
        assert.ok(!encoded.includes("'"), file);
        assert.equal(decodeURIComponent(encoded), payload, file);
    }
});

function extractViewFunction(source, name) {
    const start = source.indexOf('        function ' + name + '(');
    assert.ok(start >= 0, 'Missing function: ' + name);
    const end = source.indexOf('\n        }', start);
    assert.ok(end > start, 'Missing function end: ' + name);
    return source.slice(start, end + '\n        }'.length);
}

test('plugin navigation decodes encoded callers and preserves legacy text callers', function () {
    const payload = 'A&B <test> "quoted" \'single\' %';
    for (const file of files.slice(0, 2)) {
        const source = sources.get(file);
        const elements = { p43title: {}, p43iframe: {} };
        const encoder = source.split('\n').find(function (line) { return /^\s*function encodeURIComponentEx\(/.test(line); });
        const context = vm.createContext({
            pluginHandler: {},
            document: { getElementById: function (id) { return elements[id]; } },
            Q: function (id) { return elements[id]; },
            go: function (page) { assert.equal(page, 43); }
        });
        vm.runInContext(encoder + '\n' + extractViewFunction(source, 'goPlugin'), context);
        for (const encoded of [true, false]) {
            const value = encoded ? context.encodeURIComponentEx(payload) : payload;
            context.goPlugin(value, value, encoded);
            assert.equal(elements.p43title.textContent, payload, file);
            assert.equal(new URL(elements.p43iframe.src, 'https://example.test').searchParams.get('pin'), payload, file);
        }
        context.goPlugin(null);
        assert.equal(elements.p43iframe.src, '', file);
    }
});

test('plugin links allow only HTTP(S) and escape URL and version once', function () {
    const common = fs.readFileSync(path.join(root, 'public/scripts/common-0.0.1.js'), 'utf8');
    const escape = common.split('\n').find(function (line) { return line.startsWith('function EscapeHtml('); });
    for (const file of files.slice(0, 2)) {
        const source = sources.get(file);
        let homepage = /var homepage = (.+);/.exec(source);
        if (!homepage) {
            const line = source.split('\n').find(function (line) { return line.includes('var tpl =') && line.includes('p.homepage'); });
            assert.ok(line, file + ': missing inline homepage expression');
            const start = line.indexOf(' + (') + 3;
            const end = line.indexOf(" + '</td><td", start);
            assert.ok(start >= 3 && end > start, file + ': missing homepage boundaries');
            homepage = [null, line.slice(start, end)];
        }
        const changelog = /p\.upgradeAvail = (\(?\/\^https.+);/.exec(source);
        assert.ok(homepage && changelog, file + ': missing URL boundaries');
        const context = vm.createContext({ p: {}, vin: { version: '<v>&"\'%' } });
        vm.runInContext(escape, context);
        for (const url of [' https://example.test/?a=<b>&c="quoted"\' ', 'HTTP://example.test/']) {
            context.p.homepage = context.vin.changelogUrl = url;
            const homeHtml = vm.runInContext(homepage[1], context);
            const changeHtml = vm.runInContext(changelog[1], context);
            const href = 'href="' + context.EscapeHtml(url.trim()) + '"';
            assert.ok(homeHtml.includes(href), file);
            assert.ok(changeHtml.includes(href), file);
            assert.ok(changeHtml.includes('>' + context.EscapeHtml(context.vin.version) + '</a>'), file);
        }
        for (const url of ['javascript:alert(1)', ' data:text/html,<script>x</script>', '//example.test/', '']) {
            context.p.homepage = context.vin.changelogUrl = url;
            const expected = file === 'views/default.handlebars' ? context.EscapeHtml(url) : 'Home';
            assert.equal(vm.runInContext(homepage[1], context), expected, file);
            assert.equal(vm.runInContext(changelog[1], context), context.EscapeHtml(context.vin.version), file);
        }
    }
});

test('mobile public file link keeps decoded hostile names in input value only', function () {
    const source = sources.get('views/default-mobile.handlebars');
    const helper = source.split('\n').find(function (line) { return /^\s*function p5showPublicLink\(/.test(line); });
    assert.ok(helper);
    const input = {};
    let markup;
    const context = vm.createContext({
        Q: function (id) { assert.equal(id, 'p5publiclink'); return input; },
        setDialogMode: function (mode, title, buttons, callback, html) { markup = html; }
    });
    vm.runInContext(helper, context);
    const payload = '/public/A&B <test> "quoted" \'single\' %';
    context.p5showPublicLink(encodeURIComponent(payload).replace(/'/g, '%27'));
    assert.equal(input.value, payload);
    assert.equal(markup, '<input id=p5publiclink type=text style=width:100% readonly />');
});

test('mobile OTP secret formatting escapes text once around its constant break', function () {
    const source = sources.get('views/default-mobile.handlebars');
    const start = source.indexOf('var secret = message.secret;');
    const end = source.indexOf("QH('d2optinfo'", start);
    assert.ok(start >= 0 && end > start);
    const common = fs.readFileSync(path.join(root, 'public/scripts/common-0.0.1.js'), 'utf8');
    const escape = common.split('\n').find(function (line) { return line.startsWith('function EscapeHtml('); });
    for (const length of [7, 32, 52]) {
        const payload = '<>&"\'abc'.repeat(7).slice(0, length);
        const context = vm.createContext({ message: { secret: payload } });
        vm.runInContext(escape + '\n' + source.slice(start, end), context);
        let expected = context.EscapeHtml(payload);
        if (length === 52) {
            expected = context.EscapeHtml(payload.match(/.{1,13}/g).join(' '));
        } else if (length === 32) {
            const groups = payload.match(/.{1,4}/g);
            expected = context.EscapeHtml(groups.slice(0, 4).join(' ') + ' ') + '<br/>' + context.EscapeHtml(groups.slice(4).join(' '));
        }
        assert.equal(context.secret, expected);
    }
});

test('report formatter escapes fallback strings and preserves node markup', function () {
    const common = fs.readFileSync(path.join(root, 'public/scripts/common-0.0.1.js'), 'utf8');
    const escape = common.split('\n').find(function (line) { return line.startsWith('function EscapeHtml('); });
    const payload = '<test>&"\'%';
    for (const file of files.slice(0, 2)) {
        const source = sources.get(file);
        const encoder = source.split('\n').find(function (line) { return /^\s*function encodeURIComponentEx\(/.test(line); });
        const context = vm.createContext({
            getNodeFromId: function () { return { _id: payload, name: payload, icon: 1 }; }
        });
        vm.runInContext(escape + '\n' + encoder + '\n' + extractViewFunction(source, 'renderReportFormat'), context);
        const escaped = context.EscapeHtml(payload);
        assert.equal(context.renderReportFormat(payload, 'records'), escaped, file);
        assert.equal(context.renderReportFormat(payload, 'protocol'), 'Unknown (' + escaped + ')', file);
        assert.equal(context.renderReportFormat('node', 'records'), 'Device record', file);
        const html = context.renderReportFormat(payload, 'node');
        assert.ok(html.startsWith('<div '), file);
        assert.ok(html.endsWith('</div>' + escaped), file);
        assert.ok(html.includes(context.encodeURIComponentEx(payload)), file);
        assert.ok(!html.includes(payload), file);
    }
});

test('mobile quota progress attributes contain only numeric conversions', function () {
    const source = sources.get('views/default-mobile.handlebars');
    const context = vm.createContext({ getNiceSize: function (size) { return String(size); } });
    vm.runInContext(extractViewFunction(source, 'p5getQuotabar'), context);
    assert.equal(context.p5getQuotabar({ t: 1, s: 2, maxbytes: 10 }), '8 <progress style=height:10px;width:100px value=2 max=10 />');
    const payload = '1 onmouseover=alert(1)';
    const html = context.p5getQuotabar({ t: 1, s: payload, maxbytes: payload });
    assert.equal(html, 'NaN <progress style=height:10px;width:100px value=NaN max=NaN />');
    assert.ok(!html.includes(payload));
});

test('context menus recover original IDs from encoded inline handlers', function () {
    const payload = 'node/domain%\'"&</identifier';
    const encoded = encodeURIComponent(payload).replace(/'/g, '%27');
    for (const file of files.slice(0, 2)) {
        const source = sources.get(file);
        const device = /nodeid = (decodeURIComponent\(nodeid\.split\("'"\)\[1\]\));/.exec(source);
        const mesh = /var meshid = (decodeURIComponent\(contextelement\.attributes\.onclick\.value\.split\('"'\)\[1\]\));/.exec(source);
        assert.ok(device && mesh, file + ': missing encoded context-menu extraction');
        const context = vm.createContext({
            nodeid: "gotoDevice(decodeURIComponent('" + encoded + "'),null,null,event)",
            contextelement: { attributes: { onclick: { value: 'gotoMesh(decodeURIComponent("' + encoded + '"))' } } }
        });
        assert.equal(vm.runInContext(device[1], context), payload, file);
        assert.equal(vm.runInContext(mesh[1], context), payload, file);
    }
});

test('permission tags escape server identifiers, names, and permission keys once', function () {
    const common = fs.readFileSync(path.join(root, 'public/scripts/common-0.0.1.js'), 'utf8');
    const escape = common.split('\n').find(function (line) { return line.startsWith('function EscapeHtml('); });
    const payload = '<test>&"\'%';
    for (const file of files.slice(0, 2)) {
        const context = vm.createContext({});
        vm.runInContext(escape + '\n' + extractViewFunction(sources.get(file), 'buildPermTag'), context);
        const id = 'user/domain/' + payload;
        const html = context.buildPermTag({ _id: id, name: payload }, payload, 'global', 'allowed', 'user', payload);
        const escaped = context.EscapeHtml(payload);
        assert.ok(html.startsWith('<span '), file);
        assert.ok(html.includes('data-actualid="' + context.EscapeHtml(id) + '"'), file);
        assert.ok(html.includes('data-perm="' + escaped + '"'), file);
        assert.ok(html.includes('data-parentid="' + escaped + '"'), file);
        assert.ok(html.includes(' ' + escaped + ' '), file);
        assert.ok(!html.includes(payload), file);
        assert.ok(html.includes('onclick="removePermTagFromTag(this)"'), file);
    }
});

test('notes use escaped fallback when sanitizer is absent or unsupported', function () {
    const common = fs.readFileSync(path.join(root, 'public/scripts/common-0.0.1.js'), 'utf8');
    const escape = common.split('\n').find(function (line) { return line.startsWith('function EscapeHtml('); });
    const payload = '<img src=x onerror=alert(1)> & "quoted" \'single\'';
    for (const file of files.slice(0, 2)) {
        const source = sources.get(file);
        const encoder = source.split('\n').find(function (line) { return /^\s*function encodeURIComponentEx\(/.test(line); });
        const elements = { d2devNotes: { value: payload }, notesPanelArea: {} };
        let sent;
        const context = vm.createContext({
            Q: function (id) { return elements[id]; },
            QV: function () {},
            marked: { parse: function () { assert.fail('Unsupported sanitizer must not parse Markdown'); } },
            showNotesPanel: 'true',
            meshserver: { send: function (message) { sent = message; } }
        });
        vm.runInContext(escape + '\n' + encoder + '\n' + extractViewFunction(source, 'showNotesEx'), context);
        for (const sanitizer of [null, { isSupported: false, sanitize: function () { assert.fail('Unsupported sanitizer called'); } }]) {
            context.DOMPurify = sanitizer;
            context.showNotesEx(1, encodeURIComponent('node/domain/id'));
            assert.equal(elements.notesPanelArea.innerHTML, context.EscapeHtml(payload), file);
            assert.equal(sent.id, 'node/domain/id', file);
            assert.equal(decodeURIComponent(sent.notes), payload, file);
        }
    }
});
