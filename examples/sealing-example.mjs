/*!
 * Sealing example for the explicit signed patch package.
 *
 * Runs entirely in one process using the in-memory Ed25519 fixture: it seals a
 * patch, applies it, and then shows that tampering with the package makes the
 * apply fail with an applied count of 0.
 *
 * Run with:
 *   node examples/sealing-example.mjs
 */

import * as jsonpatch from '../index.mjs';
import { createMemoryBackend } from '../test/spec/signedPatchFixture.mjs';

async function main() {
    const backend = createMemoryBackend();

    const doc = {
        title: 'Hello',
        tags: ['a'],
        meta: { version: 1, author: 'ada' }
    };

    const patch = [
        { op: 'replace', path: '/title', value: 'Hello, world' },
        { op: 'add', path: '/tags/-', value: 'b' },
        { op: 'replace', path: '/meta/version', value: 2 }
    ];

    console.log('--- Canonical baseline (keys sorted, arrays preserved) ---');
    console.log(jsonpatch.canonicalEncode(doc));
    console.log();

    console.log('--- Sealing ---');
    const pkg = await jsonpatch.sealPatch(doc, patch, backend);
    console.log(JSON.stringify(pkg, null, 2));
    console.log();

    console.log('--- Applying the sealed package ---');
    const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
    console.log('ok:', result.ok, ' applied:', result.applied);
    console.log('updated document:', JSON.stringify(result.newDocument));
    console.log();

    console.log('--- Tampering with the package ---');
    pkg.patch[0].value = 'tampered';
    const tampered = await jsonpatch.applySignedPatch(doc, pkg, backend);
    console.log('ok:', tampered.ok, ' applied:', tampered.applied, ' error:', tampered.error.message);
    console.log('document unchanged:', JSON.stringify(doc));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
