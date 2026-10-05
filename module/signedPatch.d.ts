/*!
 * https://github.com/Starcounter-Jack/JSON-Patch
 * (c) 2013-2026 Joachim Wester
 * MIT license
 */
/**
 * # Signed Patch Package (explicit sealed patch)
 *
 * A "signed patch package" is a self-contained, tamper-evident envelope that
 * explicitly carries:
 *
 *   - the encoding protocol version (`protocol`),
 *   - the baseline digest (`baseline`),
 *   - the complete JSON Patch (`patch`),
 *   - a signature over the canonical encoding of the three (`signature`).
 *
 * The signature and digest are produced and verified by an *injected* backend
 * (`SignedPatchBackend`). The core module never depends on a concrete crypto
 * implementation, so the same code runs in the browser, in Node, or against a
 * remote signing service / HSM.
 *
 * The canonical encoding sorts object keys (so two semantically equal
 * documents always encode to the same string) but preserves array order (so
 * reordering patch operations changes the encoding). Non-JSON values and
 * unsafe integers are rejected. Verification always runs before apply: a
 * baseline mismatch or a failed signature leaves the document untouched.
 *
 * See `SIGNED_PATCH_PROTOCOL.md` for the full encoding specification.
 */
import { Operation, PatchResult } from './core.js';
/**
 * Identifier of the signed-patch encoding protocol.
 *
 * It is carried verbatim inside every sealed package and is part of the
 * signed payload, so a package produced by a different protocol version is
 * rejected at verification time.
 */
export declare const SIGNED_PATCH_PROTOCOL = "fast-json-patch/signed-patch/v1";
/**
 * Cryptographic backend injected into the signed-patch machinery.
 *
 * All three methods receive/produce *canonical* strings (see
 * `canonicalEncode`). `sign`/`verify` may be synchronous or asynchronous; the
 * sealed-patch helpers await their result.
 */
export interface SignedPatchBackend {
    /** Compute a digest (hash) of the given canonical string, returned as a string. */
    digest(canonical: string): string;
    /** Sign the given canonical payload string, returned as a string. */
    sign(canonical: string): string | Promise<string>;
    /** Verify a signature over a canonical payload string. */
    verify(canonical: string, signature: string): boolean | Promise<boolean>;
}
/**
 * A sealed, self-contained signed patch package.
 */
export interface SealedPatchPackage {
    /** Encoding protocol version (see `SIGNED_PATCH_PROTOCOL`). */
    protocol: string;
    /** Digest of the canonical baseline document. */
    baseline: string;
    /** The complete JSON Patch (RFC-6902) operations, in order. */
    patch: Operation[];
    /** Signature over the canonical encoding of `{protocol, baseline, patch}`. */
    signature: string;
}
/**
 * Result of attempting to apply a sealed patch package.
 *
 * On verification failure `ok` is `false`, `applied` is `0` and the document
 * is guaranteed to be untouched.
 */
export interface ApplySignedPatchResult<T> {
    ok: boolean;
    /** Number of operations applied. `0` when verification failed. */
    applied: number;
    newDocument?: T;
    results?: PatchResult<T>;
    error?: Error;
}
/**
 * Canonical, deterministic JSON encoding.
 *
 * Rules (see `SIGNED_PATCH_PROTOCOL.md` for the full specification):
 *
 * - object keys are sorted lexicographically (UTF-16 code unit) and emitted in
 *   that order, recursively;
 * - array order is preserved;
 * - strings are JSON-escaped;
 * - numbers must be finite; integers must be *safe*
 *   (`Number.isSafeInteger`); number serialization follows the ECMAScript
 *   `JSON.stringify` number representation;
 * - `undefined`, `function`, `symbol`, `bigint`, `NaN` and `Infinity` are
 *   rejected;
 * - circular references are rejected.
 *
 * @param value The JSON value to encode.
 * @return The canonical string.
 */
export declare function canonicalEncode(value: any): string;
/**
 * Seals a JSON Patch into an explicit signed patch package.
 *
 * The baseline digest is computed from the canonical encoding of `document`.
 * The patch is canonicalized (which rejects non-JSON values and unsafe
 * integers) and *detached* from the input: later mutations of the original
 * `patch` array do not affect the sealed package.
 *
 * @param document The baseline document the patch is based on.
 * @param patch The complete JSON Patch (RFC-6902) operations.
 * @param backend The injected signing backend.
 * @return The sealed package.
 */
export declare function sealPatch<T>(document: T, patch: Operation[], backend: SignedPatchBackend): Promise<SealedPatchPackage>;
/**
 * Verifies a sealed patch package against a document.
 *
 * Verification always runs before apply. It checks, in order:
 *
 *   1. the package structure and protocol version,
 *   2. the signature over the canonical payload,
 *   3. the baseline digest against the current document.
 *
 * Throws an `Error` on any failure. The document is never mutated by this
 * function.
 *
 * @param document The document the package is about to be applied to.
 * @param pkg The sealed package.
 * @param backend The injected signing backend.
 */
export declare function verifySignedPatch<T>(document: T, pkg: SealedPatchPackage, backend: SignedPatchBackend): Promise<void>;
/**
 * Verifies and applies a sealed patch package.
 *
 * Verification always runs before apply. If verification fails (bad
 * signature, tampered package or baseline mismatch) the document is left
 * untouched and the returned result has `applied: 0`.
 *
 * On success the patch is applied to `document` (mutating it, like
 * `applyPatch`) and the result carries the number of applied operations.
 *
 * @param document The document to patch.
 * @param pkg The sealed package.
 * @param backend The injected signing backend.
 * @return The apply result.
 */
export declare function applySignedPatch<T>(document: T, pkg: SealedPatchPackage, backend: SignedPatchBackend): Promise<ApplySignedPatchResult<T>>;
