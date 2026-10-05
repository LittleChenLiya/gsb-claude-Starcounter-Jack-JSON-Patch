/*!
 * Tests for the explicit signed patch package.
 *
 * These specs use the in-memory Ed25519 fixture (`signedPatchFixture.mjs`) so
 * they are fully deterministic and need no external service.
 */

import * as jsonpatch from '../../index.mjs';
import { createMemoryBackend } from './signedPatchFixture.mjs';

const PROTOCOL = jsonpatch.SIGNED_PATCH_PROTOCOL;

function expectReject(promise) {
    return promise.then(
        () => { throw new Error('Expected promise to be rejected'); },
        () => { /* expected */ }
    );
}

describe('signed patch package - sealing', () => {
    it('exposes the protocol version, baseline digest and complete patch', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1, b: { c: 2 } };
        const patch = [
            { op: 'replace', path: '/a', value: 42 },
            { op: 'add', path: '/b/d', value: 'x' }
        ];
        const pkg = await jsonpatch.sealPatch(doc, patch, backend);

        expect(pkg.protocol).toBe(PROTOCOL);
        expect(typeof pkg.baseline).toBe('string');
        expect(pkg.baseline.length).toBeGreaterThan(0);
        expect(Array.isArray(pkg.patch)).toBe(true);
        expect(pkg.patch.length).toBe(2);
        expect(typeof pkg.signature).toBe('string');
        expect(pkg.signature.length).toBeGreaterThan(0);
    });

    it('computes the baseline digest from the canonical document', async () => {
        const backend = createMemoryBackend();
        const doc = { b: 2, a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [], backend);
        const expected = backend.digest(jsonpatch.canonicalEncode(doc));
        expect(pkg.baseline).toBe(expected);
    });

    it('detaches the sealed patch from the input patch', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const patch = [{ op: 'replace', path: '/a', value: 42 }];
        const pkg = await jsonpatch.sealPatch(doc, patch, backend);

        patch[0].value = 100;
        patch.push({ op: 'remove', path: '/a' });

        expect(pkg.patch.length).toBe(1);
        expect(pkg.patch[0].value).toBe(42);

        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        expect(result.ok).toBe(true);
        expect(doc.a).toBe(42);
    });
});

describe('signed patch package - canonical encoding', () => {
    it('sorts object keys but preserves array order', () => {
        const a = { z: 1, a: 2, m: { y: 3, b: 4 } };
        const b = { a: 2, m: { b: 4, y: 3 }, z: 1 };
        expect(jsonpatch.canonicalEncode(a)).toBe(jsonpatch.canonicalEncode(b));

        const arr1 = [1, 2, 3];
        const arr2 = [3, 2, 1];
        expect(jsonpatch.canonicalEncode(arr1)).not.toBe(jsonpatch.canonicalEncode(arr2));
    });

    it('rejects non-JSON values', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };

        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: undefined }], backend));
        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: () => {} }], backend));
        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: Symbol('s') }], backend));
        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: NaN }], backend));
        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: Infinity }], backend));
    });

    it('rejects unsafe integers', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };

        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: 9007199254740992 }], backend));
        await expectReject(jsonpatch.sealPatch(doc, [{ op: 'add', path: '/x', value: -9007199254740992 }], backend));
    });

    it('accepts safe integers and finite numbers', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [
            { op: 'add', path: '/x', value: 9007199254740991 },
            { op: 'add', path: '/y', value: 1.5 },
            { op: 'add', path: '/z', value: -0 }
        ], backend);
        expect(pkg.patch.length).toBe(3);
    });

    it('rejects circular references', () => {
        const obj = { a: 1 };
        obj.self = obj;
        expect(() => jsonpatch.canonicalEncode(obj)).toThrow();
    });
});

describe('signed patch package - digests and signatures', () => {
    it('gives the same package digest for semantically equal documents with reordered keys', async () => {
        const backend = createMemoryBackend();
        const doc1 = { b: 2, a: 1, c: { z: 3, y: 4 } };
        const doc2 = { a: 1, c: { y: 4, z: 3 }, b: 2 };

        const pkg1 = await jsonpatch.sealPatch(doc1, [], backend);
        const pkg2 = await jsonpatch.sealPatch(doc2, [], backend);

        expect(pkg1.baseline).toBe(pkg2.baseline);
        expect(jsonpatch.canonicalEncode(doc1)).toBe(jsonpatch.canonicalEncode(doc2));
    });

    it('gives a different signature when patch operation order differs', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1, b: 2 };
        const patch1 = [
            { op: 'replace', path: '/a', value: 10 },
            { op: 'replace', path: '/b', value: 20 }
        ];
        const patch2 = [
            { op: 'replace', path: '/b', value: 20 },
            { op: 'replace', path: '/a', value: 10 }
        ];

        const pkg1 = await jsonpatch.sealPatch(doc, patch1, backend);
        const pkg2 = await jsonpatch.sealPatch(doc, patch2, backend);

        expect(pkg1.baseline).toBe(pkg2.baseline);
        expect(pkg1.signature).not.toBe(pkg2.signature);
    });

    it('rejects a package sealed under a different protocol version', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [], backend);
        pkg.protocol = 'some-other-protocol/v9';

        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        expect(result.ok).toBe(false);
        expect(result.applied).toBe(0);
        expect(doc.a).toBe(1);
    });
});

describe('signed patch package - apply', () => {
    it('applies a valid sealed package and reports the applied count', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1, b: { c: 2 } };
        const patch = [
            { op: 'replace', path: '/a', value: 42 },
            { op: 'add', path: '/b/d', value: 'x' }
        ];
        const pkg = await jsonpatch.sealPatch(doc, patch, backend);

        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        expect(result.ok).toBe(true);
        expect(result.applied).toBe(2);
        expect(doc.a).toBe(42);
        expect(doc.b.d).toBe('x');
    });

    it('applies to a deep-equal document (baseline digest binds to content)', async () => {
        const backend = createMemoryBackend();
        const baseline = { a: 1, nested: { x: 1 } };
        const pkg = await jsonpatch.sealPatch(baseline, [
            { op: 'replace', path: '/a', value: 9 }
        ], backend);

        const other = { a: 1, nested: { x: 1 } };
        const result = await jsonpatch.applySignedPatch(other, pkg, backend);
        expect(result.ok).toBe(true);
        expect(other.a).toBe(9);
    });

    it('applies zero operations and does not mutate when the package is tampered', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [
            { op: 'replace', path: '/a', value: 42 }
        ], backend);

        pkg.patch[0].value = 999;

        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        expect(result.ok).toBe(false);
        expect(result.applied).toBe(0);
        expect(doc.a).toBe(1);
    });

    it('applies zero operations and does not mutate when the signature is tampered', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [
            { op: 'replace', path: '/a', value: 42 }
        ], backend);

        pkg.signature = pkg.signature.replace(/A/g, 'B');

        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        expect(result.ok).toBe(false);
        expect(result.applied).toBe(0);
        expect(doc.a).toBe(1);
    });

    it('applies zero operations and does not mutate when the baseline changes', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [
            { op: 'replace', path: '/a', value: 42 }
        ], backend);

        const changed = { a: 2 };
        const result = await jsonpatch.applySignedPatch(changed, pkg, backend);
        expect(result.ok).toBe(false);
        expect(result.applied).toBe(0);
        expect(changed.a).toBe(2);
    });

    it('does not call applyPatch when verification fails', async () => {
        const backend = createMemoryBackend();
        const doc = { a: 1 };
        const pkg = await jsonpatch.sealPatch(doc, [
            { op: 'replace', path: '/a', value: 42 }
        ], backend);
        pkg.patch[0].value = 999;

        const spy = spyOn(jsonpatch, 'applyPatch').and.callThrough();
        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        expect(result.applied).toBe(0);
        expect(spy).not.toHaveBeenCalled();
        expect(doc.a).toBe(1);
    });

    it('leaves the default applyPatch behavior unchanged', () => {
        const doc = { a: 1 };
        const patch = [{ op: 'replace', path: '/a', value: 2 }];
        const result = jsonpatch.applyPatch(doc, patch);
        expect(doc.a).toBe(2);
        expect(result.newDocument.a).toBe(2);
    });
});
