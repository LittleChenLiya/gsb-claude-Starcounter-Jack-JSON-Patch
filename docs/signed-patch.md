# Explicitly Signed Patch Packages

Protocol id: **`fast-json-patch.signed/1`**
Implementation: `src/signedPatch.ts` (built to `module/signedPatch.mjs` and
`commonjs/signedPatch.js`, re-exported from the package root).

A *sealed package* explicitly pins the encoding protocol version, the digest
of the baseline document, and the full JSON-Patch, and carries a signature
produced by an **injected** signing backend. This module never signs or
verifies anything itself — it only defines the canonical encoding, the
digests, the package shape and the verify-before-apply flow.

## 1. Canonical encoding protocol (`fast-json-patch.signed/1`)

The canonical encoding of a JSON value is defined recursively. The output is
always itself valid JSON, with no insignificant whitespace.

| Type      | Encoding |
|-----------|----------|
| `null`    | `null` |
| boolean   | `true` / `false` |
| number    | `JSON.stringify(n)` (shortest round-trip form). `-0` is normalized to `0`. **Rejected:** `NaN`, `Infinity`, `-Infinity`, and any integer that is not a *safe integer* (`Number.isSafeInteger`). |
| string    | `JSON.stringify(s)` (RFC 8259 minimal escaping) |
| array     | `[e0,e1,...]` — elements in **original order** (array order is preserved) |
| object    | `{"k0":v0,"k1":v1,...}` — own enumerable string keys **sorted in UTF-16 code unit order** (ECMAScript `Array.prototype.sort()` default), each key `JSON.stringify`-ed |

**Rejected (encoding throws `SignedPatchError`):**

* `undefined`, functions, symbols, `bigint` — anywhere in the value tree;
* non-plain objects (anything whose prototype is neither `Object.prototype`
  nor `null`: `Date`, `Map`, class instances, ...);
* non-finite numbers and unsafe integers (see table above).

Consequences:

* Two documents that differ only in object key order encode identically
  (→ identical digests, identical package signatures).
* Two patches that differ in **operation order** encode differently
  (→ different signatures): arrays are order-sensitive.
* The encoding is injective for the admitted value domain, so it can be
  parsed back with `JSON.parse` to obtain a key-normalized deep clone.

## 2. Digest

`digest(value) = hash(canonicalEncode(value))`.

The default hash is **`cyrb53`** (public domain, seed 0) over the UTF-8
bytes of the canonical encoding, rendered as

```
cyrb53:<14 lowercase hex digits, zero-padded>   e.g. cyrb53:0c96793c0e31c2
```

The hash is injectable via `{ hash }` options (`SignedPatchOptions`) — e.g. to
substitute SHA-256 — as long as sealer and applier use the same one.

## 3. Package format

```json
{
  "protocol": "fast-json-patch.signed/1",
  "baseline": "cyrb53:0c96793c0e31c2",
  "patch": [ { "op": "replace", "path": "/user/name", "value": "Monroe" } ],
  "signature": "<backend-specific string>"
}
```

* `protocol` — the canonical encoding protocol version, fixed to
  `fast-json-patch.signed/1`. Packages with any other value are rejected.
* `baseline` — `digest(baselineDocument)` at seal time.
* `patch` — the full JSON-Patch (RFC 6902), deep-cloned and key-normalized
  at seal time.
* `signature` — `signer.sign(signedPayload)`.

**Signed payload** (the exact bytes that are signed and verified):

```
signedPayload = canonicalEncode({ "baseline": baseline, "patch": patch, "protocol": protocol })
```

i.e. the signature covers the protocol version, the baseline digest and the
full patch. Key order in this literal is irrelevant — the encoder sorts keys.

## 4. Injected backends

```ts
interface PatchSigner   { sign(payload: string): string }
interface PatchVerifier { verify(payload: string, signature: string): boolean }
```

Any HMAC/KMS/asymmetric implementation with this shape can be injected. An
in-memory fixture for tests and examples lives in
[`test/lib/inMemorySigner.mjs`](../test/lib/inMemorySigner.mjs)
(deterministic toy signer, **not** cryptographically secure):

```js
import { createInMemorySigner } from '../test/lib/inMemorySigner.mjs';
const signer = createInMemorySigner('s3cret'); // {sign, verify, calls}
```

## 5. API

* `canonicalEncode(value) -> string` — §1 encoding (throws on rejection).
* `canonicalDigest(value, options?)` / `digestBaseline(document, options?)` — §2.
* `signedPayload(pkg)` — the canonical signed payload of a package.
* `sealPatch(baselineDocument, patch, signer, options?) -> SignedPatchPackage`
  — validates the patch via the canonical encoder (rejecting non-JSON values
  and unsafe integers), deep-clones it, digests the baseline, signs the
  payload. Later mutation of the original patch or baseline document does
  **not** affect the sealed package.
* `verifyPackage(pkg, verifier, options?) -> boolean` — structural check +
  protocol check + signature verification; never throws.
* `applySignedPatch(document, pkg, verifier, options?) -> ApplySignedResult`
  — **verify before apply**:
  1. `verifyPackage` — on failure: `{ applied: 0, verified: false }`, state untouched;
  2. baseline digest of `document` compared to `pkg.baseline` — on mismatch:
     `{ applied: 0, verified: true, baselineMatch: false }`, state untouched;
  3. the patch is applied (with operation validation) to a **deep clone** of
     `document`; on success `{ applied: patch.length, newDocument }`. The input
     document is never mutated, and even a mid-apply failure (e.g. a failing
     `test` operation) returns `applied: 0` with the state untouched.

The default `applyPatch` from `core` is **not** modified in any way.

## 6. Sealing example

[`examples/sealSignedPatch.mjs`](../examples/sealSignedPatch.mjs):

```js
import { sealPatch, verifyPackage, applySignedPatch } from '../index.mjs';
import { createInMemorySigner } from '../test/lib/inMemorySigner.mjs';

const signer = createInMemorySigner('example-secret');
const baseline = { user: { name: 'Marilyn', tags: ['a', 'b'] }, count: 3 };
const patch = [
    { op: 'replace', path: '/user/name', value: 'Monroe' },
    { op: 'add', path: '/user/tags/-', value: 'c' },
    { op: 'remove', path: '/count' }
];

const pkg = sealPatch(baseline, patch, signer);
// pkg.baseline  === "cyrb53:0c96793c0e31c2"
// pkg.signature === "memsig1:cyrb53:099686f7248f57"

verifyPackage(pkg, signer);                       // true
applySignedPatch(baseline, pkg, signer).applied;  // 3
```

Actual output of `node examples/sealSignedPatch.mjs` (abridged):

```
sealed package:
{
  "protocol": "fast-json-patch.signed/1",
  "baseline": "cyrb53:0c96793c0e31c2",
  "patch": [
    { "op": "replace", "path": "/user/name", "value": "Monroe" },
    { "op": "add", "path": "/user/tags/-", "value": "c" },
    { "op": "remove", "path": "/count" }
  ],
  "signature": "memsig1:cyrb53:099686f7248f57"
}
signed payload:
{"baseline":"cyrb53:0c96793c0e31c2","patch":[{"op":"replace","path":"/user/name","value":"Monroe"},{"op":"add","path":"/user/tags/-","value":"c"},{"op":"remove","path":"/count"}],"protocol":"fast-json-patch.signed/1"}
ok   - package verifies against the sealing backend
ok   - sealed package immune to later mutation of the original patch
ok   - valid package applies all 3 operations
ok   - tampered package applies 0 operations
ok   - swapped baseline applies 0 operations
```

## 7. Node commands

```bash
# deterministic spec (runs standalone, no dependencies needed):
node test/spec/signedPatchSpec.mjs

# the same spec under the repo's jasmine runner (needs devDependencies):
node jasmine-run.mjs test/spec/signedPatchSpec.mjs

# sealing example:
node examples/sealSignedPatch.mjs

# or via npm:
npm run test-signed
```
