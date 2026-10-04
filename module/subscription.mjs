/*!
 * Path subscription container for fast-json-patch.
 *
 * Callers subscribe to JSON Pointer prefixes. After a batch of patches is
 * committed, only the subscribers whose subscribed prefix is affected by the
 * batch are notified, and each subscriber is notified at most once with the
 * indices of the operations that affected it.
 *
 * The whole batch is validated and applied to an isolated copy of the
 * document first. If any operation fails, the document is left untouched and
 * no notifications are sent.
 *
 * See SUBSCRIPTION_RULES.md for the full set of impact rules.
 */
import { applyOperation, validate, getValueByPointer } from './core.mjs';
import { _deepClone, isInteger, unescapePathComponent } from './helpers.mjs';
/**
 * Normalize a JSON Pointer prefix: trim whitespace and ensure it either is the
 * empty string (root) or starts with '/'.
 */
function normalizePrefix(prefix) {
    if (typeof prefix !== 'string') {
        throw new Error('Subscription prefix must be a string');
    }
    var trimmed = prefix.trim();
    if (trimmed === '') {
        return '';
    }
    if (trimmed.charAt(0) !== '/') {
        return '/' + trimmed;
    }
    return trimmed;
}
/** Split a JSON Pointer into its unescaped tokens. */
function tokenize(pointer) {
    if (pointer === '') {
        return [];
    }
    var raw = pointer.split('/');
    raw.shift(); // drop the empty element before the first '/'
    for (var i = 0; i < raw.length; i++) {
        raw[i] = unescapePathComponent(raw[i]);
    }
    return raw;
}
/**
 * Prefix impact rule (token based, not string based):
 * a subscription on `subPrefix` is affected by an operation touching
 * `fragPath` when:
 *   - the paths are equal,
 *   - the operation path is inside the subscribed subtree (fragPath is longer),
 *   - the subscribed subtree is inside the operation path (a parent node is
 *     replaced/removed/moved, which affects descendants).
 * The '/' boundary is significant: subscribing to `/items` is NOT affected by
 * an operation on `/items2`.
 */
function prefixAffects(subPrefix, fragPath) {
    if (fragPath === subPrefix) {
        return true;
    }
    if (fragPath.charAt(0) === '/' && fragPath.startsWith(subPrefix + '/')) {
        return true;
    }
    if (subPrefix.charAt(0) === '/' && subPrefix.startsWith(fragPath + '/')) {
        return true;
    }
    return false;
}
/**
 * If `path` points at an integer index inside an array in `doc`, return the
 * array location. Otherwise return null.
 */
function arrayLocation(path, doc) {
    if (path === '') {
        return null;
    }
    var lastSlash = path.lastIndexOf('/');
    var indexToken = path.substring(lastSlash + 1);
    if (!isInteger(indexToken)) {
        return null;
    }
    var parentPath = path.substring(0, lastSlash);
    var parent = parentPath === '' ? doc : getValueByPointer(doc, parentPath);
    if (!Array.isArray(parent)) {
        return null;
    }
    return { parent: parent, parentTokens: tokenize(parentPath), index: parseInt(indexToken, 10) };
}
/**
 * Return the integer index of `subPrefix` inside the array described by
 * `parentTokens`, or null when the subscription does not point at that array.
 */
function subIndexAt(subPrefix, parentTokens) {
    var tokens = tokenize(subPrefix);
    if (tokens.length < parentTokens.length + 1) {
        return null;
    }
    for (var i = 0; i < parentTokens.length; i++) {
        if (tokens[i] !== parentTokens[i]) {
            return null;
        }
    }
    var indexToken = tokens[parentTokens.length];
    if (!isInteger(indexToken)) {
        return null;
    }
    return parseInt(indexToken, 10);
}
/**
 * Array shift impact rule: inserting/removing at index `i` shifts every
 * subsequent index, so a subscription pointing at index `j` (j >= i) is
 * affected. `replace` does not shift.
 */
function arrayShiftAffects(subPrefix, fragPath, mode, doc) {
    var loc = arrayLocation(fragPath, doc);
    if (!loc) {
        return false;
    }
    var subIndex = subIndexAt(subPrefix, loc.parentTokens);
    if (subIndex === null) {
        return false;
    }
    return subIndex >= loc.index;
}
/**
 * Impact rule for a single path fragment of an operation.
 */
function pathAffects(subPrefix, fragPath, mode, doc) {
    if (prefixAffects(subPrefix, fragPath)) {
        return true;
    }
    if (mode !== 'replace' && arrayShiftAffects(subPrefix, fragPath, mode, doc)) {
        return true;
    }
    return false;
}
/**
 * Impact rule for a `move` operation. A move affects both the source and the
 * target subtree. When source and target live in the same array, only the
 * indices between the two positions (inclusive) are affected; the elements
 * beyond the target are not shifted.
 */
function moveAffects(subPrefix, fromPath, toPath, doc) {
    if (prefixAffects(subPrefix, fromPath)) {
        return true;
    }
    if (prefixAffects(subPrefix, toPath)) {
        return true;
    }
    var from = arrayLocation(fromPath, doc);
    var to = arrayLocation(toPath, doc);
    if (from && to && from.parent === to.parent) {
        var subIndex = subIndexAt(subPrefix, from.parentTokens);
        if (subIndex === null) {
            return false;
        }
        var lo = Math.min(from.index, to.index);
        var hi = Math.max(from.index, to.index);
        return subIndex >= lo && subIndex <= hi;
    }
    if (from) {
        var fromIndex = subIndexAt(subPrefix, from.parentTokens);
        if (fromIndex !== null && fromIndex >= from.index) {
            return true;
        }
    }
    if (to) {
        var toIndex = subIndexAt(subPrefix, to.parentTokens);
        if (toIndex !== null && toIndex >= to.index) {
            return true;
        }
    }
    return false;
}
/**
 * Determine whether an operation affects a subscription prefix, given the
 * document state immediately before the operation is applied.
 */
function operationAffects(subPrefix, op, doc) {
    switch (op.op) {
        case 'add':
        case 'remove':
        case 'replace':
            return pathAffects(subPrefix, op.path, op.op, doc);
        case 'test':
            // A test does not change the document, so it never notifies.
            return false;
        case 'move':
            return moveAffects(subPrefix, op.from, op.path, doc);
        case 'copy':
            // The source is only read; the target is added.
            return pathAffects(subPrefix, op.path, 'add', doc);
        default:
            return false;
    }
}
/**
 * A container of JSON Pointer prefix subscriptions.
 *
 * The container holds the current document. Callers subscribe to prefixes and
 * commit batches of RFC-6902 operations. After a successful commit, affected
 * subscribers are notified once with the indices of the operations that
 * affected them.
 */
var SubscriptionContainer = /** @class */ (function () {
    function SubscriptionContainer(document) {
        this.subscriptions = [];
        this.nextId = 0;
        this.dispatching = false;
        this.pendingAdds = [];
        this.pendingRemoves = [];
        this.document = document;
    }
    /** The current document. */
    SubscriptionContainer.prototype.getDocument = function () {
        return this.document;
    };
    /**
     * Subscribe to a JSON Pointer prefix.
     *
     * Subscribing to `/items` subscribes to `/items` and everything below it.
     * The returned subscription can be passed to {@link unsubscribe}.
     */
    SubscriptionContainer.prototype.subscribe = function (prefix, callback) {
        if (typeof callback !== 'function') {
            throw new Error('Subscription callback must be a function');
        }
        var subscription = {
            id: this.nextId++,
            prefix: normalizePrefix(prefix),
            callback: callback
        };
        if (this.dispatching) {
            // Snapshot semantics: subscriptions added during a dispatch do not
            // receive notifications for the batch currently being dispatched.
            this.pendingAdds.push(subscription);
        }
        else {
            this.subscriptions.push(subscription);
        }
        return subscription;
    };
    /**
     * Remove a subscription. Safe to call from within a notification callback.
     */
    SubscriptionContainer.prototype.unsubscribe = function (subscription) {
        var id = subscription.id;
        if (id === undefined) {
            return;
        }
        if (this.dispatching) {
            // Snapshot semantics: removals during a dispatch take effect after the
            // current batch has been dispatched.
            this.pendingRemoves.push(id);
        }
        else {
            var idx = this.subscriptions.findIndex(function (s) { return s.id === id; });
            if (idx !== -1) {
                this.subscriptions.splice(idx, 1);
            }
        }
    };
    /**
     * Commit a batch of operations.
     *
     * The batch is validated and applied to an isolated copy of the document.
     * If any operation fails, the document is left untouched and no
     * notifications are sent. On success, the document is replaced and each
     * affected subscriber is notified once with the indices of the matching
     * operations.
     */
    SubscriptionContainer.prototype.commit = function (patch) {
        // Validate the whole batch first (dry-run on a clone inside `validate`).
        var validationError = validate(patch, this.document);
        if (validationError) {
            return { success: false, error: validationError };
        }
        // Apply to an isolated copy, computing matches against the document state
        // immediately before each operation.
        var clone = _deepClone(this.document);
        var affected = new Map();
        try {
            for (var i = 0; i < patch.length; i++) {
                var op = patch[i];
                for (var _i = 0, _a = this.subscriptions; _i < _a.length; _i++) {
                    var sub = _a[_i];
                    if (operationAffects(sub.prefix, op, clone)) {
                        var matches = affected.get(sub.id);
                        if (!matches) {
                            matches = [];
                            affected.set(sub.id, matches);
                        }
                        matches.push(i);
                    }
                }
                applyOperation(clone, op, true, true, true, i);
            }
        }
        catch (e) {
            // Application failed: leave the committed document untouched.
            if (e instanceof Error) {
                return { success: false, error: e };
            }
            throw e;
        }
        // Commit the new document.
        this.document = clone;
        // Dispatch over a snapshot so that subscriptions added or removed during
        // the callbacks do not alter the batch being sent.
        var snapshot = this.subscriptions.slice();
        this.dispatching = true;
        try {
            for (var _b = 0, snapshot_1 = snapshot; _b < snapshot_1.length; _b++) {
                var sub = snapshot_1[_b];
                var matches = affected.get(sub.id);
                if (matches && matches.length > 0) {
                    sub.callback({ subscription: sub, matches: matches, document: this.document });
                }
            }
        }
        finally {
            this.dispatching = false;
            // Capture the subscriptions added/removed during dispatch (after the
            // callbacks ran), then apply them so they take effect on the next batch.
            var pendingAdds = this.pendingAdds.splice(0);
            var pendingRemoves = this.pendingRemoves.splice(0);
            for (var _c = 0, pendingAdds_1 = pendingAdds; _c < pendingAdds_1.length; _c++) {
                var add = pendingAdds_1[_c];
                this.subscriptions.push(add);
            }
            var _loop_1 = function (r) {
                var id = pendingRemoves[r];
                var idx = this_1.subscriptions.findIndex(function (s) { return s.id === id; });
                if (idx !== -1) {
                    this_1.subscriptions.splice(idx, 1);
                }
            };
            var this_1 = this;
            for (var r = 0; r < pendingRemoves.length; r++) {
                _loop_1(r);
            }
        }
        return { success: true, document: this.document };
    };
    return SubscriptionContainer;
}());
export { SubscriptionContainer };
