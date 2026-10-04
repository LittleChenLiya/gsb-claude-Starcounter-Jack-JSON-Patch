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
import {
  Operation,
  applyOperation,
  validate,
  getValueByPointer
} from './core.js';
import { _deepClone, isInteger, unescapePathComponent } from './helpers.js';

/**
 * A subscription to a JSON Pointer prefix.
 */
export interface Subscription<T> {
  /** The subscribed JSON Pointer prefix ('' means the root document). */
  readonly prefix: string;
  /** The callback invoked when the subscription is affected by a commit. */
  readonly callback: SubscriptionCallback<T>;
}

/**
 * Notification payload delivered to an affected subscriber.
 */
export interface SubscriptionNotification<T> {
  /** The subscription that was affected. */
  subscription: Subscription<T>;
  /** Indices (into the committed batch) of the operations that affected this subscription. */
  matches: number[];
  /** The document after the whole batch was applied. */
  document: T;
}

export type SubscriptionCallback<T> = (notification: SubscriptionNotification<T>) => void;

export interface CommitResult<T> {
  success: boolean;
  /** The error, when the batch failed validation or application. */
  error?: Error;
  /** The document after the batch was applied (only present on success). */
  document?: T;
}

interface InternalSubscription<T> extends Subscription<T> {
  id: number;
}

/**
 * Normalize a JSON Pointer prefix: trim whitespace and ensure it either is the
 * empty string (root) or starts with '/'.
 */
function normalizePrefix(prefix: string): string {
  if (typeof prefix !== 'string') {
    throw new Error('Subscription prefix must be a string');
  }
  const trimmed = prefix.trim();
  if (trimmed === '') {
    return '';
  }
  if (trimmed.charAt(0) !== '/') {
    return '/' + trimmed;
  }
  return trimmed;
}

/** Split a JSON Pointer into its unescaped tokens. */
function tokenize(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  const raw = pointer.split('/');
  raw.shift(); // drop the empty element before the first '/'
  for (let i = 0; i < raw.length; i++) {
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
function prefixAffects(subPrefix: string, fragPath: string): boolean {
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

interface ArrayLocation {
  parent: any;
  parentTokens: string[];
  index: number;
}

/**
 * If `path` points at an integer index inside an array in `doc`, return the
 * array location. Otherwise return null.
 */
function arrayLocation(path: string, doc: any): ArrayLocation | null {
  if (path === '') {
    return null;
  }
  const lastSlash = path.lastIndexOf('/');
  const indexToken = path.substring(lastSlash + 1);
  if (!isInteger(indexToken)) {
    return null;
  }
  const parentPath = path.substring(0, lastSlash);
  const parent = parentPath === '' ? doc : getValueByPointer(doc, parentPath);
  if (!Array.isArray(parent)) {
    return null;
  }
  return { parent, parentTokens: tokenize(parentPath), index: parseInt(indexToken, 10) };
}

/**
 * Return the integer index of `subPrefix` inside the array described by
 * `parentTokens`, or null when the subscription does not point at that array.
 */
function subIndexAt(subPrefix: string, parentTokens: string[]): number | null {
  const tokens = tokenize(subPrefix);
  if (tokens.length < parentTokens.length + 1) {
    return null;
  }
  for (let i = 0; i < parentTokens.length; i++) {
    if (tokens[i] !== parentTokens[i]) {
      return null;
    }
  }
  const indexToken = tokens[parentTokens.length];
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
function arrayShiftAffects(subPrefix: string, fragPath: string, mode: 'add' | 'remove', doc: any): boolean {
  const loc = arrayLocation(fragPath, doc);
  if (!loc) {
    return false;
  }
  const subIndex = subIndexAt(subPrefix, loc.parentTokens);
  if (subIndex === null) {
    return false;
  }
  return subIndex >= loc.index;
}

/**
 * Impact rule for a single path fragment of an operation.
 */
function pathAffects(subPrefix: string, fragPath: string, mode: 'add' | 'remove' | 'replace', doc: any): boolean {
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
function moveAffects(subPrefix: string, fromPath: string, toPath: string, doc: any): boolean {
  if (prefixAffects(subPrefix, fromPath)) {
    return true;
  }
  if (prefixAffects(subPrefix, toPath)) {
    return true;
  }
  const from = arrayLocation(fromPath, doc);
  const to = arrayLocation(toPath, doc);
  if (from && to && from.parent === to.parent) {
    const subIndex = subIndexAt(subPrefix, from.parentTokens);
    if (subIndex === null) {
      return false;
    }
    const lo = Math.min(from.index, to.index);
    const hi = Math.max(from.index, to.index);
    return subIndex >= lo && subIndex <= hi;
  }
  if (from) {
    const fromIndex = subIndexAt(subPrefix, from.parentTokens);
    if (fromIndex !== null && fromIndex >= from.index) {
      return true;
    }
  }
  if (to) {
    const toIndex = subIndexAt(subPrefix, to.parentTokens);
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
function operationAffects<T>(subPrefix: string, op: Operation, doc: T): boolean {
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
export class SubscriptionContainer<T> {
  private document: T;
  private subscriptions: InternalSubscription<T>[] = [];
  private nextId = 0;
  private dispatching = false;
  private readonly pendingAdds: InternalSubscription<T>[] = [];
  private readonly pendingRemoves: number[] = [];

  constructor(document: T) {
    this.document = document;
  }

  /** The current document. */
  getDocument(): T {
    return this.document;
  }

  /**
   * Subscribe to a JSON Pointer prefix.
   *
   * Subscribing to `/items` subscribes to `/items` and everything below it.
   * The returned subscription can be passed to {@link unsubscribe}.
   */
  subscribe(prefix: string, callback: SubscriptionCallback<T>): Subscription<T> {
    if (typeof callback !== 'function') {
      throw new Error('Subscription callback must be a function');
    }
    const subscription: InternalSubscription<T> = {
      id: this.nextId++,
      prefix: normalizePrefix(prefix),
      callback
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
  }

  /**
   * Remove a subscription. Safe to call from within a notification callback.
   */
  unsubscribe(subscription: Subscription<T>): void {
    const id = (subscription as InternalSubscription<T>).id;
    if (id === undefined) {
      return;
    }
    if (this.dispatching) {
      // Snapshot semantics: removals during a dispatch take effect after the
      // current batch has been dispatched.
      this.pendingRemoves.push(id);
    }
    else {
      const idx = this.subscriptions.findIndex(s => s.id === id);
      if (idx !== -1) {
        this.subscriptions.splice(idx, 1);
      }
    }
  }

  /**
   * Commit a batch of operations.
   *
   * The batch is validated and applied to an isolated copy of the document.
   * If any operation fails, the document is left untouched and no
   * notifications are sent. On success, the document is replaced and each
   * affected subscriber is notified once with the indices of the matching
   * operations.
   */
  commit(patch: ReadonlyArray<Operation>): CommitResult<T> {
    // Validate the whole batch first (dry-run on a clone inside `validate`).
    const validationError = validate(patch as Operation[], this.document);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // Apply to an isolated copy, computing matches against the document state
    // immediately before each operation.
    const clone: T = _deepClone(this.document);
    const affected = new Map<number, number[]>();
    try {
      for (let i = 0; i < patch.length; i++) {
        const op = patch[i];
        for (const sub of this.subscriptions) {
          if (operationAffects(sub.prefix, op, clone)) {
            let matches = affected.get(sub.id);
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
    const snapshot = this.subscriptions.slice();
    this.dispatching = true;
    try {
      for (const sub of snapshot) {
        const matches = affected.get(sub.id);
        if (matches && matches.length > 0) {
          sub.callback({ subscription: sub, matches, document: this.document });
        }
      }
    }
    finally {
      this.dispatching = false;
      // Capture the subscriptions added/removed during dispatch (after the
      // callbacks ran), then apply them so they take effect on the next batch.
      const pendingAdds = this.pendingAdds.splice(0);
      const pendingRemoves = this.pendingRemoves.splice(0);
      for (const add of pendingAdds) {
        this.subscriptions.push(add);
      }
      for (let r = 0; r < pendingRemoves.length; r++) {
        const id = pendingRemoves[r];
        const idx = this.subscriptions.findIndex(s => s.id === id);
        if (idx !== -1) {
          this.subscriptions.splice(idx, 1);
        }
      }
    }

    return { success: true, document: this.document };
  }
}
