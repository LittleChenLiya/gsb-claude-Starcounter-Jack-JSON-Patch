/**
 * Sealing example for explicitly signed patch packages
 * (protocol `fast-json-patch.signed/1`, see docs/signed-patch.md).
 *
 * Run with:  node examples/sealSignedPatch.mjs
 * Exits non-zero if any expectation fails.
 */
import {
    sealPatch,
    verifyPackage,
    applySignedPatch,
    signedPayload
} from '../index.mjs';
import { createInMemorySigner } from '../test/lib/inMemorySigner.mjs';

let failures = 0;
const check = (label, cond) => {
    console.log((cond ? 'ok   - ' : 'FAIL - ') + label);
    if (!cond) failures++;
};

// 1. the baseline document and the patch to seal
const baseline = {
    user: { name: 'Marilyn', tags: ['a', 'b'] },
    count: 3
};
const patch = [
    { op: 'replace', path: '/user/name', value: 'Monroe' },
    { op: 'add', path: '/user/tags/-', value: 'c' },
    { op: 'remove', path: '/count' }
];

// 2. seal with an injected signing backend (in-memory fixture here)
const signer = createInMemorySigner('example-secret');
const pkg = sealPatch(baseline, patch, signer);

console.log('\nsealed package:');
console.log(JSON.stringify(pkg, null, 2));
console.log('\nsigned payload (canonical encoding of {baseline, patch, protocol}):');
console.log(signedPayload(pkg));

check('package verifies against the sealing backend', verifyPackage(pkg, signer) === true);

// 3. mutating the original patch afterwards does not affect the sealed package
patch[0].value = 'HACKED';
check('sealed package immune to later mutation of the original patch',
    verifyPackage(pkg, signer) === true && pkg.patch[0].value === 'Monroe');

// 4. apply to a document matching the baseline
const target = { user: { name: 'Marilyn', tags: ['a', 'b'] }, count: 3 };
const applied = applySignedPatch(target, pkg, signer);
console.log('\napplied result:');
console.log(JSON.stringify({ applied: applied.applied, newDocument: applied.newDocument }, null, 2));
check('valid package applies all 3 operations', applied.applied === 3);
check('target document itself was not mutated', target.user.name === 'Marilyn');

// 5. tampered package -> nothing is applied
const tampered = JSON.parse(JSON.stringify(pkg));
tampered.patch[0].value = 'HACKED';
const tamperedResult = applySignedPatch(target, tampered, signer);
check('tampered package applies 0 operations', tamperedResult.applied === 0);

// 6. swapped baseline -> nothing is applied
const otherDoc = { user: { name: 'Marilyn', tags: ['a', 'b'] }, count: 999 };
const swappedResult = applySignedPatch(otherDoc, pkg, signer);
check('swapped baseline applies 0 operations', swappedResult.applied === 0);

console.log('\n' + (failures ? failures + ' FAILURES' : 'all checks passed'));
process.exit(failures ? 1 : 0);
