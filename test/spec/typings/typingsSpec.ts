/**
 * Run using `npm run test-typings`
 * The sole fact that this file compiles means that typings work
 * This follows how DefinitelyTyped tests work
 * @see https://stackoverflow.com/questions/49296151/how-to-write-tests-for-typescript-typing-definition
 */

import jsonpatch from '../../..';
import * as jsonpatchStar from '../../..';
import { applyPatch, Operation } from '../../..';

const document = { firstName: "Albert", contactDetails: { phoneNumbers: [] } };

const typedPatch = new Array<Operation>({ op: "replace", path: "/firstName", value: "Joachim" });
const untypedPatch = [{ op: "replace", path: "/firstName", value: "Joachim" }];

const test_jsonpatch = jsonpatch.applyPatch(document, typedPatch).newDocument;
const test_jsonpatchStar = jsonpatchStar.applyPatch(document, typedPatch).newDocument;
const test_applyPatch = applyPatch(document, typedPatch).newDocument;

// the below line would NOT compile with TSC
// const test_applyPatch = applyPatch(document, untypedPatch).newDocument;
// Signed patch package typings
import {
    SIGNED_PATCH_PROTOCOL,
    SignedPatchBackend,
    SealedPatchPackage,
    ApplySignedPatchResult,
    canonicalEncode,
    sealPatch,
    verifySignedPatch,
    applySignedPatch
} from '../../..';

const signedBackend: SignedPatchBackend = {
    digest(canonical: string): string { return canonical; },
    sign(canonical: string): string { return canonical; },
    verify(canonical: string, signature: string): boolean { return canonical === signature; }
};

const sealedPkg: Promise<SealedPatchPackage> = sealPatch(document, typedPatch, signedBackend);
const canonicalText: string = canonicalEncode(document);
const verifiedPkg: Promise<void> = verifySignedPatch(document, {} as SealedPatchPackage, signedBackend);
const appliedPkg: Promise<ApplySignedPatchResult<typeof document>> = applySignedPatch(document, {} as SealedPatchPackage, signedBackend);
const protocolVersion: string = SIGNED_PATCH_PROTOCOL;
