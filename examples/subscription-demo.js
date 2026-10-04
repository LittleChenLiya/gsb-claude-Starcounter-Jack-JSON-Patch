/**
 * Small-state demo of the path-subscription container.
 * Run with: node examples/subscription-demo.js
 */
"use strict";

var createSubscriptionContainer = require("../subscription.js").createSubscriptionContainer;

// a tiny state tree
var container = createSubscriptionContainer({
    items: ["apple", "banana", "cherry"],
    user: { name: "Ada" }
});

function show(label) {
    console.log(label.padEnd(34), JSON.stringify(container.getDocument()));
}

// subscribe to JSON Pointer prefixes
container.subscribe("/items/1", function (e) {
    console.log('  -> subscriber "/items/1" notified by ops', e.indices,
        "| value now:", JSON.stringify(e.document.items[1]));
});
container.subscribe("/user", function (e) {
    console.log('  -> subscriber "/user" notified by ops', e.indices,
        "| name now:", e.document.user.name);
});

show("initial state:");

console.log("\n[batch 1] remove /items/0  (shifts /items/1 down)");
container.applyPatch([{ op: "remove", path: "/items/0" }]);
show("state after batch 1:");

console.log("\n[batch 2] move /user/name -> /user/nick  (both sides of /user)");
container.applyPatch([{ op: "move", from: "/user/name", path: "/user/nick" }]);
show("state after batch 2:");

console.log("\n[batch 3] replace /user  (parent replace notifies descendants)");
container.subscribe("/user/nick", function (e) {
    console.log('  -> subscriber "/user/nick" notified by ops', e.indices);
});
container.applyPatch([{ op: "replace", path: "/user", value: { nick: "Ada L." } }]);
show("state after batch 3:");

console.log("\n[batch 4] invalid batch: replace /items/0 + remove /missing");
try {
    container.applyPatch([
        { op: "replace", path: "/items/0", value: "apricot" },
        { op: "remove", path: "/missing" }
    ]);
} catch (err) {
    console.log("  -> batch rejected:", String(err.message).split("\n")[0]);
}
show("state unchanged after batch 4:");
