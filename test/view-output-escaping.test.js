'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readView(name) { return fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8'); }

// Return the source of one function, from its header up to the next header (or a given end marker).
function sliceBetween(src, startMarker, endMarker) {
    const start = src.indexOf(startMarker);
    assert.ok(start >= 0, 'missing start marker: ' + startMarker);
    const end = src.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, 'missing end marker: ' + endMarker);
    return src.slice(start, end);
}

const nameOperands = [
    'users\\[userid2\\]\\.realname',
    'users\\[userid2\\]\\.name',
    'currentNode\\.links\\[userid\\]\\.name',
    'userinfo\\.name',
    'nodes\\[a\\]\\.links\\[b\\]\\.name',
    'meshes\\[a\\]\\.links\\[b\\]\\.name'
];

['default.handlebars', 'default3.handlebars', 'default-mobile.handlebars'].forEach(function (view) {
    test('getUserName escapes every stored name once in ' + view, function () {
        const fn = sliceBetween(readView(view), 'function getUserName(userid)', '\n        function ');
        nameOperands.forEach(function (op) {
            assert.match(fn, new RegExp('return \\(EscapeHtml\\(' + op + '\\) \\+ guestname\\)'), op);
            assert.doesNotMatch(fn, new RegExp('return \\(' + op + ' \\+ guestname\\)'), 'raw ' + op);
            assert.doesNotMatch(fn, new RegExp('EscapeHtml\\(EscapeHtml\\(' + op));
        });
        assert.match(fn, /guestname = ' - ' \+ EscapeHtml\(decode_utf8\(atob\(/);
        assert.match(fn, /return \(EscapeHtml\(useridsplit\[2\]\) \+ guestname\);/);
    });
});

['default.handlebars', 'default3.handlebars'].forEach(function (view) {
    test('p13gotofolder sets the path through the DOM in ' + view, function () {
        const fn = sliceBetween(readView(view), 'function p13gotofolder()', 'function p13gotofolderEx');
        assert.match(fn, /Q\('p13folderinput'\)\.value = \(isWindowsNode\(currentNode\) \? p13targetpath\.replaceAll\('\/','\\\\'\) \+ '\\\\' : p13targetpath \+ '\/'\);/);
        assert.doesNotMatch(fn, /'<input[^\n]*p13targetpath/);
        assert.doesNotMatch(fn, /<input[^\n]*value=/);
        assert.match(fn, /placeholder=/);
        assert.match(fn, /focusTextBox\('p13folderinput'\)/);
    });
});

test('player Protocol and Seeking metadata are escaped', function () {
    const src = readView('player.handlebars');
    assert.match(src, /x \+= addInfo\("Protocol", p\);/);
    assert.match(src, /x \+= addInfo\("Seeking", format\("Indexed every \{0\} seconds", recFileMetadata\.indexInterval\)\);/);
    assert.doesNotMatch(src, /addInfoNoEsc\("Protocol"/);
    assert.doesNotMatch(src, /addInfoNoEsc\("Seeking"/);
    assert.match(src, /function addInfo\(name, value\) \{[^\n]*addInfoNoEsc\(name, EscapeHtml\(value\)\)/);
});

test('player protocol labels use the literal registered mark', function () {
    const src = readView('player.handlebars');
    ['WSMAN', 'Redirection', 'KVM'].forEach(function (s) {
        assert.ok(src.includes('"Intel\u00AE AMT ' + s + '"'), s);
    });
    assert.ok(!src.includes('Intel&reg;'));
});

test('player recording file name is rendered as text', function () {
    const src = readView('player.handlebars');
    assert.match(src, /Q\('deskstatus'\)\.textContent = recFile\.name;/);
    assert.doesNotMatch(src, /QH\('deskstatus', recFile/);
});
