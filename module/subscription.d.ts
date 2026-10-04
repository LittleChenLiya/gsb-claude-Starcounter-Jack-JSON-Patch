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
import { Operation } from './core.js';
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
export declare type SubscriptionCallback<T> = (notification: SubscriptionNotification<T>) => void;
export interface CommitResult<T> {
    success: boolean;
    /** The error, when the batch failed validation or application. */
    error?: Error;
    /** The document after the batch was applied (only present on success). */
    document?: T;
}
/**
 * A container of JSON Pointer prefix subscriptions.
 *
 * The container holds the current document. Callers subscribe to prefixes and
 * commit batches of RFC-6902 operations. After a successful commit, affected
 * subscribers are notified once with the indices of the operations that
 * affected them.
 */
export declare class SubscriptionContainer<T> {
    private document;
    private subscriptions;
    private nextId;
    private dispatching;
    private readonly pendingAdds;
    private readonly pendingRemoves;
    constructor(document: T);
    /** The current document. */
    getDocument(): T;
    /**
     * Subscribe to a JSON Pointer prefix.
     *
     * Subscribing to `/items` subscribes to `/items` and everything below it.
     * The returned subscription can be passed to {@link unsubscribe}.
     */
    subscribe(prefix: string, callback: SubscriptionCallback<T>): Subscription<T>;
    /**
     * Remove a subscription. Safe to call from within a notification callback.
     */
    unsubscribe(subscription: Subscription<T>): void;
    /**
     * Commit a batch of operations.
     *
     * The batch is validated and applied to an isolated copy of the document.
     * If any operation fails, the document is left untouched and no
     * notifications are sent. On success, the document is replaced and each
     * affected subscriber is notified once with the indices of the matching
     * operations.
     */
    commit(patch: ReadonlyArray<Operation>): CommitResult<T>;
}
