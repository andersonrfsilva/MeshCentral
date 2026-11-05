'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// Minimal parent for db.js CreateDB with the NeDB backend: no SQL selectors, no encryption keys.
function createDbParent(datapath) {
    return {
        datapath: datapath,
        args: {},
        config: { settings: { plugins: false }, domains: {} },
        getConfigFilePath: function (name) { return path.join(datapath, name); },
        crypto: crypto,
        debug: function () { }
    };
}

// Builds a real MeshUser session over a fake websocket. Resolves once the session is initialized and receiving.
// Captures live on the returned fixture; no authorization decisions are simulated.
async function createMeshUserFixture(options) {
    options = options || {};
    const domain = Object.assign({ id: '', limits: {} }, options.domain);
    const user = Object.assign({ _id: 'user/' + domain.id + '/testuser', name: 'testuser', domain: domain.id, siteadmin: 0 }, options.user);
    const sent = [], events = [], errors = [], dbUsers = [];
    let closeCalls = 0;
    let ready;
    const readyPromise = new Promise(function (resolve) { ready = resolve; });

    const ws = new EventEmitter();
    ws.send = function (data) { sent.push(data); };
    ws.close = function () { closeCalls++; }; // Does not emit 'close', so obj.close() cannot recurse.
    ws._socket = { setKeepAlive: function () { }, resume: function () { ready(); } };

    const req = { session: { userid: user._id }, clientIp: '127.0.0.1' };
    const args = {};
    const db = { changeStream: false, SetUser: function (u) { dbUsers.push(u); } };

    const root = {
        config: { settings: { managealldevicegroups: [], autobackup: {} }, domains: {} },
        DispatchEvent: function (targets, source, event) { events.push({ targets: targets, source: source, event: event }); },
        RemoveAllEventDispatch: function () { },
        debug: function () { },
        getServerWarnings: function () { return []; },
        logError: function (e) { errors.push(e); }
    };
    root.config.domains[domain.id] = domain;
    Object.keys(options.extraDomains || {}).forEach(function (id) { root.config.domains[id] = options.extraDomains[id]; });
    if (options.managecrossdomain) { root.config.settings.managecrossdomain = options.managecrossdomain; }

    const parent = {
        parent: root,
        common: require('../../common.js'),
        crypto: crypto,
        args: args,
        db: db,
        users: {},
        wssessions: {},
        wssessions2: {},
        meshes: {},
        userGroups: {},
        desktoprelays: {},
        certificates: { CommonName: 'test.example.invalid', AmtMpsName: 'mps.example.invalid' },
        webCertificateFullHashs: {},
        webCertificateExpire: {},
        subscribe: function () { return []; },
        getDomainUserFeatures: function () { return { features: 0, features2: 0, features3: 0 }; },
        getWebServerName: function () { return 'test.example.invalid'; },
        CloneSafeUser: function (u) { return Object.assign({}, u); },
        force2factorPending: function () { return false; }
    };
    parent.users[user._id] = user;
    parent.webCertificateFullHashs[domain.id] = 'synthetic-binary-hash';

    // Teardown (meshuser.js obj.close) updates last access when older than 5 minutes
    user.access = Math.floor(Date.now() / 1000);

    const obj = require('../../meshuser.js').CreateMeshUser(parent, db, ws, req, args, domain, user);
    await readyPromise;

    const fixture = {
        obj: obj, ws: ws, req: req, parent: parent, root: root, db: db, domain: domain, user: user,
        sent: sent, events: events, errors: errors, dbUsers: dbUsers,
        closeCalls: function () { return closeCalls; },
        clearCaptures: function () { sent.length = 0; events.length = 0; dbUsers.length = 0; },
        close: function () { obj.close(0); }
    };
    return fixture;
}

module.exports = { createDbParent: createDbParent, createMeshUserFixture: createMeshUserFixture };
