/*!
 * https://github.com/Starcounter-Jack/JSON-Patch
 * (c) 2013-2026 Joachim Wester
 * MIT license
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
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
import { applyPatch } from './core.mjs';
/**
 * Identifier of the signed-patch encoding protocol.
 *
 * It is carried verbatim inside every sealed package and is part of the
 * signed payload, so a package produced by a different protocol version is
 * rejected at verification time.
 */
export var SIGNED_PATCH_PROTOCOL = 'fast-json-patch/signed-patch/v1';
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
export function canonicalEncode(value) {
    return encodeValue(value, new WeakSet());
}
function encodeValue(value, seen) {
    if (value === null) {
        return 'null';
    }
    var type = typeof value;
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
        var out = void 0;
        if (Array.isArray(value)) {
            var parts = new Array(value.length);
            for (var i = 0; i < value.length; i++) {
                parts[i] = encodeValue(value[i], seen);
            }
            out = '[' + parts.join(',') + ']';
        }
        else {
            var keys = Object.keys(value).sort();
            var parts = new Array(keys.length);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                var v = value[key];
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
export function sealPatch(document, patch, backend) {
    return __awaiter(this, void 0, void 0, function () {
        var i, op, canonicalPatch, patchValue, baselineDigest, payload, signature;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    assertBackend(backend);
                    if (!Array.isArray(patch)) {
                        throw new Error('SignedPatch: patch must be an array of operations');
                    }
                    for (i = 0; i < patch.length; i++) {
                        op = patch[i];
                        if (op === null || typeof op !== 'object' || Array.isArray(op)) {
                            throw new Error('SignedPatch: patch operation at index ' + i + ' must be an object');
                        }
                    }
                    canonicalPatch = canonicalEncode(patch);
                    patchValue = JSON.parse(canonicalPatch);
                    baselineDigest = backend.digest(canonicalEncode(document));
                    payload = {
                        protocol: SIGNED_PATCH_PROTOCOL,
                        baseline: baselineDigest,
                        patch: patchValue,
                    };
                    return [4 /*yield*/, backend.sign(canonicalEncode(payload))];
                case 1:
                    signature = _a.sent();
                    return [2 /*return*/, {
                            protocol: payload.protocol,
                            baseline: payload.baseline,
                            patch: payload.patch,
                            signature: signature,
                        }];
            }
        });
    });
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
export function verifySignedPatch(document, pkg, backend) {
    return __awaiter(this, void 0, void 0, function () {
        var payload, payloadCanonical, signatureValid, currentDigest;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
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
                    payload = {
                        protocol: pkg.protocol,
                        baseline: pkg.baseline,
                        patch: pkg.patch,
                    };
                    payloadCanonical = canonicalEncode(payload);
                    return [4 /*yield*/, backend.verify(payloadCanonical, pkg.signature)];
                case 1:
                    signatureValid = _a.sent();
                    if (!signatureValid) {
                        throw new Error('SignedPatch: signature verification failed');
                    }
                    currentDigest = backend.digest(canonicalEncode(document));
                    if (!safeEqual(currentDigest, pkg.baseline)) {
                        throw new Error('SignedPatch: baseline digest mismatch: the document does not match the sealed baseline');
                    }
                    return [2 /*return*/];
            }
        });
    });
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
export function applySignedPatch(document, pkg, backend) {
    return __awaiter(this, void 0, void 0, function () {
        var error_1, results;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, verifySignedPatch(document, pkg, backend)];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    error_1 = _a.sent();
                    return [2 /*return*/, {
                            ok: false,
                            applied: 0,
                            error: error_1 instanceof Error ? error_1 : new Error(String(error_1)),
                        }];
                case 3:
                    try {
                        results = applyPatch(document, pkg.patch, false, true);
                        return [2 /*return*/, {
                                ok: true,
                                applied: pkg.patch.length,
                                newDocument: results.newDocument,
                                results: results,
                            }];
                    }
                    catch (error) {
                        return [2 /*return*/, {
                                ok: false,
                                applied: 0,
                                error: error instanceof Error ? error : new Error(String(error)),
                            }];
                    }
                    return [2 /*return*/];
            }
        });
    });
}
function assertBackend(backend) {
    if (!backend || typeof backend.digest !== 'function' || typeof backend.sign !== 'function' || typeof backend.verify !== 'function') {
        throw new Error('SignedPatch: a SignedPatchBackend with digest(), sign() and verify() is required');
    }
}
/**
 * Constant-time string comparison (defends against timing attacks on digest
 * / signature comparison).
 */
function safeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    var mismatch = 0;
    for (var i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}
