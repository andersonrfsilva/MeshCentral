'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMeshUserFixture } = require('./helpers/fake-parent.js');

// Builds a session with synthetic autobackup settings and a captured performBackup.
async function setup(siteadmin, myserver, autobackup) {
    const domainOpts = (myserver === undefined) ? {} : { myserver: myserver };
    const f = await createMeshUserFixture({ user: { siteadmin: siteadmin }, domain: domainOpts });
    f.root.config.settings.autobackup = autobackup || { zippassword: 'synthetic-configured', zippasswordrequest: 'synthetic-pending' };
    f.backupCalls = 0;
    f.db.performBackup = function () { f.backupCalls++; };
    f.db.performingBackup = false;
    f.db.newAutoBackupFile = null;
    f.parent.preparedBackups = {};
    f.root.addServerWarning = function () { };
    f.clearCaptures();
    return f;
}

function dispatch(f, command) {
    command.action = 'serverbackuppassword';
    f.ws.emit('message', Buffer.from(JSON.stringify(command)));
    return new Promise(function (resolve) { setImmediate(resolve); });
}

const denied = [
    ['check', { check: true, dialog: 'd' }],
    ['password', { password: 'synthetic-new' }],
    ['override', { override: true }],
    ['prepare', { password: 'synthetic-new', prepare: true }]
];

for (const siteadmin of [0, 2]) {
    for (const [name, cmd] of denied) {
        test('denied siteadmin ' + siteadmin + ': ' + name + ' with existing override', async () => {
            const f = await setup(siteadmin);
            const before = JSON.parse(JSON.stringify(f.root.config.settings.autobackup));
            await dispatch(f, Object.assign({}, cmd));
            assert.deepStrictEqual(f.root.config.settings.autobackup, before);
            assert.strictEqual(f.sent.length, 0);
            assert.strictEqual(f.backupCalls, 0);
            f.close();
        });
        test('denied siteadmin ' + siteadmin + ': ' + name + ' cannot create override', async () => {
            const f = await setup(siteadmin, undefined, { zippassword: 'synthetic-configured' });
            await dispatch(f, Object.assign({}, cmd));
            assert.deepStrictEqual(f.root.config.settings.autobackup, { zippassword: 'synthetic-configured' });
            assert.strictEqual('zippasswordrequest' in f.root.config.settings.autobackup, false);
            assert.strictEqual(f.sent.length, 0);
            assert.strictEqual(f.backupCalls, 0);
            f.close();
        });
    }
}

test('domain policy with permission bit', async () => {
    const cases = [[undefined, true], [false, false], [{}, false], [{ backup: false }, false], [{ backup: true }, true]];
    for (const [myserver, allowed] of cases) {
        for (const siteadmin of [1, 0xFFFFFFFF]) {
            const f = await setup(siteadmin, myserver);
            const before = JSON.parse(JSON.stringify(f.root.config.settings.autobackup));
            await dispatch(f, { password: 'synthetic-new' });
            if (allowed) { assert.strictEqual(f.root.config.settings.autobackup.zippasswordrequest, 'synthetic-new'); }
            else { assert.deepStrictEqual(f.root.config.settings.autobackup, before); }
            await dispatch(f, { check: true, dialog: 'd' });
            assert.strictEqual(f.sent.length, allowed ? 1 : 0);
            f.close();
        }
    }
});

test('domain policy without permission bit denies even when backup allowed', async () => {
    const f = await setup(2, { backup: true });
    await dispatch(f, { check: true });
    assert.strictEqual(f.sent.length, 0);
    f.close();
});

test('authorized check keeps response shape', async () => {
    const f = await setup(1);
    await dispatch(f, { check: true, dialog: 'dlg' });
    assert.strictEqual(f.sent.length, 1);
    assert.deepStrictEqual(JSON.parse(f.sent[0]), { action: 'backuprestore', data: true, dialog: 'dlg' });
    f.close();
});

test('authorized check reports false without configured password', async () => {
    const f = await setup(1, undefined, {});
    await dispatch(f, { check: true, dialog: 'dlg' });
    assert.strictEqual(JSON.parse(f.sent[0]).data, false);
    f.close();
});

test('authorized override picks configured password', async () => {
    const f = await setup(1);
    await dispatch(f, { override: true });
    assert.strictEqual(f.root.config.settings.autobackup.zippasswordrequest, 'synthetic-configured');
    f.close();
});

test('authorized assignment keeps supplied password including empty string', async () => {
    const f = await setup(1);
    await dispatch(f, { password: 'synthetic-new' });
    assert.strictEqual(f.root.config.settings.autobackup.zippasswordrequest, 'synthetic-new');
    await dispatch(f, { password: '' });
    assert.strictEqual(f.root.config.settings.autobackup.zippasswordrequest, '');
    assert.strictEqual(f.backupCalls, 0);
    f.close();
});

test('authorized prepare calls performBackup once', async () => {
    const f = await setup(1);
    await dispatch(f, { password: 'synthetic-new', prepare: true });
    assert.strictEqual(f.root.config.settings.autobackup.zippasswordrequest, 'synthetic-new');
    assert.strictEqual(f.backupCalls, 1);
    f.close();
});
