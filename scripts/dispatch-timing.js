'use strict';

// Compares the production DispatchEvent (Set membership) with the previous array/indexOf traversal.
// Run: node scripts/dispatch-timing.js. Reports timings only; there is no pass/fail speed threshold.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SAMPLES = 5, BUCKETS = 10, SIZES = [100, 1000, 10000];

// Load the production method by exact source markers; the server is never started.
const text = fs.readFileSync(path.join(__dirname, '..', 'meshcentral.js'), 'utf8');
const start = text.indexOf('obj.DispatchEvent = function (ids, source, event, fromPeerServer) {');
const end = text.indexOf('// Get the connection state of a node', start);
assert.ok(start >= 0 && end > start, 'DispatchEvent markers not found in meshcentral.js');
const load = new vm.Script('(function (obj, console) {\n' + text.slice(start, end) + '\n})').runInThisContext();
const production = { eventsDispatch: {}, debug: function () { }, db: {} };
load(production, console);

// BASELINE ONLY: the pre-change recipient traversal (linear indexOf), kept here for comparison, not used by the server.
function baselineDispatch(eventsDispatchMap, ids, source, event) {
    const targets = [];
    for (var j in ids) {
        const id = ids[j];
        const eventsDispatch = eventsDispatchMap[id];
        if (eventsDispatch) {
            for (var i in eventsDispatch) {
                if (targets.indexOf(eventsDispatch[i]) == -1) {
                    targets.push(eventsDispatch[i]);
                    try { eventsDispatch[i].HandleEvent(source, event, ids, id); } catch (ex) { console.log(ex, eventsDispatch[i]); }
                }
            }
        }
    }
}

// Deterministic fixture: unique recipients spread over overlapping buckets; each bucket repeats members; ids repeat.
function buildFixture(size) {
    const delivered = [];
    let checksum = 0;
    const recipients = [];
    for (let n = 0; n < size; n++) { recipients.push({ n: n, HandleEvent: function () { delivered.push(this.n); checksum = (checksum + this.n + 1) | 0; } }); }
    const map = {};
    const ids = [];
    let candidates = 0;
    for (let b = 0; b < BUCKETS; b++) {
        const list = [];
        for (let n = 0; n < size; n++) { if ((n + b) % 3 != 2) { list.push(recipients[(n * 7 + b * 13) % size]); } } // ~2/3 of recipients per bucket, shifted order
        list.push(recipients[b % size]); // in-bucket duplicate
        map['b' + b] = list;
        candidates += list.length;
        ids.push('b' + b);
    }
    for (let b = 0; b < BUCKETS; b++) { ids.push('b' + b); candidates += map['b' + b].length; } // repeated ids
    return { map: map, ids: ids, candidates: candidates, delivered: delivered, checksum: function () { return checksum; }, reset: function () { delivered.length = 0; checksum = 0; } };
}

function median(values) { const s = values.slice().sort(function (a, b) { return a - b; }); return s[Math.floor(s.length / 2)]; }

function measure(fn, fixture) {
    fn(); fixture.reset(); // warm up
    const samples = [];
    let sum = 0;
    for (let s = 0; s < SAMPLES; s++) {
        fixture.reset();
        const t0 = process.hrtime.bigint();
        fn();
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        sum = (sum + fixture.checksum()) | 0;
    }
    return { ms: median(samples), checksum: sum };
}

console.log('size | candidates | unique | baseline ms | set ms | ratio old/new | checksum');
for (const size of SIZES) {
    const fx = buildFixture(size);
    production.eventsDispatch = fx.map;
    const event = { nolog: true, nopeers: 1 };
    const runNew = function () { production.DispatchEvent(fx.ids, 'timing', event); };
    const runOld = function () { baselineDispatch(fx.map, fx.ids, 'timing', event); };

    // Both implementations must deliver the same recipients in the same order before timing.
    runOld(); const oldOrder = fx.delivered.slice(); fx.reset();
    runNew(); const newOrder = fx.delivered.slice(); fx.reset();
    assert.deepEqual(newOrder, oldOrder, 'delivery order differs for size ' + size);

    const o = measure(runOld, fx), n = measure(runNew, fx);
    assert.equal(n.checksum, o.checksum, 'checksum differs for size ' + size);
    console.log([size, fx.candidates, newOrder.length, o.ms.toFixed(3), n.ms.toFixed(3), (o.ms / n.ms).toFixed(1) + 'x', n.checksum].join(' | '));
}
