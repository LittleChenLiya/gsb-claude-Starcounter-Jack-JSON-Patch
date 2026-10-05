/*!
 * https://github.com/Starcounter-Jack/JSON-Patch
 * (c) 2013-2022 Joachim Wester
 * MIT license
 */

/**
 * Explicitly signed patch packages ("sealed packages").
 *
 * A signed patch package pins:
 *   - the canonical encoding protocol version (`protocol`),
 *   - the digest of the baseline document the patch was sealed against (`baseline`),
 *   - the full JSON-Patch (`patch`),
 *   - a `signature` produced by an injected signer backend.
 *
 * Signing and verification are NOT implemented here; they are delegated to an
 * injected backend ({@link PatchSigner} / {@link PatchVerifier}). This module
 * only defines the canonical encoding, the digests, the package shape and the
 * verify-before-apply flow.
 *
 * The full encoding protocol is specified in `docs/signed-patch.md`
 * (protocol id `fast-json-patch.signed/1`). In short:
 *   - object keys are sorted (UTF-16 code unit order), array order is preserved;
 *   - non-JSON values (undefined, functions, symbols, bigint, class instances)
 *     are rejected;
 *   - non-finite numbers and unsafe integers are rejected;
 *   - verification always happens before applying, and a baseline mismatch or
 *     a signature failure leaves the target state untouched (`applied === 0`);
 *   - sealing deep-clones the patch, so mutating the original patch afterwards
 *     does not affect the sealed package;
 *   - the default `applyPatch` from `./core.js` is left unchanged.
 */

import { applyPatch, Operation, OperationResult } from './core.js';
import { _deepClone } from './helpers.js';

/** Canonical encoding / package protocol version. */
export const SIGNED_PATCH_PROTOCOL = 'fast-json-patch.signed/1';

/** Identifier of the built-in digest algorithm (prefix of every default digest). */
export const SIGNED_PATCH_DIGEST_ALGORITHM = 'cyrb53';

export type SignedPatchErrorName =
    'CANONICAL_NON_JSON_VALUE' |
    'CANONICAL_NON_FINITE_NUMBER' |
    'CANONICAL_UNSAFE_INTEGER' |
    'CANONICAL_NON_PLAIN_OBJECT' |
    'SIGNER_INVALID' |
    'SIGNATURE_NOT_A_STRING';

export class SignedPatchError extends Error {
    constructor(public message: string, public name: SignedPatchErrorName) {
        super(message);
        Object.setPrototypeOf(this, SignedPatchError.prototype); // restore prototype chain, see https://stackoverflow.com/a/48342359
    }
}

/**
 * Hash of a canonical encoding. Injectable via {@link SignedPatchOptions};
 * defaults to {@link defaultHash}.
 */
export interface HashFunction {
    (canonical: string): string;
}

/** Injected signing backend. */
export interface PatchSigner {
    /** Returns a signature over the canonical signed payload. */
    sign(payload: string): string;
}

/** Injected verification backend. */
export interface PatchVerifier {
    /** Returns true iff `signature` is valid for the canonical signed payload. */
    verify(payload: string, signature: string): boolean;
}

/** The sealed, explicitly signed patch package. */
export interface SignedPatchPackage {
    /** Canonical encoding protocol version, always {@link SIGNED_PATCH_PROTOCOL}. */
    protocol: string;
    /** Digest of the canonical encoding of the baseline document. */
    baseline: string;
    /** The full JSON-Patch, deep-cloned (and key-normalized) at seal time. */
    patch: Operation[];
    /** Signature over the canonical signed payload, produced by the injected signer. */
    signature: string;
}

export interface SignedPatchOptions {
    /** Custom digest of a canonical encoding. Defaults to {@link defaultHash}. */
    hash?: HashFunction;
}

export interface ApplySignedResult<T> {
    /** Number of patch operations applied. 0 when verification, the baseline check or the application itself failed. */
    applied: number;
    /** Whether the package signature verified against the injected verifier. */
    verified: boolean;
    /** Whether the target document matched the package baseline digest. */
    baselineMatch: boolean;
    /** The patched document. On any failure this is the untouched input document. */
    newDocument: T;
    /** Per-operation results (only present when `applied > 0`). */
    results?: OperationResult<T>[];
    /** The error thrown while applying a verified, baseline-matching package (only present on application failure). */
    error?: any;
}

/* ------------------------------------------------------------------ */
/* Canonical encoding (protocol `fast-json-patch.signed/1`)            */
/* ------------------------------------------------------------------ */

function encodeNumber(value: number): string {
    if (!isFinite(value)) {
        throw new SignedPatchError('Cannot canonically encode a non-finite number: ' + value, 'CANONICAL_NON_FINITE_NUMBER');
    }
    if (Math.floor(value) === value && !Number.isSafeInteger(value)) {
        throw new SignedPatchError('Cannot canonically encode an unsafe integer: ' + value, 'CANONICAL_UNSAFE_INTEGER');
    }
    // JSON.stringify produces the shortest round-trip form and normalizes -0 to "0".
    return JSON.stringify(value);
}

function encodeArray(value: any[]): string {
    const parts = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
        parts[i] = canonicalEncode(value[i]); // array order is preserved
    }
    return '[' + parts.join(',') + ']';
}

function encodeObject(value: any): string {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        throw new SignedPatchError('Cannot canonically encode a non-plain object (only plain JSON objects are allowed)', 'CANONICAL_NON_PLAIN_OBJECT');
    }
    const keys = Object.keys(value).sort(); // UTF-16 code unit order
    const parts = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
        parts[i] = JSON.stringify(keys[i]) + ':' + canonicalEncode(value[keys[i]]);
    }
    return '{' + parts.join(',') + '}';
}

/**
 * Canonical JSON encoding of a value per protocol `fast-json-patch.signed/1`:
 * object keys sorted, array order preserved, no whitespace, non-JSON values
 * and unsafe integers rejected. The output is always valid JSON.
 *
 * @param value the JSON value to encode
 * @return the canonical encoding
 * @throws SignedPatchError on non-JSON values, non-finite numbers or unsafe integers
 */
export function canonicalEncode(value: any): string {
    switch (typeof value) {
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            return encodeNumber(value);
        case 'string':
            return JSON.stringify(value);
        case 'object':
            if (value === null) {
                return 'null';
            }
            return Array.isArray(value) ? encodeArray(value) : encodeObject(value);
        default: // 'undefined', 'function', 'symbol', 'bigint'
            throw new SignedPatchError('Cannot canonically encode a non-JSON value of type "' + typeof value + '"', 'CANONICAL_NON_JSON_VALUE');
    }
}

/* ------------------------------------------------------------------ */
/* Digest                                                              */
/* ------------------------------------------------------------------ */

function toUtf8Bytes(str: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        }
        else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                i++;
            }
            else { // lone surrogate -> U+FFFD
                bytes.push(0xef, 0xbf, 0xbd);
            }
        }
        else if (code >= 0xdc00 && code <= 0xdfff) { // lone surrogate -> U+FFFD
            bytes.push(0xef, 0xbf, 0xbd);
        }
        else {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
    }
    return bytes;
}

/* cyrb53 (public domain, (c) 2018 bryc, https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js) over UTF-8 bytes */
function cyrb53(bytes: number[], seed: number): number {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ bytes[i], 2654435761);
        h2 = Math.imul(h2 ^ bytes[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Default digest of a canonical encoding: `cyrb53:` followed by the 53-bit
 * cyrb53 hash (seed 0) of the UTF-8 bytes of the canonical encoding, as
 * zero-padded 14-digit lowercase hex.
 */
export function defaultHash(canonical: string): string {
    const hex = cyrb53(toUtf8Bytes(canonical), 0).toString(16);
    return SIGNED_PATCH_DIGEST_ALGORITHM + ':' + '00000000000000'.slice(hex.length) + hex;
}

/**
 * Digest of the canonical encoding of any JSON value.
 */
export function canonicalDigest(value: any, options?: SignedPatchOptions): string {
    const hash = options && options.hash || defaultHash;
    return hash(canonicalEncode(value));
}

/**
 * Digest of the baseline document a package is sealed against / applied to.
 */
export function digestBaseline(document: any, options?: SignedPatchOptions): string {
    return canonicalDigest(document, options);
}

/* ------------------------------------------------------------------ */
/* Seal / verify / apply                                               */
/* ------------------------------------------------------------------ */

function packagePayload(protocol: string, baseline: string, patch: any): string {
    // key order here is irrelevant: canonicalEncode sorts object keys
    return canonicalEncode({ baseline: baseline, patch: patch, protocol: protocol });
}

/**
 * The exact canonical payload that is signed and verified:
 * the canonical encoding of `{baseline, patch, protocol}`.
 */
export function signedPayload(pkg: SignedPatchPackage): string {
    return packagePayload(pkg.protocol, pkg.baseline, pkg.patch);
}

/**
 * Seals `patch` against `baselineDocument` into an explicitly signed package.
 * The patch is validated by the canonical encoder and deep-cloned (via the
 * canonical encoding), so later mutations of the original patch - or of the
 * baseline document - do not affect the sealed package.
 *
 * @param baselineDocument the document the patch is meant to be applied to
 * @param patch the full JSON-Patch
 * @param signer the injected signing backend
 * @param options optional custom hash
 * @return the sealed package
 */
export function sealPatch(baselineDocument: any, patch: ReadonlyArray<Operation>, signer: PatchSigner, options?: SignedPatchOptions): SignedPatchPackage {
    if (!signer || typeof signer.sign !== 'function') {
        throw new SignedPatchError('A signer backend with a `sign(payload)` function must be injected', 'SIGNER_INVALID');
    }
    const baseline = digestBaseline(baselineDocument, options);
    // canonicalEncode validates the patch (rejecting non-JSON values and unsafe
    // integers) and its output is valid JSON, so parsing it back yields a
    // key-normalized deep clone, immune to later mutations of the original.
    const sealedPatch = JSON.parse(canonicalEncode(patch));
    const signature = signer.sign(packagePayload(SIGNED_PATCH_PROTOCOL, baseline, sealedPatch));
    if (typeof signature !== 'string') {
        throw new SignedPatchError('The signer backend must return a string signature', 'SIGNATURE_NOT_A_STRING');
    }
    return {
        protocol: SIGNED_PATCH_PROTOCOL,
        baseline: baseline,
        patch: sealedPatch,
        signature: signature
    };
}

/**
 * Verifies a sealed package against the injected verifier backend.
 * Returns false (never throws) for malformed packages, wrong protocol
 * versions, non-encodable patches or invalid signatures.
 */
export function verifyPackage(pkg: SignedPatchPackage, verifier: PatchVerifier, options?: SignedPatchOptions): boolean {
    try {
        if (!pkg || typeof pkg !== 'object') {
            return false;
        }
        if (pkg.protocol !== SIGNED_PATCH_PROTOCOL) {
            return false;
        }
        if (typeof pkg.baseline !== 'string' || !Array.isArray(pkg.patch) || typeof pkg.signature !== 'string') {
            return false;
        }
        if (!verifier || typeof verifier.verify !== 'function') {
            return false;
        }
        return verifier.verify(packagePayload(pkg.protocol, pkg.baseline, pkg.patch), pkg.signature) === true;
    }
    catch (e) {
        return false;
    }
}

/**
 * Verifies a sealed package and applies it to `document`.
 *
 * Verification always happens before applying:
 *   1. the signature is verified against the injected verifier;
 *   2. the baseline digest of `document` is compared to the package baseline;
 *   3. only then is the patch applied - to a deep clone, so the input
 *      document is never mutated, and any failure (signature, baseline or
 *      application) leaves the state untouched with `applied === 0`.
 *
 * @param document the target document (never mutated)
 * @param pkg the sealed package
 * @param verifier the injected verification backend
 * @param options optional custom hash (must match the one used at seal time)
 * @return the result; `applied` counts the applied operations
 */
export function applySignedPatch<T>(document: T, pkg: SignedPatchPackage, verifier: PatchVerifier, options?: SignedPatchOptions): ApplySignedResult<T> {
    if (!verifyPackage(pkg, verifier, options)) {
        return { applied: 0, verified: false, baselineMatch: false, newDocument: document };
    }
    let baselineMatch = false;
    try {
        baselineMatch = digestBaseline(document, options) === pkg.baseline;
    }
    catch (e) {
        baselineMatch = false; // the document itself is not canonically encodable
    }
    if (!baselineMatch) {
        return { applied: 0, verified: true, baselineMatch: false, newDocument: document };
    }
    const working = _deepClone(document);
    try {
        const results = applyPatch(working, _deepClone(pkg.patch), /*validateOperation*/ true, /*mutateDocument*/ true);
        return {
            applied: pkg.patch.length,
            verified: true,
            baselineMatch: true,
            newDocument: results.newDocument,
            results: Array.prototype.slice.call(results)
        };
    }
    catch (error) {
        // a verified, baseline-matching package whose application fails
        // (e.g. a failing `test` operation) must not change the state either
        return { applied: 0, verified: true, baselineMatch: true, newDocument: document, error: error };
    }
}
