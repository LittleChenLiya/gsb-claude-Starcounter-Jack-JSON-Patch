/**
 * Deterministic, dependency-free tests for the path-subscription container.
 * Run with: node test/subscriptionSpec.js
 */
"use strict";

var assert = require("assert");
var createSubscriptionContainer = require("../subscription.js").createSubscriptionContainer;
var parsePointer = require("../subscription.js").parsePointer;

var tests = [];
function test(name, fn) {
    tests.push({ name: name, fn: fn });
}

/* ---- pointer parsing / prefix tokens ---- */

test("parsePointer splits and unescapes tokens", function () {
    assert.deepStrictEqual(parsePointer(""), []);
    assert.deepStrictEqual(parsePointer("/items/1"), ["items", "1"]);
    assert.deepStrictEqual(parsePointer("/a~0b/c~1d"), ["a~b", "c/d"]);
    assert.throws(function () { parsePointer("items/1"); });
});

test("prefix tokens match whole tokens only (/items/1 does not see /items/10)", function () {
    var c = createSubscriptionContainer({ items: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] });
    var hits = [];
    c.subscribe("/items/1", function (e) { hits.push(e); });
    // replace index 10: shares the string prefix "1" but not a token prefix
    c.applyPatch([{ op: "replace", path: "/items/10", value: "Z" }]);
    assert.strictEqual(hits.length, 0, "token /items/1 must not match /items/10");
    // replace index 1: exact token match
    c.applyPatch([{ op: "replace", path: "/items/1", value: "Y" }]);
    assert.strictEqual(hits.length, 1);
});

test("escaped tokens subscribe through ~0 and ~1", function () {
    var c = createSubscriptionContainer({ "a/b": { "c~d": 1 } });
    var hits = [];
    c.subscribe("/a~1b/c~0d", function (e) { hits.push(e); });
    c.applyPatch([{ op: "replace", path: "/a~1b/c~0d", value: 2 }]);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(c.getDocument()["a/b"]["c~d"], 2);
});

/* ---- array index shift ---- */

test("removing /items/0 notifies subscriber of /items/1 (index shift)", function () {
    var c = createSubscriptionContainer({ items: ["a", "b", "c"] });
    var hits = [];
    c.subscribe("/items/1", function (e) { hits.push(e); });
    var res = c.applyPatch([{ op: "remove", path: "/items/0" }]);
    assert.strictEqual(hits.length, 1, "shifted subscriber must be notified");
    assert.deepStrictEqual(hits[0].indices, [0]);
    assert.deepStrictEqual(c.getDocument().items, ["b", "c"]);
    assert.deepStrictEqual(res.notified, [{ pointer: "/items/1", indices: [0] }]);
});

test("inserting before a subscribed index notifies it", function () {
    var c = createSubscriptionContainer({ items: ["a", "b"] });
    var hits = [];
    c.subscribe("/items/1", function (e) { hits.push(e); });
    c.applyPatch([{ op: "add", path: "/items/0", value: "x" }]);
    assert.strictEqual(hits.length, 1);
    assert.deepStrictEqual(c.getDocument().items, ["x", "a", "b"]);
});

test("removing a later index does not notify an earlier subscriber", function () {
    var c = createSubscriptionContainer({ items: ["a", "b", "c"] });
    var hits = [];
    c.subscribe("/items/0", function (e) { hits.push(e); });
    c.applyPatch([{ op: "remove", path: "/items/2" }]);
    assert.strictEqual(hits.length, 0);
});

/* ---- move / copy ---- */

test("move from /a to /b notifies subscribers on both sides", function () {
    var c = createSubscriptionContainer({ a: { x: 1 }, b: null, other: 0 });
    var aHits = [], bHits = [], otherHits = [];
    c.subscribe("/a", function (e) { aHits.push(e); });
    c.subscribe("/b", function (e) { bHits.push(e); });
    c.subscribe("/other", function (e) { otherHits.push(e); });
    c.applyPatch([{ op: "move", from: "/a", path: "/b" }]);
    assert.strictEqual(aHits.length, 1, "source side notified");
    assert.strictEqual(bHits.length, 1, "target side notified");
    assert.strictEqual(otherHits.length, 0, "unrelated subscriber stays silent");
    assert.deepStrictEqual(aHits[0].indices, [0]);
    assert.deepStrictEqual(c.getDocument().b, { x: 1 });
    assert.strictEqual(c.getDocument().a, undefined);
});

test("copy notifies only the target side", function () {
    var c = createSubscriptionContainer({ a: 1, b: 0 });
    var aHits = [], bHits = [];
    c.subscribe("/a", function (e) { aHits.push(e); });
    c.subscribe("/b", function (e) { bHits.push(e); });
    c.applyPatch([{ op: "copy", from: "/a", path: "/b" }]);
    assert.strictEqual(aHits.length, 0);
    assert.strictEqual(bHits.length, 1);
});

/* ---- ancestor / descendant ---- */

test("replacing a parent notifies descendant subscribers", function () {
    var c = createSubscriptionContainer({ node: { child: { leaf: 1 } } });
    var hits = [];
    c.subscribe("/node/child/leaf", function (e) { hits.push(e); });
    c.applyPatch([{ op: "replace", path: "/node", value: { child: { leaf: 2 } } }]);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(c.getDocument().node.child.leaf, 2);
});

test("changes inside a subscribed subtree notify its owner", function () {
    var c = createSubscriptionContainer({ node: { child: 1 }, elsewhere: 0 });
    var hits = [];
    c.subscribe("/node", function (e) { hits.push(e); });
    c.applyPatch([{ op: "replace", path: "/node/child", value: 9 }]);
    assert.strictEqual(hits.length, 1);
});

test("root subscription sees every mutating operation", function () {
    var c = createSubscriptionContainer({ a: 1 });
    var hits = [];
    c.subscribe("", function (e) { hits.push(e); });
    c.applyPatch([
        { op: "replace", path: "/a", value: 2 },
        { op: "add", path: "/b", value: 3 }
    ]);
    assert.strictEqual(hits.length, 1, "notified once per batch");
    assert.deepStrictEqual(hits[0].indices, [0, 1]);
});

/* ---- batching semantics ---- */

test("a subscriber is notified once per batch with all matching indices", function () {
    var c = createSubscriptionContainer({ a: 1, b: 2, c: 3 });
    var hits = [];
    c.subscribe("/a", function (e) { hits.push(e); });
    c.applyPatch([
        { op: "replace", path: "/a", value: 10 },   // index 0 matches
        { op: "replace", path: "/b", value: 20 },   // index 1 does not
        { op: "remove", path: "/a" }                // index 2 matches
    ]);
    assert.strictEqual(hits.length, 1, "exactly one notification");
    assert.deepStrictEqual(hits[0].indices, [0, 2]);
    assert.strictEqual(hits[0].document.b, 20, "event carries the committed document");
});

test("test operations never notify", function () {
    var c = createSubscriptionContainer({ a: 1 });
    var hits = [];
    c.subscribe("/a", function (e) { hits.push(e); });
    c.applyPatch([{ op: "test", path: "/a", value: 1 }]);
    assert.strictEqual(hits.length, 0);
});

/* ---- invalid patch: no state change, no notification ---- */

test("an invalid batch leaves state untouched and notifies nobody", function () {
    var doc = { items: ["a", "b"], n: 1 };
    var c = createSubscriptionContainer(doc);
    var hits = [];
    c.subscribe("/items", function (e) { hits.push(e); });
    c.subscribe("/n", function (e) { hits.push(e); });
    assert.throws(function () {
        c.applyPatch([
            { op: "replace", path: "/n", value: 2 },          // valid, would notify
            { op: "remove", path: "/does/not/exist" }         // invalid: batch fails
        ]);
    });
    assert.strictEqual(hits.length, 0, "no notification on failure");
    assert.deepStrictEqual(c.getDocument(), { items: ["a", "b"], n: 1 }, "state unchanged");
    assert.strictEqual(c.getDocument(), doc, "original object identity preserved");
});

test("a failing test operation aborts the batch silently", function () {
    var c = createSubscriptionContainer({ a: 1 });
    var hits = [];
    c.subscribe("/a", function (e) { hits.push(e); });
    assert.throws(function () {
        c.applyPatch([
            { op: "test", path: "/a", value: 999 },
            { op: "replace", path: "/a", value: 2 }
        ]);
    });
    assert.strictEqual(hits.length, 0);
    assert.strictEqual(c.getDocument().a, 1);
});

test("structurally invalid patches are rejected before touching state", function () {
    var c = createSubscriptionContainer({ a: 1 });
    var hits = [];
    c.subscribe("/a", function (e) { hits.push(e); });
    assert.throws(function () { c.applyPatch([{ op: "replace" }]); }); // missing path
    assert.throws(function () { c.applyPatch([{ op: "bogus", path: "/a" }]); });
    assert.throws(function () { c.applyPatch("not-an-array"); });
    assert.strictEqual(hits.length, 0);
    assert.deepStrictEqual(c.getDocument(), { a: 1 });
});

/* ---- notification snapshot semantics ---- */

test("subscriptions added during a callback only apply to the next batch", function () {
    var c = createSubscriptionContainer({ a: 1 });
    var lateHits = [];
    var firstHits = [];
    c.subscribe("/a", function () {
        firstHits.push(1);
        if (firstHits.length === 1) {
            c.subscribe("/a", function (e) { lateHits.push(e); });
        }
    });
    c.applyPatch([{ op: "replace", path: "/a", value: 2 }]);
    assert.strictEqual(firstHits.length, 1);
    assert.strictEqual(lateHits.length, 0, "new subscriber not in the current snapshot");
    c.applyPatch([{ op: "replace", path: "/a", value: 3 }]);
    assert.strictEqual(firstHits.length, 2);
    assert.strictEqual(lateHits.length, 1, "new subscriber active from the next batch");
});

test("unsubscribing during a callback does not stop the current delivery", function () {
    var c = createSubscriptionContainer({ a: 1, b: 1 });
    var hitsA = [], hitsB = [];
    var handleB;
    c.subscribe("/a", function () {
        hitsA.push(1);
        handleB.unsubscribe(); // remove B mid-delivery
    });
    handleB = c.subscribe("/b", function () { hitsB.push(1); });
    c.applyPatch([
        { op: "replace", path: "/a", value: 2 },
        { op: "replace", path: "/b", value: 2 }
    ]);
    assert.strictEqual(hitsA.length, 1);
    assert.strictEqual(hitsB.length, 1, "B still receives the in-flight batch");
    c.applyPatch([
        { op: "replace", path: "/a", value: 3 },
        { op: "replace", path: "/b", value: 3 }
    ]);
    assert.strictEqual(hitsB.length, 1, "B is gone from the next batch");
    assert.strictEqual(c.getSubscriberCount(), 1);
});

test("unsubscribe by handle and by pointer", function () {
    var c = createSubscriptionContainer({ a: 1, b: 1 });
    var hits = [];
    var h1 = c.subscribe("/a", function () { hits.push("a"); });
    c.subscribe("/b", function () { hits.push("b"); });
    h1.unsubscribe();
    c.unsubscribe("/b");
    assert.strictEqual(c.getSubscriberCount(), 0);
    c.applyPatch([
        { op: "replace", path: "/a", value: 2 },
        { op: "replace", path: "/b", value: 2 }
    ]);
    assert.deepStrictEqual(hits, []);
});

/* ---- runner ---- */

var failures = 0;
tests.forEach(function (t) {
    try {
        t.fn();
        console.log("ok - " + t.name);
    } catch (err) {
        failures++;
        console.error("FAIL - " + t.name);
        console.error(err && err.stack ? err.stack : err);
    }
});
console.log(tests.length - failures + "/" + tests.length + " tests passed");
if (failures > 0) {
    process.exit(1);
}
