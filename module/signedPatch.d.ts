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
import { Operation, OperationResult } from './core.js';
/** Canonical encoding / package protocol version. */
export declare const SIGNED_PATCH_PROTOCOL = "fast-json-patch.signed/1";
/** Identifier of the built-in digest algorithm (prefix of every default digest). */
export declare const SIGNED_PATCH_DIGEST_ALGORITHM = "cyrb53";
export declare type SignedPatchErrorName = 'CANONICAL_NON_JSON_VALUE' | 'CANONICAL_NON_FINITE_NUMBER' | 'CANONICAL_UNSAFE_INTEGER' | 'CANONICAL_NON_PLAIN_OBJECT' | 'SIGNER_INVALID' | 'SIGNATURE_NOT_A_STRING';
export declare class SignedPatchError extends Error {
    message: string;
    name: SignedPatchErrorName;
    constructor(message: string, name: SignedPatchErrorName);
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
/**
 * Canonical JSON encoding of a value per protocol `fast-json-patch.signed/1`:
 * object keys sorted, array order preserved, no whitespace, non-JSON values
 * and unsafe integers rejected. The output is always valid JSON.
 *
 * @param value the JSON value to encode
 * @return the canonical encoding
 * @throws SignedPatchError on non-JSON values, non-finite numbers or unsafe integers
 */
export declare function canonicalEncode(value: any): string;
/**
 * Default digest of a canonical encoding: `cyrb53:` followed by the 53-bit
 * cyrb53 hash (seed 0) of the UTF-8 bytes of the canonical encoding, as
 * zero-padded 14-digit lowercase hex.
 */
export declare function defaultHash(canonical: string): string;
/**
 * Digest of the canonical encoding of any JSON value.
 */
export declare function canonicalDigest(value: any, options?: SignedPatchOptions): string;
/**
 * Digest of the baseline document a package is sealed against / applied to.
 */
export declare function digestBaseline(document: any, options?: SignedPatchOptions): string;
/**
 * The exact canonical payload that is signed and verified:
 * the canonical encoding of `{baseline, patch, protocol}`.
 */
export declare function signedPayload(pkg: SignedPatchPackage): string;
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
export declare function sealPatch(baselineDocument: any, patch: ReadonlyArray<Operation>, signer: PatchSigner, options?: SignedPatchOptions): SignedPatchPackage;
/**
 * Verifies a sealed package against the injected verifier backend.
 * Returns false (never throws) for malformed packages, wrong protocol
 * versions, non-encodable patches or invalid signatures.
 */
export declare function verifyPackage(pkg: SignedPatchPackage, verifier: PatchVerifier, options?: SignedPatchOptions): boolean;
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
export declare function applySignedPatch<T>(document: T, pkg: SignedPatchPackage, verifier: PatchVerifier, options?: SignedPatchOptions): ApplySignedResult<T>;
