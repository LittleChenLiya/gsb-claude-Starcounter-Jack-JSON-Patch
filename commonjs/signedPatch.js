/*!
 * https://github.com/Starcounter-Jack/JSON-Patch
 * (c) 2013-2022 Joachim Wester
 * MIT license
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
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
var core_js_1 = require("./core.js");
var helpers_js_1 = require("./helpers.js");
/** Canonical encoding / package protocol version. */
exports.SIGNED_PATCH_PROTOCOL = 'fast-json-patch.signed/1';
/** Identifier of the built-in digest algorithm (prefix of every default digest). */
exports.SIGNED_PATCH_DIGEST_ALGORITHM = 'cyrb53';
var SignedPatchError = /** @class */ (function (_super) {
    __extends(SignedPatchError, _super);
    function SignedPatchError(message, name) {
        var _this = _super.call(this, message) || this;
        _this.message = message;
        _this.name = name;
        Object.setPrototypeOf(_this, SignedPatchError.prototype); // restore prototype chain, see https://stackoverflow.com/a/48342359
        return _this;
    }
    return SignedPatchError;
}(Error));
exports.SignedPatchError = SignedPatchError;
/* ------------------------------------------------------------------ */
/* Canonical encoding (protocol `fast-json-patch.signed/1`)            */
/* ------------------------------------------------------------------ */
function encodeNumber(value) {
    if (!isFinite(value)) {
        throw new SignedPatchError('Cannot canonically encode a non-finite number: ' + value, 'CANONICAL_NON_FINITE_NUMBER');
    }
    if (Math.floor(value) === value && !Number.isSafeInteger(value)) {
        throw new SignedPatchError('Cannot canonically encode an unsafe integer: ' + value, 'CANONICAL_UNSAFE_INTEGER');
    }
    // JSON.stringify produces the shortest round-trip form and normalizes -0 to "0".
    return JSON.stringify(value);
}
function encodeArray(value) {
    var parts = new Array(value.length);
    for (var i = 0; i < value.length; i++) {
        parts[i] = canonicalEncode(value[i]); // array order is preserved
    }
    return '[' + parts.join(',') + ']';
}
function encodeObject(value) {
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        throw new SignedPatchError('Cannot canonically encode a non-plain object (only plain JSON objects are allowed)', 'CANONICAL_NON_PLAIN_OBJECT');
    }
    var keys = Object.keys(value).sort(); // UTF-16 code unit order
    var parts = new Array(keys.length);
    for (var i = 0; i < keys.length; i++) {
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
function canonicalEncode(value) {
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
exports.canonicalEncode = canonicalEncode;
/* ------------------------------------------------------------------ */
/* Digest                                                              */
/* ------------------------------------------------------------------ */
function toUtf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        }
        else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            var next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                var cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
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
function cyrb53(bytes, seed) {
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0; i < bytes.length; i++) {
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
function defaultHash(canonical) {
    var hex = cyrb53(toUtf8Bytes(canonical), 0).toString(16);
    return exports.SIGNED_PATCH_DIGEST_ALGORITHM + ':' + '00000000000000'.slice(hex.length) + hex;
}
exports.defaultHash = defaultHash;
/**
 * Digest of the canonical encoding of any JSON value.
 */
function canonicalDigest(value, options) {
    var hash = options && options.hash || defaultHash;
    return hash(canonicalEncode(value));
}
exports.canonicalDigest = canonicalDigest;
/**
 * Digest of the baseline document a package is sealed against / applied to.
 */
function digestBaseline(document, options) {
    return canonicalDigest(document, options);
}
exports.digestBaseline = digestBaseline;
/* ------------------------------------------------------------------ */
/* Seal / verify / apply                                               */
/* ------------------------------------------------------------------ */
function packagePayload(protocol, baseline, patch) {
    // key order here is irrelevant: canonicalEncode sorts object keys
    return canonicalEncode({ baseline: baseline, patch: patch, protocol: protocol });
}
/**
 * The exact canonical payload that is signed and verified:
 * the canonical encoding of `{baseline, patch, protocol}`.
 */
function signedPayload(pkg) {
    return packagePayload(pkg.protocol, pkg.baseline, pkg.patch);
}
exports.signedPayload = signedPayload;
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
function sealPatch(baselineDocument, patch, signer, options) {
    if (!signer || typeof signer.sign !== 'function') {
        throw new SignedPatchError('A signer backend with a `sign(payload)` function must be injected', 'SIGNER_INVALID');
    }
    var baseline = digestBaseline(baselineDocument, options);
    // canonicalEncode validates the patch (rejecting non-JSON values and unsafe
    // integers) and its output is valid JSON, so parsing it back yields a
    // key-normalized deep clone, immune to later mutations of the original.
    var sealedPatch = JSON.parse(canonicalEncode(patch));
    var signature = signer.sign(packagePayload(exports.SIGNED_PATCH_PROTOCOL, baseline, sealedPatch));
    if (typeof signature !== 'string') {
        throw new SignedPatchError('The signer backend must return a string signature', 'SIGNATURE_NOT_A_STRING');
    }
    return {
        protocol: exports.SIGNED_PATCH_PROTOCOL,
        baseline: baseline,
        patch: sealedPatch,
        signature: signature
    };
}
exports.sealPatch = sealPatch;
/**
 * Verifies a sealed package against the injected verifier backend.
 * Returns false (never throws) for malformed packages, wrong protocol
 * versions, non-encodable patches or invalid signatures.
 */
function verifyPackage(pkg, verifier, options) {
    try {
        if (!pkg || typeof pkg !== 'object') {
            return false;
        }
        if (pkg.protocol !== exports.SIGNED_PATCH_PROTOCOL) {
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
exports.verifyPackage = verifyPackage;
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
function applySignedPatch(document, pkg, verifier, options) {
    if (!verifyPackage(pkg, verifier, options)) {
        return { applied: 0, verified: false, baselineMatch: false, newDocument: document };
    }
    var baselineMatch = false;
    try {
        baselineMatch = digestBaseline(document, options) === pkg.baseline;
    }
    catch (e) {
        baselineMatch = false; // the document itself is not canonically encodable
    }
    if (!baselineMatch) {
        return { applied: 0, verified: true, baselineMatch: false, newDocument: document };
    }
    var working = helpers_js_1._deepClone(document);
    try {
        var results = core_js_1.applyPatch(working, helpers_js_1._deepClone(pkg.patch), /*validateOperation*/ true, /*mutateDocument*/ true);
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
exports.applySignedPatch = applySignedPatch;
