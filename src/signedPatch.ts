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

import { applyPatch, Operation, OperationResult, PatchResult } from './core.js';

/**
 * Identifier of the signed-patch encoding protocol.
 *
 * It is carried verbatim inside every sealed package and is part of the
 * signed payload, so a package produced by a different protocol version is
 * rejected at verification time.
 */
export const SIGNED_PATCH_PROTOCOL = 'fast-json-patch/signed-patch/v1';

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
export function canonicalEncode(value: any): string {
  return encodeValue(value, new WeakSet<object>());
}

function encodeValue(value: any, seen: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('SignedPatch: non-JSON number is not allowed: ' + String(value));
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('SignedPatch: unsafe integer is not allowed: ' + String(value));
    }
    return JSON.stringify(value);
  }
  if (type === 'undefined') {
    throw new Error('SignedPatch: non-JSON value `undefined` is not allowed');
  }
  if (type === 'function') {
    throw new Error('SignedPatch: non-JSON value `function` is not allowed');
  }
  if (type === 'symbol') {
    throw new Error('SignedPatch: non-JSON value `symbol` is not allowed');
  }
  if (type === 'bigint') {
    throw new Error('SignedPatch: non-JSON value `bigint` is not allowed');
  }
  if (type === 'object') {
    if (seen.has(value)) {
      throw new Error('SignedPatch: circular reference is not allowed');
    }
    seen.add(value);
    let out: string;
    if (Array.isArray(value)) {
      const parts: string[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        parts[i] = encodeValue(value[i], seen);
      }
      out = '[' + parts.join(',') + ']';
    }
    else {
      const keys = Object.keys(value).sort();
      const parts: string[] = new Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const v = value[key];
        if (v === undefined) {
          seen.delete(value);
          throw new Error('SignedPatch: non-JSON value `undefined` is not allowed (key ' + key + ')');
        }
        parts[i] = JSON.stringify(key) + ':' + encodeValue(v, seen);
      }
      out = '{' + parts.join(',') + '}';
    }
    seen.delete(value);
    return out;
  }
  throw new Error('SignedPatch: unsupported value type: ' + type);
}

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
export async function sealPatch<T>(document: T, patch: Operation[], backend: SignedPatchBackend): Promise<SealedPatchPackage> {
  assertBackend(backend);
  if (!Array.isArray(patch)) {
    throw new Error('SignedPatch: patch must be an array of operations');
  }
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i];
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error('SignedPatch: patch operation at index ' + i + ' must be an object');
    }
  }

  // Canonicalize the patch. This both validates it (rejecting non-JSON values
  // and unsafe integers) and detaches the sealed copy from the caller array.
  const canonicalPatch = canonicalEncode(patch);
  const patchValue = JSON.parse(canonicalPatch) as Operation[];

  const baselineDigest = backend.digest(canonicalEncode(document));

  const payload = {
    protocol: SIGNED_PATCH_PROTOCOL,
    baseline: baselineDigest,
    patch: patchValue,
  };

  const signature = await backend.sign(canonicalEncode(payload));

  return {
    protocol: payload.protocol,
    baseline: payload.baseline,
    patch: payload.patch,
    signature,
  };
}

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
export async function verifySignedPatch<T>(document: T, pkg: SealedPatchPackage, backend: SignedPatchBackend): Promise<void> {
  assertBackend(backend);
  if (!pkg || typeof pkg !== 'object') {
    throw new Error('SignedPatch: invalid sealed package');
  }
  if (pkg.protocol !== SIGNED_PATCH_PROTOCOL) {
    throw new Error('SignedPatch: unsupported protocol version: ' + String(pkg.protocol));
  }
  if (typeof pkg.baseline !== 'string' || pkg.baseline.length === 0) {
    throw new Error('SignedPatch: invalid sealed package: missing baseline digest');
  }
  if (typeof pkg.signature !== 'string' || pkg.signature.length === 0) {
    throw new Error('SignedPatch: invalid sealed package: missing signature');
  }
  if (!Array.isArray(pkg.patch)) {
    throw new Error('SignedPatch: invalid sealed package: patch must be an array');
  }

  // 1. Authenticate the package first: the signature covers the protocol
  //    version, the baseline digest and the complete patch.
  const payload = {
    protocol: pkg.protocol,
    baseline: pkg.baseline,
    patch: pkg.patch,
  };
  const payloadCanonical = canonicalEncode(payload);
  const signatureValid = await backend.verify(payloadCanonical, pkg.signature);
  if (!signatureValid) {
    throw new Error('SignedPatch: signature verification failed');
  }

  // 2. Then bind the package to this document: the baseline digest must match.
  const currentDigest = backend.digest(canonicalEncode(document));
  if (!safeEqual(currentDigest, pkg.baseline)) {
    throw new Error('SignedPatch: baseline digest mismatch: the document does not match the sealed baseline');
  }
}

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
export async function applySignedPatch<T>(document: T, pkg: SealedPatchPackage, backend: SignedPatchBackend): Promise<ApplySignedPatchResult<T>> {
  try {
    await verifySignedPatch(document, pkg, backend);
  }
  catch (error) {
    return {
      ok: false,
      applied: 0,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  try {
    const results: PatchResult<T> = applyPatch(document, pkg.patch, false, true);
    return {
      ok: true,
      applied: pkg.patch.length,
      newDocument: results.newDocument,
      results,
    };
  }
  catch (error) {
    return {
      ok: false,
      applied: 0,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function assertBackend(backend: SignedPatchBackend): void {
  if (!backend || typeof backend.digest !== 'function' || typeof backend.sign !== 'function' || typeof backend.verify !== 'function') {
    throw new Error('SignedPatch: a SignedPatchBackend with digest(), sign() and verify() is required');
  }
}

/**
 * Constant-time string comparison (defends against timing attacks on digest
 * / signature comparison).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
