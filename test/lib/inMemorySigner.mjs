/**
 * In-memory signing fixture for tests and examples.
 *
 * This is a deterministic, dependency-free toy backend: the "signature" is
 * the default digest of `secret + "|" + payload`, prefixed with `memsig1:`.
 * It is NOT cryptographically secure and must never be used outside of
 * tests/examples - real deployments inject an HMAC/KMS/asymmetric backend
 * with the same {sign, verify} shape.
 *
 * The fixture also counts sign/verify calls so tests can assert that
 * verification happens (and happens before anything is applied).
 */
import { defaultHash } from '../../module/signedPatch.mjs';

export function createInMemorySigner(secret) {
    const calls = { sign: 0, verify: 0 };
    const compute = (payload) => 'memsig1:' + defaultHash(String(secret) + '|' + payload);
    return {
        calls,
        sign(payload) {
            calls.sign++;
            return compute(payload);
        },
        verify(payload, signature) {
            calls.verify++;
            return typeof signature === 'string' && signature === compute(payload);
        }
    };
}
