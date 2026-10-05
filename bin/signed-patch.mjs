#!/usr/bin/env node
/*!
 * Node command for the explicit signed patch package.
 *
 * Uses a persisted Ed25519 key pair (JWK) so that `seal` and `apply` can run
 * in separate processes. For an in-memory, single-process demo see
 * `examples/sealing-example.mjs` and the test fixture
 * `test/spec/signedPatchFixture.mjs`.
 *
 * Usage:
 *   signed-patch keygen <keyfile>
 *   signed-patch seal   <keyfile> <document.json> <patch.json> <package.json>
 *   signed-patch apply  <keyfile> <document.json> <package.json> [out.json]
 *   signed-patch digest <document.json>
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import * as jsonpatch from '../index.mjs';

const [command, ...args] = process.argv.slice(2);

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function loadBackend(keyfile) {
    const keys = readJson(keyfile);
    if (!keys.publicKey || !keys.privateKey) {
        throw new Error('Key file must contain publicKey and privateKey (JWK)');
    }
    const publicKey = crypto.createPublicKey({ key: keys.publicKey, format: 'jwk' });
    const privateKey = crypto.createPrivateKey({ key: keys.privateKey, format: 'jwk' });
    return {
        digest(canonical) {
            return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
        },
        sign(canonical) {
            return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
        },
        verify(canonical, signature) {
            return crypto.verify(
                null,
                Buffer.from(canonical, 'utf8'),
                publicKey,
                Buffer.from(signature, 'base64')
            );
        },
    };
}

async function main() {
    if (command === 'keygen') {
        const [keyfile] = args;
        if (!keyfile) throw new Error('Usage: signed-patch keygen <keyfile>');
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        writeJson(keyfile, {
            publicKey: publicKey.export({ format: 'jwk' }),
            privateKey: privateKey.export({ format: 'jwk' }),
        });
        console.log('Wrote Ed25519 key pair to ' + keyfile);
        return;
    }

    if (command === 'seal') {
        const [keyfile, docFile, patchFile, outFile] = args;
        if (!keyfile || !docFile || !patchFile || !outFile) {
            throw new Error('Usage: signed-patch seal <keyfile> <document.json> <patch.json> <package.json>');
        }
        const backend = loadBackend(keyfile);
        const doc = readJson(docFile);
        const patch = readJson(patchFile);
        const pkg = await jsonpatch.sealPatch(doc, patch, backend);
        writeJson(outFile, pkg);
        console.log('Sealed package written to ' + outFile);
        console.log('  protocol: ' + pkg.protocol);
        console.log('  baseline: ' + pkg.baseline);
        console.log('  patch operations: ' + pkg.patch.length);
        return;
    }

    if (command === 'apply') {
        const [keyfile, docFile, pkgFile, outFile] = args;
        if (!keyfile || !docFile || !pkgFile) {
            throw new Error('Usage: signed-patch apply <keyfile> <document.json> <package.json> [out.json]');
        }
        const backend = loadBackend(keyfile);
        const doc = readJson(docFile);
        const pkg = readJson(pkgFile);
        const result = await jsonpatch.applySignedPatch(doc, pkg, backend);
        if (!result.ok) {
            console.error('Apply failed: ' + result.error.message);
            process.exit(1);
        }
        console.log('Applied ' + result.applied + ' operation(s)');
        if (outFile) {
            writeJson(outFile, result.newDocument);
            console.log('Updated document written to ' + outFile);
        } else {
            console.log(JSON.stringify(result.newDocument, null, 2));
        }
        return;
    }

    if (command === 'digest') {
        const [docFile] = args;
        if (!docFile) throw new Error('Usage: signed-patch digest <document.json>');
        const doc = readJson(docFile);
        const digest = crypto.createHash('sha256')
            .update(jsonpatch.canonicalEncode(doc), 'utf8')
            .digest('hex');
        console.log(digest);
        return;
    }

    console.log('Usage: signed-patch <keygen|seal|apply|digest> [args]');
    process.exit(1);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
