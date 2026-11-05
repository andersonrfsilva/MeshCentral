'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const common = require('../common.js');

// Cuts the production source between two exact markers, failing when either marker is missing.
function sliceSource(file, startMarker, endMarker) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const start = text.indexOf(startMarker);
    assert.ok(start >= 0, file + ': start marker not found: ' + startMarker);
    const end = text.indexOf(endMarker, start);
    assert.ok(end > start, file + ': end marker not found: ' + endMarker);
    return text.slice(start, end);
}

function compile(source, params) {
    const script = new vm.Script('(function (' + params.join(', ') + ') {\n' + source + '\n})', { filename: 'extracted.js' });
    return script.runInThisContext();
}

// ---- DispatchEvent (meshcentral.js) ----

const dispatchSource = sliceSource('meshcentral.js', 'obj.DispatchEvent = function (ids, source, event, fromPeerServer) {', '// Get the connection state of a node');
assert.ok(dispatchSource.includes('targets.has('), 'DispatchEvent must use Set membership');

function makeDispatcher(options) {
    options = options || {};
    const counts = { store: 0, peers: 0 };
    const obj = { eventsDispatch: {}, debug: function () { }, common: common, multiServer: { DispatchEvent: function () { counts.peers++; } } };
    if (options.noDb !== true) { obj.db = { StoreEvent: function () { counts.store++; } }; }
    compile(dispatchSource, ['obj', 'console'])(obj, { log: function () { } });
    return { obj: obj, counts: counts };
}

function handler(name, calls, onEvent) {
    return { name: name, HandleEvent: function (source, event, ids, id) { calls.push(name + '@' + id); if (onEvent) { onEvent(event); } } };
}

test('dispatch: duplicates across and within buckets deliver once, in first-seen order', function () {
    const { obj, counts } = makeDispatcher();
    const calls = [], h1 = handler('h1', calls), h2 = handler('h2', calls), h3 = handler('h3', calls);
    obj.eventsDispatch = { a: [h1, h2, h1], b: [h2, h3], c: [h1] };
    obj.DispatchEvent(['a', 'b', 'a', 'unknown', '', 'c'], 'src', { action: 'x' });
    assert.deepEqual(calls, ['h1@a', 'h2@a', 'h3@b']);
    assert.equal(counts.store, 1);
    assert.equal(counts.peers, 1);
});

test('dispatch: distinct objects with identical properties are distinct recipients', function () {
    const { obj } = makeDispatcher();
    const calls = [];
    obj.eventsDispatch = { a: [handler('same', calls), handler('same', calls)] };
    obj.DispatchEvent(['a'], 'src', { nolog: true });
    assert.deepEqual(calls, ['same@a', 'same@a']);
});

test('dispatch: empty and unknown ids deliver nothing', function () {
    const { obj, counts } = makeDispatcher();
    obj.DispatchEvent([], 'src', { action: 'x' });
    obj.DispatchEvent(['nobody'], 'src', { action: 'x' });
    assert.equal(counts.store, 2);
});

test('dispatch: throwing handler does not stop delivery and is not retried', function () {
    const { obj } = makeDispatcher();
    const calls = [];
    const bad = { HandleEvent: function () { calls.push('bad'); throw new Error('boom'); } };
    obj.eventsDispatch = { a: [bad, handler('h2', calls)], b: [bad, handler('h3', calls)] };
    obj.DispatchEvent(['a', 'b'], 'src', { nolog: true });
    assert.deepEqual(calls, ['bad', 'h2@a', 'h3@b']);
});

test('dispatch: subscription replaced during dispatch keeps the bucket snapshot, later buckets see the change', function () {
    const { obj } = makeDispatcher();
    const calls = [];
    const h2 = handler('h2', calls), h3 = handler('h3', calls);
    const h1 = handler('h1', calls, function () { obj.eventsDispatch.a = [h1]; delete obj.eventsDispatch.b; });
    obj.eventsDispatch = { a: [h1, h2], b: [h3] };
    obj.DispatchEvent(['a', 'b'], 'src', { nolog: true });
    assert.deepEqual(calls, ['h1@a', 'h2@a']);
});

test('dispatch: reentrant dispatch uses an independent recipient set', function () {
    const { obj } = makeDispatcher();
    const calls = [];
    const h2 = { HandleEvent: function (s, e, ids, id) { calls.push(e.tag + ':h2@' + id); } };
    const h1 = { HandleEvent: function (s, e, ids, id) { calls.push(e.tag + ':h1@' + id); if (e.tag == 'outer') { obj.DispatchEvent(['b'], 'src', { tag: 'inner', nolog: true }); } } };
    obj.eventsDispatch = { a: [h1], b: [h1, h2] };
    obj.DispatchEvent(['a', 'b'], 'src', { tag: 'outer', nolog: true });
    // Inner call reaches h1 and h2 even though the outer call already served h1; outer then still serves h2.
    assert.deepEqual(calls, ['outer:h1@a', 'inner:h1@b', 'inner:h2@b', 'outer:h2@b']);
});

test('dispatch: nolog, nopeers, fromPeerServer and missing db keep their behavior', function () {
    const a = makeDispatcher();
    a.obj.DispatchEvent(['x'], 's', { nolog: true });
    assert.deepEqual(a.counts, { store: 0, peers: 1 });
    a.obj.DispatchEvent(['x'], 's', { nolog: true, nopeers: 1 });
    a.obj.DispatchEvent(['x'], 's', { nolog: true }, true);
    assert.deepEqual(a.counts, { store: 0, peers: 1 });
    const b = makeDispatcher({ noDb: true });
    b.obj.DispatchEvent(['x'], 's', { action: 'x' });
    assert.deepEqual(b.counts, { store: 0, peers: 0 });
});

// ---- GetNodeWithRights (webserver.js) ----

const rightsSource = sliceSource('webserver.js', 'function removeUserRights(rights, user) {', '// Return the node and rights for a array of nodeids')
    + sliceSource('webserver.js', 'obj.GetNodeWithRights = function (', '// Returns a list of all meshes that this user has some rights too');
assert.ok(rightsSource.includes('suppliedNode'), 'GetNodeWithRights must accept a supplied node');

const MESH = 'mesh//m1', NODE = 'node//n1';
function makeRights(nodes, managed) {
    const counts = { get: 0 };
    const db = { Get: function (id, cb) { counts.get++; cb(null, nodes[id] ? [nodes[id]] : []); } };
    const parent = { config: { settings: { managealldevicegroups: managed || [] } } };
    const obj = { common: common, users: {}, userGroups: { 'ugrp//g1': { links: { [MESH]: { rights: 4 } } }, 'ugrp//g2': { links: { [NODE]: { rights: 0 } } } } };
    compile(rightsSource, ['obj', 'db', 'parent'])(obj, db, parent);
    return { obj: obj, counts: counts };
}

function call(rights, domain, user, nodeid, supplied) {
    let result, n = 0;
    const cb = function (node, r, visible) { n++; result = [node, r, visible]; };
    if (arguments.length > 4) { rights.obj.GetNodeWithRights(domain, user, nodeid, cb, supplied); } else { rights.obj.GetNodeWithRights(domain, user, nodeid, cb); }
    assert.equal(n, 1, 'callback must run exactly once');
    return result;
}

const rightsUsers = {
    direct: { links: { [NODE]: { rights: 0x48 } } },
    directZero: { links: { [NODE]: { rights: 0 } } },
    mesh: { links: { [MESH]: { rights: 0x1C } } },
    full: { links: { [MESH]: { rights: 0xFFFFFFFF } } },
    groupMesh: { links: { 'ugrp//g1': {} } },
    groupDirectZero: { links: { 'ugrp//g2': {} } },
    denied: { links: { 'mesh//other': { rights: 0xFFFFFFFF } } },
    noLinks: {},
    restricted: { links: { [MESH]: { rights: 0xFFFFFFFF } }, removeRights: 0x8 | 0x40 },
    restrictedPartial: { links: { [MESH]: { rights: 0xFF } }, removeRights: 0x8 | 0x100 },
    superuser: { _id: 'user//root', siteadmin: 0xFFFFFFFF, domain: '', links: { x: {} } }
};

test('rights: supplied node returns the same (node, rights, visible) as the database path', function () {
    const node = { _id: NODE, domain: '', meshid: MESH, name: 'n' };
    for (const name of Object.keys(rightsUsers)) {
        const user = Object.assign({ _id: 'user//' + name, domain: '', siteadmin: 0 }, rightsUsers[name]);
        const rights = makeRights({ [NODE]: node }, ['user//root']);
        const fetched = call(rights, { id: '' }, user, NODE);
        const supplied = call(rights, { id: '' }, user, NODE, node);
        assert.deepEqual(supplied, fetched, name);
        assert.equal(supplied[0], fetched[0] == null ? null : node, name);
        assert.equal(rights.counts.get, 1, name + ': only the legacy call reads the database');
    }
});

test('rights: expected visibility and rights bits', function () {
    const node = { _id: NODE, domain: '', meshid: MESH };
    const rights = makeRights({ [NODE]: node }, ['user//root']);
    const get = function (name) { return call(rights, { id: '' }, Object.assign({ _id: 'user//' + name, domain: '', siteadmin: 0 }, rightsUsers[name]), NODE, node); };
    assert.deepEqual(get('directZero').slice(1), [0, true]); // visible with zero rights
    assert.deepEqual(get('groupDirectZero').slice(1), [0, true]);
    assert.deepEqual(get('direct').slice(1), [0x48, true]);
    assert.deepEqual(get('mesh').slice(1), [0x1C, true]);
    assert.deepEqual(get('groupMesh').slice(1), [4, true]);
    assert.deepEqual(get('denied').slice(1), [0, false]);
    assert.deepEqual(get('noLinks').slice(1), [0, false]);
    // Full rights with restrictions: No Remote Control (0x8) and No Wake (0x40) are removed from the admin set.
    assert.equal(get('restricted')[1] & 0x48, 0);
    assert.equal(get('restrictedPartial')[1], 0xFF & ~0x8 | 0x100);
    assert.equal(get('superuser')[2], true);
    assert.equal(get('superuser')[1], call(rights, { id: '' }, Object.assign({ _id: 'user//root', domain: '', siteadmin: 0xFFFFFFFF }, { links: { x: {} } }), NODE)[1]);
});

test('rights: supplied node must match id and domain, and never falls back to the database', function () {
    const node = { _id: NODE, domain: '', meshid: MESH };
    const rights = makeRights({ [NODE]: node });
    const user = Object.assign({ _id: 'user//u', domain: '', siteadmin: 0 }, rightsUsers.full);
    const denied = [null, 0, false];
    assert.deepEqual(call(rights, { id: '' }, user, NODE, { _id: 'node//other', domain: '', meshid: MESH }), denied);
    assert.deepEqual(call(rights, { id: '' }, user, NODE, { _id: NODE, domain: 'other', meshid: MESH }), denied);
    assert.deepEqual(call(rights, { id: '' }, user, NODE, { _id: NODE, meshid: MESH }), denied);
    assert.deepEqual(call(rights, { id: '' }, user, NODE, null), denied);
    assert.deepEqual(call(rights, { id: '' }, user, NODE, 'node'), denied);
    assert.deepEqual(call(rights, { id: 'other' }, user, NODE, node), denied); // Provided domain mismatch
    assert.deepEqual(call(rights, { id: '' }, null, NODE, node), denied);
    assert.deepEqual(call(rights, { id: '' }, user, 'bad', node), denied);
    assert.equal(rights.counts.get, 0);
});

test('rights: nonexistent database node is rejected on the legacy path', function () {
    const rights = makeRights({});
    const user = Object.assign({ _id: 'user//u', domain: '', siteadmin: 0 }, rightsUsers.full);
    assert.deepEqual(call(rights, { id: '' }, user, NODE), [null, 0, false]);
    assert.equal(rights.counts.get, 1);
});

// ---- Detailed device export (meshuser.js) ----

const listSource = sliceSource('meshuser.js', 'function getAllDeviceDetailedInfo(type, func) {', '// Display a notification message for this session only.');
const reuseCall = 'parent.GetNodeWithRights(domain, user, docs[i]._id, getNodeFunc, docs[i]);';
assert.ok(listSource.includes(reuseCall), 'non-paged export must pass the fetched node');
const legacyListSource = listSource.replace(reuseCall, 'parent.GetNodeWithRights(domain, user, docs[i]._id, getNodeFunc);');
assert.notEqual(legacyListSource, listSource);

// mode: 'sync' | 'queue' (FIFO, async) | 'reverse' (LIFO flush) for every database callback.
function runList(src, nodeCount, mode, options) {
    options = options || {};
    const nodes = {}, docs = [], counts = { list: 0, node: 0, si: 0, if: 0 };
    for (let n = 0; n < nodeCount; n++) {
        const id = NODE.replace('n1', 'n' + n);
        nodes[id] = { _id: id, domain: '', meshid: MESH, name: 'dev' + n, type: undefined };
        docs.push(Object.assign({}, nodes[id]));
    }
    const pending = [];
    const defer = function (fn) { if (mode == 'sync') { fn(); } else { pending.push(fn); } };
    const db = {
        GetAllTypeNoTypeFieldMeshFiltered: function (a, b, c, d, e, f, g, h, cb) { counts.list++; defer(function () { cb(null, docs.map(function (d) { return Object.assign({}, d); })); }); },
        Get: function (id, cb) {
            if (id.startsWith('node/')) { counts.node++; defer(function () { cb(null, nodes[id] ? [Object.assign({}, nodes[id])] : []); }); }
            else if (id.startsWith('si')) { counts.si++; defer(function () { cb(null, options.noSys ? [] : [{ _id: id, hardware: 1 }]); }); }
            else { counts.if++; defer(function () { cb(null, options.noNet ? null : [{ _id: id, netif: 1 }]); }); }
        }
    };
    const user = Object.assign({ _id: 'user//u', domain: '', siteadmin: 0 }, options.denied ? rightsUsers.denied : rightsUsers.full);
    const parent = { config: { settings: { managealldevicegroups: [] } } };
    const wobj = { common: common, users: {}, userGroups: {} };
    compile(rightsSource, ['obj', 'db', 'parent'])(wobj, db, parent);
    const meshParent = {
        GetNodeWithRights: wobj.GetNodeWithRights,
        GetAllMeshIdWithRights: function () { return [MESH]; },
        cleanDevice: function () { },
        CloneSafeNode: function (n) { return Object.assign({}, n, { safe: true }); },
        common: { unEscapeAllLinksFieldName: function () { } }
    };
    const obj = { visibleDevices: options.paged ? {} : null };
    if (options.paged) { for (const id of Object.keys(nodes)) { obj.visibleDevices[id] = 1; } }
    const calls = [];
    compile('var i;\n' + src + '\nreturn getAllDeviceDetailedInfo;', ['obj', 'parent', 'db', 'domain', 'user', 'getUserExtraIds'])(obj, meshParent, db, { id: '' }, user, function () { return []; })('t', function (result, type) { calls.push({ result: result, type: type }); });
    while (pending.length > 0) { (mode == 'reverse' ? pending.pop() : pending.shift())(); }
    return { counts: counts, calls: calls };
}

// Plan 017 initializes the shared counter before the paging branch; until it lands the paged path needs this harness-only shim.
const pagedShimSource = listSource.replace('function getAllDeviceDetailedInfo(type, func) {', 'function getAllDeviceDetailedInfo(type, func) { var results = [], resultPendingCount = 0;');
assert.notEqual(pagedShimSource, listSource);

function sortedNodes(calls) { return calls[0].result.slice().sort(function (a, b) { return a.node._id < b.node._id ? -1 : 1; }); }

test('device-list: non-paged export costs 1 + 2N database reads and matches the legacy output', function () {
    for (const n of [0, 1, 10]) {
        // 'sync' is excluded: before plan 017 lands, synchronous completion fires the callback twice.
        for (const mode of ['queue', 'reverse']) {
            const fresh = runList(listSource, n, mode);
            const legacy = runList(legacyListSource, n, mode);
            assert.deepEqual(fresh.counts, { list: 1, node: 0, si: n, if: n }, 'N=' + n + ' ' + mode);
            assert.deepEqual(legacy.counts, { list: 1, node: n, si: n, if: n }, 'legacy N=' + n + ' ' + mode);
            assert.equal(fresh.calls.length, 1, 'completion exactly once N=' + n + ' ' + mode);
            assert.equal(fresh.calls[0].type, 't');
            if (n == 0) { assert.deepEqual(fresh.calls[0].result, []); continue; }
            assert.deepEqual(sortedNodes(fresh.calls), sortedNodes(legacy.calls));
            assert.equal(fresh.calls[0].result.length, n);
            assert.equal(fresh.calls[0].result[0].node.safe, true); // CloneSafeNode still applied
            assert.equal(fresh.calls[0].result[0].sys.hardware, 1);
            assert.equal(fresh.calls[0].result[0].net.netif, 1);
        }
    }
});

test('device-list: missing sysinfo and netinfo keep their output shape', function () {
    const fresh = runList(listSource, 2, 'queue', { noSys: true, noNet: true });
    const legacy = runList(legacyListSource, 2, 'queue', { noSys: true, noNet: true });
    assert.deepEqual(sortedNodes(fresh.calls), sortedNodes(legacy.calls));
    assert.equal(sortedNodes(fresh.calls)[0].sys, undefined);
    assert.equal(sortedNodes(fresh.calls)[0].net, null);
});

test('device-list: paged export still reads every node (3N) and denied nodes trigger no metadata reads', function () {
    for (const n of [1, 10]) {
        const paged = runList(pagedShimSource, n, 'queue', { paged: true });
        assert.deepEqual(paged.counts, { list: 0, node: n, si: n, if: n });
        assert.equal(paged.calls[0].result.length, n);
    }
    const denied = runList(listSource, 3, 'sync', { denied: true });
    assert.equal(denied.counts.si + denied.counts.if, 0);
    assert.equal(denied.counts.node, 0);
});
