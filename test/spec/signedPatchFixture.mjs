/*!
 * In-memory signature fixture for the signed-patch tests and examples.
 *
 * It implements `SignedPatchBackend` using Node's built-in `node:crypto`:
 *
 *   - digest: SHA-256 (hex) of the canonical UTF-8 string,
 *   - sign:   Ed25519 signature (base64) with an in-memory key pair,
 *   - verify: Ed25519 verification with the matching public key.
 *
 * The key pair is generated in memory and never leaves the process. The
 * fixture is intentionally lightweight and deterministic enough for unit
 * tests: a fresh instance is created per spec so tests cannot interfere with
 * each other.
 */

import crypto from 'node:crypto';

/**
 * Creates a fresh in-memory `SignedPatchBackend`.
 *
 * @return {{digest: Function, sign: Function, verify: Function}}
 */
export function createMemoryBackend() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  return {
    /**
     * SHA-256 digest of the canonical string, returned as a lowercase hex
     * string.
     */
    digest(canonical) {
      return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    },

    /**
     * Ed25519 signature over the canonical string, returned as base64.
     */
    sign(canonical) {
      return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
    },

    /**
     * Verifies an Ed25519 signature (base64) over the canonical string.
     */
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
