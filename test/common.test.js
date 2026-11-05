'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const common = require('../common.js');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

const unsignedCases = [0, 1, 0x80000000, 0xFFFFFFFF];

test('IntToStr encodes unsigned big-endian', function () {
    assert.strictEqual(common.IntToStr(0), '\x00\x00\x00\x00');
    assert.strictEqual(common.IntToStr(1), '\x00\x00\x00\x01');
    assert.strictEqual(common.IntToStr(0x80000000), '\x80\x00\x00\x00');
    assert.strictEqual(common.IntToStr(0xFFFFFFFF), '\xFF\xFF\xFF\xFF');
});

test('ReadInt decodes unsigned big-endian at an offset', function () {
    assert.strictEqual(common.ReadInt('\x80\x00\x00\x00', 0), 0x80000000);
    assert.strictEqual(common.ReadInt('\xFF\xFF\xFF\xFF', 0), 0xFFFFFFFF);
    assert.strictEqual(common.ReadInt('ab\x00\x00\x01\x00', 2), 256);
});

test('IntToStr and ReadInt round-trip unsigned values', function () {
    unsignedCases.forEach(function (v) { assert.strictEqual(common.ReadInt(common.IntToStr(v), 0), v); });
});

test('joinPath keeps absolute paths and joins relative ones', function () {
    const abs = path.resolve('/abs/file.db');
    assert.strictEqual(common.joinPath('/base', abs), abs);
    assert.strictEqual(common.joinPath('/base', 'rel/file.db'), path.join('/base', 'rel/file.db'));
});

test('escapeHtml escapes HTML metacharacters', function () {
    assert.strictEqual(common.escapeHtml('<a href="x">&\'`=/</a>'), '&lt;a href&#x3D;&quot;x&quot;&gt;&amp;&#39;&#x60;&#x3D;&#x2F;&lt;&#x2F;a&gt;');
    assert.strictEqual(common.escapeHtml('plain'), 'plain');
    assert.strictEqual(common.escapeHtml(12), '12');
});

test('IsFilenameValid rejects dot-files, reserved names and separators', function () {
    assert.strictEqual(common.IsFilenameValid('report.txt'), true);
    assert.strictEqual(common.IsFilenameValid('.hidden'), false);
    assert.strictEqual(common.IsFilenameValid('CON.txt'), false);
    assert.strictEqual(common.IsFilenameValid('a/b'), false);
    assert.strictEqual(common.IsFilenameValid('a\\b'), false);
    assert.strictEqual(common.IsFilenameValid(''), false);
    assert.strictEqual(common.IsFilenameValid(null), false);
    assert.strictEqual(common.IsFilenameValid(5), false);
});

test('validateString checks type and length bounds', function () {
    assert.strictEqual(common.validateString('abc'), true);
    assert.strictEqual(common.validateString('abc', 3, 3), true);
    assert.strictEqual(common.validateString('abc', 4), false);
    assert.strictEqual(common.validateString('abc', 0, 2), false);
    assert.strictEqual(common.validateString('', 0, 0), true);
    assert.strictEqual(common.validateString(null), false);
    assert.strictEqual(common.validateString(1), false);
    assert.strictEqual(common.validateString(['a']), false);
});

test('validateInt checks type and range bounds', function () {
    assert.strictEqual(common.validateInt(1), true);
    assert.strictEqual(common.validateInt(0, 0, 0), true);
    assert.strictEqual(common.validateInt(-1, 0), false);
    assert.strictEqual(common.validateInt(3, 0, 2), false);
    assert.strictEqual(common.validateInt('1'), false);
    assert.strictEqual(common.validateInt(null), false);
    assert.strictEqual(common.validateInt(1.5, 0, 2), true); // Characterization: integerness is not checked.
});

test('validateArray checks type and length bounds', function () {
    assert.strictEqual(common.validateArray([]), true);
    assert.strictEqual(common.validateArray([], 1), false);
    assert.strictEqual(common.validateArray([1, 2], 1, 2), true);
    assert.strictEqual(common.validateArray([1, 2, 3], 0, 2), false);
    assert.strictEqual(common.validateArray('ab'), false);
    assert.strictEqual(common.validateArray({ length: 1 }), false);
    assert.strictEqual(common.validateArray(null), false);
});

test('MeshUser fixture initializes, accepts messages and closes cleanly', async function () {
    const f = await createMeshUserFixture();
    try {
        assert.strictEqual(f.ws.listenerCount('message'), 1);
        assert.deepStrictEqual(f.errors, []);
        assert.ok(f.sent.some(function (s) { return JSON.parse(s).action == 'serverinfo'; }));
        assert.ok(f.parent.wssessions2[f.ws.sessionId] === f.ws);
        f.clearCaptures();
        f.ws.emit('message', Buffer.from(JSON.stringify({ action: 'nosuchaction' })));
        assert.deepStrictEqual(f.sent, []);
        assert.deepStrictEqual(f.errors, []);
    } finally { f.close(); }
    assert.deepStrictEqual(f.parent.wssessions2, {});
});
