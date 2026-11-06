'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

test('session close removes owned listeners and preserves unrelated listeners', async function () {
    const fixture = await createMeshUserFixture();
    const eventNames = ['message', 'close', 'error'];
    const sentinel = function () { };
    eventNames.forEach(function (eventName) {
        fixture.ws.on(eventName, function () { });
        assert.ok(fixture.ws.listenerCount(eventName) > 0);
    });
    fixture.ws.on('sentinel', sentinel);

    fixture.obj.close(0);

    eventNames.forEach(function (eventName) {
        assert.strictEqual(fixture.ws.listenerCount(eventName), 0);
    });
    assert.deepStrictEqual(fixture.ws.listeners('sentinel'), [sentinel]);
});
