/**
 * Path-subscription container built on top of fast-json-patch.
 *
 * Callers subscribe to JSON Pointer prefixes. A batch of patch operations is
 * first validated and applied to an isolated copy of the document; only when
 * the whole batch succeeds is the new state committed and each affected
 * subscriber notified exactly once, with the indices of the operations that
 * matched its prefix.
 *
 * Affect rules (see docs/SUBSCRIPTION.md):
 *  - An operation affects a subscriber when the operation path and the
 *    subscribed pointer share a token-wise prefix relation (either is a
 *    prefix of the other). Replacing/removing a parent therefore notifies
 *    descendants, and changes inside a subscribed subtree notify its owner.
 *  - Array add/remove shift later siblings: a subscriber on /items/1 is
 *    notified when /items/0 is removed, even though the literal paths differ.
 *  - move affects both the from side (as a remove) and the path side (as an
 *    add). copy affects its target as an add. test never notifies.
 *  - Notifications are delivered from a snapshot: subscriptions added or
 *    removed inside a callback only take effect for the next batch.
 */
"use strict";

var core = require("./commonjs/core.js");
var helpers = require("./commonjs/helpers.js");

var deepClone = helpers._deepClone;
var unescapePathComponent = helpers.unescapePathComponent;
var isInteger = helpers.isInteger;

/**
 * Splits a JSON Pointer into unescaped tokens.
 * "" -> [] (root), "/a~0b~1c/1" -> ["a~b/c", "1"]
 */
function parsePointer(pointer) {
    if (typeof pointer !== "string") {
        throw new TypeError("JSON Pointer must be a string");
    }
    if (pointer === "") {
        return [];
    }
    if (pointer.charAt(0) !== "/") {
        throw new Error("JSON Pointer must be empty or start with '/': " + pointer);
    }
    return pointer.split("/").slice(1).map(unescapePathComponent);
}

/** True when prefix is a token-wise prefix of tokens (equal counts too). */
function isTokenPrefix(prefix, tokens) {
    if (prefix.length > tokens.length) {
        return false;
    }
    for (var i = 0; i < prefix.length; i++) {
        if (prefix[i] !== tokens[i]) {
            return false;
        }
    }
    return true;
}

/** Resolves tokens against a document, returning undefined when missing. */
function getByTokens(document, tokens) {
    var node = document;
    for (var i = 0; i < tokens.length; i++) {
        if (node === null || typeof node !== "object") {
            return undefined;
        }
        node = node[tokens[i]];
    }
    return node;
}

/**
 * Computes the affected-path entries of one operation, given the document
 * state right before the operation is applied.
 * Each entry: { tokens: Array, shift: "add" | "remove" | null }
 * shift marks array insertions/removals that move later sibling indices.
 */
function affectedEntries(operation, document) {
    var entries = [];
    function entry(pathTokens, isRemoveLike) {
        var parentTokens = pathTokens.slice(0, -1);
        var parent = getByTokens(document, parentTokens);
        var shift = null;
        if (Array.isArray(parent) && isInteger(pathTokens[pathTokens.length - 1])) {
            shift = isRemoveLike ? "remove" : "add";
        }
        entries.push({ tokens: pathTokens, shift: shift });
    }
    switch (operation.op) {
        case "add":
            entry(parsePointer(operation.path), false);
            break;
        case "remove":
            entry(parsePointer(operation.path), true);
            break;
        case "replace":
            entry(parsePointer(operation.path), false);
            break;
        case "move":
            entry(parsePointer(operation.from), true);  // source behaves as remove
            entry(parsePointer(operation.path), false); // target behaves as add
            break;
        case "copy":
            entry(parsePointer(operation.path), false);
            break;
        case "test":
        default:
            // test is non-mutating: it never notifies subscribers
            break;
    }
    return entries;
}

/** True when a subscriber with subTokens is affected by one affected entry. */
function matches(subTokens, entry) {
    var tokens = entry.tokens;
    // prefix relation in either direction (parent replace notifies
    // descendants; changes inside a subscribed subtree notify its owner)
    if (isTokenPrefix(subTokens, tokens) || isTokenPrefix(tokens, subTokens)) {
        return true;
    }
    // array index shift: same parent array, subscriber index >= changed index
    if (entry.shift !== null && subTokens.length >= tokens.length) {
        var parentLen = tokens.length - 1;
        var sameParent = true;
        for (var i = 0; i < parentLen; i++) {
            if (subTokens[i] !== tokens[i]) {
                sameParent = false;
                break;
            }
        }
        if (sameParent && isInteger(subTokens[parentLen])) {
            return parseInt(subTokens[parentLen], 10) >= parseInt(tokens[parentLen], 10);
        }
    }
    return false;
}

/** Creates a subscription container around document. */
function createSubscriptionContainer(document) {
    var subscriptions = []; // live set of { pointer, tokens, callback, handle }
    var state = { document: document };

    function subscribe(pointer, callback) {
        if (typeof callback !== "function") {
            throw new TypeError("callback must be a function");
        }
        var subscription = {
            pointer: pointer,
            tokens: parsePointer(pointer),
            callback: callback,
            handle: null
        };
        var handle = {
            pointer: pointer,
            unsubscribe: function () {
                unsubscribe(handle);
            }
        };
        subscription.handle = handle;
        subscriptions.push(subscription);
        return handle;
    }

    function unsubscribe(handleOrPointer) {
        for (var i = subscriptions.length - 1; i >= 0; i--) {
            var sub = subscriptions[i];
            if (sub.handle === handleOrPointer || sub.pointer === handleOrPointer) {
                subscriptions.splice(i, 1);
            }
        }
    }

    function getDocument() {
        return state.document;
    }

    /**
     * Validates and applies a batch of operations.
     * On any failure the state is left untouched, nobody is notified and the
     * JsonPatchError is rethrown. On success each affected subscriber is
     * called once with { pointer, indices, document, patch }.
     * Returns { document, notified: [{ pointer, indices }] }.
     */
    function applyPatch(patch) {
        // 1. structural validation of the sequence against current state
        var validationError = core.validate(patch, state.document);
        if (validationError) {
            throw validationError;
        }
        // 2. apply to an isolated copy; a failing batch never touches state
        var isolated = deepClone(state.document);
        var result = core.applyPatch(isolated, deepClone(patch), true, true);
        var newDocument = result.newDocument;

        // 3. replay the batch on a scratch copy to collect, per subscriber,
        //    the indices of the operations that affect it
        var scratch = deepClone(state.document);
        var snapshot = subscriptions.slice();
        var matched = [];
        var s;
        for (s = 0; s < snapshot.length; s++) {
            matched.push([]);
        }
        for (var i = 0; i < patch.length; i++) {
            var operation = patch[i];
            var entries = affectedEntries(operation, scratch);
            for (var j = 0; j < snapshot.length; j++) {
                var tokens = snapshot[j].tokens;
                for (var e = 0; e < entries.length; e++) {
                    if (matches(tokens, entries[e])) {
                        matched[j].push(i);
                        break;
                    }
                }
            }
            // advance the scratch state so later operations (and array
            // shifts) are evaluated against the right document shape
            core.applyOperation(scratch, deepClone(operation), false, true);
        }

        // 4. commit the new state
        state.document = newDocument;

        // 5. notify from the snapshot: subscriptions added/removed by
        //    callbacks do not change this delivery round
        var notified = [];
        for (var k = 0; k < snapshot.length; k++) {
            if (matched[k].length === 0) {
                continue;
            }
            var event = {
                pointer: snapshot[k].pointer,
                indices: matched[k],
                document: state.document,
                patch: patch
            };
            notified.push({ pointer: event.pointer, indices: event.indices.slice() });
            snapshot[k].callback(event);
        }
        return { document: state.document, notified: notified };
    }

    return {
        subscribe: subscribe,
        unsubscribe: unsubscribe,
        applyPatch: applyPatch,
        getDocument: getDocument,
        getSubscriberCount: function () {
            return subscriptions.length;
        }
    };
}

module.exports = {
    createSubscriptionContainer: createSubscriptionContainer,
    parsePointer: parsePointer
};
