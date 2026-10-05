/**
 * Specs for the explicitly signed patch packages (src/signedPatch.ts,
 * protocol `fast-json-patch.signed/1`, see docs/signed-patch.md).
 *
 * Runs both under the repo's jasmine runner and standalone:
 *   node test/spec/signedPatchSpec.mjs
 */
import * as jsonpatch from '../../index.mjs';
import { createInMemorySigner } from '../lib/inMemorySigner.mjs';

/* Minimal standalone shim so this file also runs with plain `node` (no jasmine installed). */
if (typeof describe === 'undefined') {
    const shim = (() => {
        let passed = 0, failed = 0;
        const path = [];
        const eq = (a, b) => jsonpatch._areEquals(a, b);
        const fmt = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
        globalThis.describe = (name, fn) => { path.push(name); fn(); path.pop(); };
        globalThis.it = (name, fn) => {
            try {
                fn();
                passed++;
                console.log('ok   - ' + path.concat(name).join(' > '));
            } catch (e) {
                failed++;
                console.error('FAIL - ' + path.concat(name).join(' > '));
                console.error(e && e.stack || e);
            }
        };
        globalThis.expect = (actual) => ({
            toBe: (e) => { if (actual !== e) throw new Error('expected ' + fmt(actual) + ' to be ' + fmt(e)); },
            toEqual: (e) => { if (!eq(actual, e)) throw new Error('expected ' + fmt(actual) + ' to equal ' + fmt(e)); },
            toBeTruthy: () => { if (!actual) throw new Error('expected ' + fmt(actual) + ' to be truthy'); },
            toBeFalsy: () => { if (actual) throw new Error('expected ' + fmt(actual) + ' to be falsy'); },
            toContain: (s) => { if (String(actual).indexOf(s) === -1) throw new Error('expected ' + fmt(actual) + ' to contain ' + fmt(s)); },
            toThrow: () => {
                let threw = false;
                try { actual(); } catch (e) { threw = true; }
                if (!threw) throw new Error('expected function to throw');
            },
            not: {
                toBe: (e) => { if (actual === e) throw new Error('expected ' + fmt(actual) + ' not to be ' + fmt(e)); },
                toEqual: (e) => { if (eq(actual, e)) throw new Error('expected ' + fmt(actual) + ' not to equal ' + fmt(e)); }
            }
        });
        process.on('exit', () => {
            console.log(passed + ' passed, ' + failed + ' failed');
            if (failed) process.exitCode = 1;
        });
    })();
}

const {
    SIGNED_PATCH_PROTOCOL,
    canonicalEncode,
    canonicalDigest,
    digestBaseline,
    sealPatch,
    verifyPackage,
    applySignedPatch,
    signedPayload
} = jsonpatch;

const baselineDoc = () => ({
    user: { name: 'Marilyn', tags: ['a', 'b'] },
    count: 3,
    nested: { z: 1, a: [true, null, 2.5] }
});

const samplePatch = () => [
    { op: 'replace', path: '/user/name', value: 'Monroe' },
    { op: 'add', path: '/user/tags/-', value: 'c' },
    { op: 'remove', path: '/count' }
];

describe('signedPatch canonical encoding', function () {
    it('sorts object keys but preserves array order', function () {
        expect(canonicalEncode({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
        expect(canonicalEncode([2, 1])).toBe('[2,1]');
        expect(canonicalEncode([1, 2])).not.toBe(canonicalEncode([2, 1]));
        expect(canonicalEncode({ arr: [{ y: 1, x: 2 }] })).toBe('{"arr":[{"x":2,"y":1}]}');
    });

    it('encodes scalars canonically (-0 normalized to 0)', function () {
        expect(canonicalEncode(null)).toBe('null');
        expect(canonicalEncode(true)).toBe('true');
        expect(canonicalEncode('a"b')).toBe('"a\\"b"');
        expect(canonicalEncode(-0)).toBe('0');
        expect(canonicalEncode(2.5)).toBe('2.5');
        expect(canonicalEncode(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    });

    it('rejects non-JSON values', function () {
        expect(() => canonicalEncode(undefined)).toThrow();
        expect(() => canonicalEncode(() => 1)).toThrow();
        expect(() => canonicalEncode(Symbol('s'))).toThrow();
        expect(() => canonicalEncode({ a: undefined })).toThrow();
        expect(() => canonicalEncode([undefined])).toThrow();
        expect(() => canonicalEncode(new Date(0))).toThrow();
    });

    it('rejects non-finite numbers and unsafe integers', function () {
        expect(() => canonicalEncode(NaN)).toThrow();
        expect(() => canonicalEncode(Infinity)).toThrow();
        expect(() => canonicalEncode(-Infinity)).toThrow();
        expect(() => canonicalEncode(Math.pow(2, 53))).toThrow();
        expect(() => canonicalEncode({ big: Math.pow(2, 53) + 2 })).toThrow();
    });
});

describe('signedPatch sealing and digests', function () {
    it('produces identical baseline digests for semantically equal documents with reordered keys', function () {
        const a = { user: { name: 'Marilyn', tags: ['a', 'b'] }, count: 3 };
        const b = { count: 3, user: { tags: ['a', 'b'], name: 'Marilyn' } };
        expect(digestBaseline(a)).toBe(digestBaseline(b));
        expect(digestBaseline(a)).toContain('cyrb53:');

        const signer = createInMemorySigner('s3cret');
        const pkgA = sealPatch(a, samplePatch(), signer);
        const pkgB = sealPatch(b, samplePatch(), signer);
        expect(pkgA.baseline).toBe(pkgB.baseline);
        expect(pkgA.signature).toBe(pkgB.signature); // same canonical payload
        expect(pkgA.protocol).toBe(SIGNED_PATCH_PROTOCOL);
    });

    it('produces different digests when array order differs', function () {
        expect(digestBaseline({ t: ['a', 'b'] })).not.toBe(digestBaseline({ t: ['b', 'a'] }));
    });

    it('produces a different signature when the patch operation order differs', function () {
        const signer = createInMemorySigner('s3cret');
        const doc = baselineDoc();
        const forward = [
            { op: 'replace', path: '/user/name', value: 'Monroe' },
            { op: 'remove', path: '/count' }
        ];
        const reversed = [
            { op: 'remove', path: '/count' },
            { op: 'replace', path: '/user/name', value: 'Monroe' }
        ];
        const pkgA = sealPatch(doc, forward, signer);
        const pkgB = sealPatch(doc, reversed, signer);
        expect(pkgA.baseline).toBe(pkgB.baseline); // same baseline
        expect(pkgA.signature).not.toBe(pkgB.signature); // operation order is pinned
        expect(signedPayload(pkgA)).not.toBe(signedPayload(pkgB));
    });

    it('is not affected by mutating the original patch or baseline after sealing', function () {
        const signer = createInMemorySigner('s3cret');
        const doc = baselineDoc();
        const patch = samplePatch();
        const pkg = sealPatch(doc, patch, signer);
        const snapshot = JSON.stringify(pkg);

        // mutate the originals after sealing
        patch[0].value = 'HACKED';
        patch.push({ op: 'remove', path: '/user' });
        doc.count = 999;

        expect(JSON.stringify(pkg)).toBe(snapshot); // sealed package unchanged
        expect(verifyPackage(pkg, signer)).toBe(true); // and still valid
    });

    it('rejects patches containing non-JSON values or unsafe integers at seal time', function () {
        const signer = createInMemorySigner('s3cret');
        expect(() => sealPatch({}, [{ op: 'add', path: '/a', value: undefined }], signer)).toThrow();
        expect(() => sealPatch({}, [{ op: 'add', path: '/a', value: Math.pow(2, 53) }], signer)).toThrow();
        expect(() => sealPatch({ bad: NaN }, samplePatch(), signer)).toThrow();
        expect(() => sealPatch({}, samplePatch(), null)).toThrow();
    });
});

describe('signedPatch verification', function () {
    it('verifies a freshly sealed package', function () {
        const signer = createInMemorySigner('s3cret');
        const pkg = sealPatch(baselineDoc(), samplePatch(), signer);
        expect(verifyPackage(pkg, signer)).toBe(true);
    });

    it('rejects tampered packages', function () {
        const signer = createInMemorySigner('s3cret');
        const pkg = sealPatch(baselineDoc(), samplePatch(), signer);

        const tamperedPatch = JSON.parse(JSON.stringify(pkg));
        tamperedPatch.patch[0].value = 'HACKED';
        expect(verifyPackage(tamperedPatch, signer)).toBe(false);

        const tamperedBaseline = Object.assign({}, pkg, { baseline: digestBaseline({ other: 1 }) });
        expect(verifyPackage(tamperedBaseline, signer)).toBe(false);

        const tamperedSignature = Object.assign({}, pkg, { signature: 'memsig1:cyrb53:00000000000000' });
        expect(verifyPackage(tamperedSignature, signer)).toBe(false);

        const wrongProtocol = Object.assign({}, pkg, { protocol: 'fast-json-patch.signed/0' });
        expect(verifyPackage(wrongProtocol, signer)).toBe(false);
    });

    it('rejects malformed packages and wrong verifiers without throwing', function () {
        const signer = createInMemorySigner('s3cret');
        const other = createInMemorySigner('different-secret');
        const pkg = sealPatch(baselineDoc(), samplePatch(), signer);
        expect(verifyPackage(pkg, other)).toBe(false);
        expect(verifyPackage(null, signer)).toBe(false);
        expect(verifyPackage({}, signer)).toBe(false);
        expect(verifyPackage({ protocol: SIGNED_PATCH_PROTOCOL, baseline: 'x', patch: 'nope', signature: 'y' }, signer)).toBe(false);
        expect(verifyPackage(pkg, null)).toBe(false);
    });
});

describe('signedPatch apply (verify before apply)', function () {
    it('applies a valid package and counts the applied operations without mutating the input', function () {
        const signer = createInMemorySigner('s3cret');
        const doc = baselineDoc();
        const before = JSON.stringify(doc);
        const pkg = sealPatch(doc, samplePatch(), signer);

        const result = applySignedPatch(doc, pkg, signer);
        expect(result.applied).toBe(3);
        expect(result.verified).toBe(true);
        expect(result.baselineMatch).toBe(true);
        expect(result.newDocument.user.name).toBe('Monroe');
        expect(result.newDocument.user.tags).toEqual(['a', 'b', 'c']);
        expect(result.newDocument.count).toBe(undefined);
        expect(JSON.stringify(doc)).toBe(before); // input untouched
        expect(signer.calls.verify >= 1).toBe(true); // verification happened
    });

    it('applies 0 operations and keeps the state when the package was tampered with', function () {
        const signer = createInMemorySigner('s3cret');
        const doc = baselineDoc();
        const before = JSON.stringify(doc);
        const pkg = sealPatch(doc, samplePatch(), signer);
        pkg.patch[0].value = 'HACKED'; // tamper after sealing

        const result = applySignedPatch(doc, pkg, signer);
        expect(result.applied).toBe(0);
        expect(result.verified).toBe(false);
        expect(result.newDocument).toBe(doc); // same reference, no clone swapped in
        expect(JSON.stringify(doc)).toBe(before);
    });

    it('applies 0 operations and keeps the state when the baseline does not match', function () {
        const signer = createInMemorySigner('s3cret');
        const pkg = sealPatch(baselineDoc(), samplePatch(), signer);
        const otherDoc = baselineDoc();
        otherDoc.count = 42; // swapped baseline
        const before = JSON.stringify(otherDoc);

        const result = applySignedPatch(otherDoc, pkg, signer);
        expect(result.applied).toBe(0);
        expect(result.verified).toBe(true);
        expect(result.baselineMatch).toBe(false);
        expect(JSON.stringify(otherDoc)).toBe(before);
    });

    it('applies 0 operations and keeps the state when a verified package fails mid-apply (test operation)', function () {
        const signer = createInMemorySigner('s3cret');
        const doc = baselineDoc();
        const before = JSON.stringify(doc);
        const pkg = sealPatch(doc, [
            { op: 'replace', path: '/user/name', value: 'Monroe' },
            { op: 'test', path: '/count', value: 999 } // fails
        ], signer);

        const result = applySignedPatch(doc, pkg, signer);
        expect(result.applied).toBe(0);
        expect(result.verified).toBe(true);
        expect(result.baselineMatch).toBe(true);
        expect(result.error).toBeTruthy();
        expect(JSON.stringify(doc)).toBe(before); // atomic: no partial application
    });

    it('supports an injected custom hash', function () {
        const hash = (canonical) => 'test-hash:' + canonical.length;
        const signer = createInMemorySigner('s3cret');
        const doc = baselineDoc();
        const pkg = sealPatch(doc, samplePatch(), signer, { hash });
        expect(pkg.baseline).toContain('test-hash:');

        const result = applySignedPatch(doc, pkg, signer, { hash });
        expect(result.applied).toBe(3);

        // the same package does not apply under a different hash
        const mismatch = applySignedPatch(doc, pkg, signer);
        expect(mismatch.applied).toBe(0);
    });
});

describe('default applyPatch remains unchanged', function () {
    it('still mutates the document in place by default', function () {
        const doc = { a: 1 };
        const result = jsonpatch.applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }]);
        expect(doc.b).toBe(2); // in-place mutation, as before
        expect(result.newDocument).toBe(doc);
    });
});
