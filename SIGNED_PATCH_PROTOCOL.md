# Signed Patch Package — Encoding Protocol

This document fully specifies the encoding protocol used by the **explicit
signed patch package** (`src/signedPatch.ts`). It covers the canonical
encoding, the digest, the signature payload, the sealed package format, and
the verification / apply procedure.

The key words "MUST", "MUST NOT", "SHOULD" and "MAY" are used as in RFC 2119.

## 1. Motivation

A normal JSON Patch (RFC-6902) is a plain array. It has no identity, no
binding to the document it was derived from, and no integrity protection. A
**signed patch package** makes all three explicit:

| Field      | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| `protocol` | The encoding protocol version.                                |
| `baseline` | A digest of the canonical baseline document.                  |
| `patch`    | The complete JSON Patch (RFC-6902), in order.                 |
| `signature`| A signature over the canonical encoding of the three above.  |

The signature and digest are produced and verified by an *injected* backend
(`SignedPatchBackend`). The core module never depends on a concrete crypto
implementation.

## 2. Protocol identifier

The current protocol identifier is the string:

```
fast-json-patch/signed-patch/v1
```

It is exported as `SIGNED_PATCH_PROTOCOL`. A package whose `protocol` field
does not equal this value MUST be rejected at verification time. The protocol
identifier is part of the signed payload, so an attacker cannot downgrade a
package to a different (weaker) version without invalidating the signature.

## 3. Canonical encoding

The canonical encoding is a deterministic, compact JSON text. Two values that
are semantically equal MUST encode to the same text; two values that are
semantically different MUST encode to different texts.

### 3.1. Object keys sorted, array order preserved

- **Objects**: the keys of an object are sorted lexicographically by UTF-16
  code unit (the default `Array.prototype.sort` order) and emitted in that
  order. Sorting is applied recursively.
- **Arrays**: the order of elements is preserved. Reordering array elements
  changes the encoding.

This is the single most important property: reordering the keys of an object
does not change the encoding, but reordering the operations of a patch (which
is an array) does.

Example — the following two objects encode identically:

```json
{ "b": 1, "a": { "y": 2, "x": 3 } }
```

```json
{ "a": { "x": 3, "y": 2 }, "b": 1 }
```

both encode to:

```
{"a":{"x":3,"y":2},"b":1}
```

### 3.2. Value rules

| Value                         | Behaviour                                                      |
| ----------------------------- | -------------------------------------------------------------- |
| `null`                        | Encoded as `null`.                                             |
| `true` / `false`              | Encoded as `true` / `false`.                                   |
| Strings                       | JSON-escaped (ECMAScript `JSON.stringify`).                    |
| Finite safe numbers           | Encoded per the ECMAScript `JSON.stringify` number representation (shortest round-trip). |
| `undefined`                   | REJECTED.                                                      |
| `function`                    | REJECTED.                                                      |
| `symbol`                      | REJECTED.                                                      |
| `bigint`                      | REJECTED.                                                      |
| `NaN`, `Infinity`, `-Infinity`| REJECTED (non-JSON numbers).                                   |
| Unsafe integers               | REJECTED. An integer is *safe* iff `Number.isSafeInteger(n)` is true (i.e. `-2^53 < n < 2^53`). |
| Circular references           | REJECTED.                                                      |

A property whose value is `undefined` is rejected (the encoder does not
silently drop it). Array elements are encoded in order; an `undefined` element
is rejected.

### 3.3. Number serialization

Numbers are serialized with the same representation as ECMAScript
`JSON.stringify(number)`: the shortest decimal string that round-trips to the
same numeric value. This representation is deterministic within a conforming
ECMAScript engine. Integers that are safe are serialized without an exponent;
very large (but still safe) integers MAY use an exponent.

### 3.4. Grammar

The canonical encoding is a JSON text with no insignificant whitespace. The
grammar is the standard JSON grammar with the additional constraints that
object member names are sorted and the value rules of §3.2 hold.

## 4. Digest

A digest is the output of `backend.digest(canonical)`, where `canonical` is the
canonical UTF-8 encoding of a value (§3). The digest is returned as a string.

The in-memory fixture uses SHA-256 and returns a lowercase hexadecimal
string (64 characters). The digest algorithm is not fixed by this protocol;
it is a property of the injected backend. The baseline digest binds the
package to the content of the baseline document, not to a particular object
identity: a deep-equal document produces the same digest.

## 5. Signature payload

The signature is computed over the canonical encoding of the following object:

```json
{
  "protocol": "fast-json-patch/signed-patch/v1",
  "baseline": "<digest of the canonical baseline document>",
  "patch": [ "<complete patch operations, in order>" ]
}
```

Because the payload is canonical-encoded, the order of the three top-level
keys is irrelevant (they are sorted), but the order of the patch operations is
significant (arrays preserve order).

The signature is `backend.sign(canonicalEncode(payload))` and is returned as a
string.

## 6. Sealed package format

A sealed package is a JSON object with exactly these four fields:

```json
{
  "protocol": "fast-json-patch/signed-patch/v1",
  "baseline": "<digest>",
  "patch": [ "<operations>" ],
  "signature": "<signature>"
}
```

The sealed package is self-contained: it carries the protocol version, the
baseline digest, and the complete patch. It does **not** carry the baseline
document itself; the verifier recomputes the baseline digest from the document
it is about to patch.

## 7. Sealing

`sealPatch(document, patch, backend)`:

1. Asserts that `backend` provides `digest`, `sign` and `verify`.
2. Asserts that `patch` is an array of objects.
3. Canonicalizes the patch (`canonicalEncode`), which rejects non-JSON values
   and unsafe integers, and parses the result back to obtain a *detached*
   copy. Mutating the original `patch` array after sealing MUST NOT change the
   sealed package.
4. Computes `baseline = backend.digest(canonicalEncode(document))`.
5. Builds the payload (§5) and computes `signature = backend.sign(canonicalEncode(payload))`.
6. Returns the sealed package (§6).

Sealing does not mutate `document` or `patch`.

## 8. Verification

`verifySignedPatch(document, pkg, backend)` runs entirely before any apply and
never mutates the document. It checks, in order:

1. `pkg` is an object;
2. `pkg.protocol === SIGNED_PATCH_PROTOCOL`;
3. `pkg.baseline` and `pkg.signature` are non-empty strings;
4. `pkg.patch` is an array;
5. **Signature**: `backend.verify(canonicalEncode({protocol, baseline, patch}), pkg.signature)`
   MUST be true;
6. **Baseline**: `backend.digest(canonicalEncode(document))` MUST equal
   `pkg.baseline` (constant-time comparison).

Any failure throws an `Error`.

## 9. Apply

`applySignedPatch(document, pkg, backend)`:

1. Runs verification (§8). If verification fails, it returns
   `{ ok: false, applied: 0, error }` and the document is left untouched.
2. On success, applies `pkg.patch` to `document` using the library's
   `applyPatch(document, pkg.patch, false, true)` (the default `applyPatch`
   behaviour is unchanged). It returns
   `{ ok: true, applied: pkg.patch.length, newDocument, results }`.

Because verification fully precedes apply and apply is only reached after
verification succeeds, a tampered package or a baseline mismatch results in
zero applied operations and no state change.

## 10. Security properties

- **Verify before apply**: the document is not touched until all verification
  checks pass.
- **No state change on failure**: a failed signature or a baseline mismatch
  leaves the document unchanged.
- **Detachment**: the sealed patch is a detached copy; later mutation of the
  original patch does not affect the sealed package.
- **Explicit protocol version**: the version is part of the signed payload.
- **Injected backend**: the core has no crypto dependency; the backend is
  supplied by the caller.
- **Canonicalization**: object keys are sorted, arrays preserve order, non-JSON
  values and unsafe integers are rejected.

## 11. Reference backend

The in-memory fixture (`test/spec/signedPatchFixture.mjs`) implements the
backend with Node's built-in `node:crypto`:

- `digest`: SHA-256, lowercase hex;
- `sign` / `verify`: Ed25519, base64 signatures, with an in-memory key pair.

The CLI (`bin/signed-patch.mjs`) persists an Ed25519 key pair as JWK so that
`seal` and `apply` can run in separate processes.
