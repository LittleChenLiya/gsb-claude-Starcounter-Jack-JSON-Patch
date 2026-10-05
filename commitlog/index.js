'use strict';
/*
 * Durable append-only JSON-Patch commit log.
 *
 * Guarantees:
 *  - Each committed record stores: a consecutive sequence number (seq, starts
 *    at 1, no gaps allowed), the digest of the previous state (prev), and the
 *    JSON-Patch (RFC 6902) operations (patch).
 *  - A patch is first applied to a CLONE. The new state is published only
 *    after the record has been appended and durably flushed to disk. If the
 *    flush fails, nothing counts as committed and the published state stays at
 *    the previous revision.
 *  - Re-submitting the same seq with identical patch content returns the
 *    original receipt (idempotent retry); the same seq with different content
 *    is rejected.
 *  - Recovery replays records strictly in order. A corrupt record in the
 *    middle of the log stops recovery with an error. Only an incomplete tail
 *    record (the final write that was torn / never flushed) may be ignored.
 *  - The recovered state is cryptographically bound to the log identity (id)
 *    and to the original base state recorded in the log header.
 */

var fs = require('fs');
var fsp = fs.promises;
var path = require('path');
var crypto = require('crypto');
var jsonpatch = require('../commonjs/core.js');

var VERSION = 1;
var HEADER_PREFIX = 'commitlog v';
var ALGORITHM = 'sha256';

/**
 * Error thrown by the commit log. `code` is one of:
 *   EXISTS, NOT_FOUND, BAD_HEADER, ID_MISMATCH, BASE_MISMATCH,
 *   BAD_SEQ, SEQ_GAP, CONFLICT, CORRUPT, BAD_PATCH
 */
function CommitLogError(code, message) {
    var err = new Error(message);
    err.name = 'CommitLogError';
    err.code = code;
    return err;
}

function digestOf(value) {
    var canonical = stableStringify(value);
    return ALGORITHM + ':' + crypto.createHash(ALGORITHM).update(canonical).digest('hex');
}

/** Deterministic JSON serialization (object keys sorted recursively). */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        var arr = new Array(value.length);
        for (var i = 0; i < value.length; i++) {
            arr[i] = stableStringify(value[i]);
        }
        return '[' + arr.join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var parts = new Array(keys.length);
    for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        parts[j] = JSON.stringify(k) + ':' + stableStringify(value[k]);
    }
    return '{' + parts.join(',') + '}';
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function structuralEqual(a, b) {
    return stableStringify(a) === stableStringify(b);
}

function encodeHeader(options) {
    var header = {
        v: VERSION,
        id: String(options.id),
        alg: ALGORITHM,
        base: digestOf(options.base)
    };
    return HEADER_PREFIX + JSON.stringify(header);
}

function parseHeader(line) {
    var text = line.toString('utf8');
    if (text.slice(0, HEADER_PREFIX.length) !== HEADER_PREFIX) {
        throw CommitLogError('BAD_HEADER', 'log header is missing or unreadable');
    }
    var payload;
    try {
        payload = JSON.parse(text.slice(HEADER_PREFIX.length));
    } catch (e) {
        throw CommitLogError('BAD_HEADER', 'log header is not valid JSON');
    }
    if (!payload || payload.v !== VERSION || typeof payload.id !== 'string' ||
        typeof payload.base !== 'string' || typeof payload.alg !== 'string') {
        throw CommitLogError('BAD_HEADER', 'log header has unsupported shape or version');
    }
    return payload;
}

function CommitLog(filePath, header, state, nextSeq, durableSize) {
    this.filePath = filePath;
    this.id = header.id;
    this.algorithm = header.alg;
    this.baseDigest = header.base;
    this.state = state;
    this.nextSeq = nextSeq;
    this.durableSize = durableSize;
    this.receipts = Object.create(null);
    this.fd = null;
}

/**
 * Create a fresh log for a `base` state.
 * @param {string} filePath log file path
 * @param {string} id stable log identity; recovery is bound to this id
 * @param {*} base initial JSON document
 */
async function create(filePath, id, base) {
    if (id === undefined || id === null || String(id) === '') {
        throw CommitLogError('BAD_HEADER', 'a non-empty log id is required');
    }
    var baseCopy = clone(base);
    var headerLine = encodeHeader({ id: id, base: baseCopy });
    await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    var fh = await fsp.open(filePath, 'wx');
    try {
        await fh.writeFile(headerLine + '\n', 'utf8');
        // The header carries the log identity, so flush it before returning.
        await fh.sync();
    } catch (e) {
        await fh.close().catch(function () { });
        throw e;
    }
    await fh.close();
    var parsed = parseHeader(Buffer.from(headerLine, 'utf8'));
    var log = new CommitLog(filePath, parsed, baseCopy, 1, Buffer.byteLength(headerLine + '\n', 'utf8'));
    log.fd = await fsp.open(filePath, 'r+');
    return log;
}

/**
 * Open an existing log and replay it against the caller-supplied `base`.
 *
 * Recovery rules:
 *  - the header id and base digest must match the supplied identity and base;
 *  - sequence numbers must be 1..N with no gaps;
 *  - each record's `prev` digest and the resulting state digest must verify;
 *  - a bad record that is fully on disk (in the middle, or even the last
 *    complete line) aborts recovery; only a torn final line is ignored.
 */
async function open(filePath, id, base) {
    var fh = null;
    var data;
    try {
        fh = await fsp.open(filePath, 'r');
        data = await fh.readFile();
        await fh.close();
    } catch (e) {
        if (fh) { await fh.close().catch(function () { }); }
        if (e.code === 'ENOENT') {
            throw CommitLogError('NOT_FOUND', 'commit log does not exist: ' + filePath);
        }
        throw e;
    }

    var firstNl = data.indexOf(0x0a);
    if (firstNl === -1) {
        // A torn header leaves the log without an identity: unrecoverable.
        throw CommitLogError('BAD_HEADER', 'log header is incomplete (torn write)');
    }
    var header = parseHeader(data.slice(0, firstNl));

    if (id !== undefined && id !== null && String(id) !== header.id) {
        throw CommitLogError('ID_MISMATCH',
            'log id mismatch: header="' + header.id + '" supplied="' + id + '"');
    }
    var suppliedBaseDigest = digestOf(base);
    if (suppliedBaseDigest !== header.base) {
        throw CommitLogError('BASE_MISMATCH',
            'base state does not match the base recorded when this log was created');
    }

    var state = clone(base);
    var expectedSeq = 1;
    var prevDigest = header.base;
    var durableSize = firstNl + 1;
    var pos = durableSize;
    var receipts = Object.create(null);

    while (pos < data.length) {
        var nl = data.indexOf(0x0a, pos);
        if (nl === -1) {
            // Trailing bytes with no newline: a torn, never-committed tail.
            // This is the ONLY thing recovery is allowed to ignore.
            break;
        }
        var line = data.slice(pos, nl);
        var record;
        try {
            record = JSON.parse(line.toString('utf8'));
        } catch (e) {
            throw CommitLogError('CORRUPT',
                'corrupt record at seq ' + expectedSeq + ' (invalid JSON)');
        }
        if (!record || typeof record.seq !== 'number' ||
            typeof record.prev !== 'string' || !Array.isArray(record.patch)) {
            throw CommitLogError('CORRUPT',
                'corrupt record at seq ' + expectedSeq + ' (bad shape)');
        }
        if (record.seq !== expectedSeq) {
            throw CommitLogError('SEQ_GAP',
                'sequence gap detected: expected ' + expectedSeq + ' found ' + record.seq);
        }
        if (record.prev !== prevDigest) {
            throw CommitLogError('CORRUPT',
                'prev-state digest mismatch at seq ' + expectedSeq);
        }
        var candidate;
        try {
            candidate = applyPatchToClone(state, record.patch);
        } catch (e) {
            throw CommitLogError('BAD_PATCH',
                'patch at seq ' + expectedSeq + ' does not apply: ' + e.message);
        }
        var candidateDigest = digestOf(candidate);
        if (record.digest !== candidateDigest) {
            throw CommitLogError('CORRUPT',
                'resulting-state digest mismatch at seq ' + expectedSeq);
        }
        state = candidate;
        prevDigest = candidateDigest;
        receipts[expectedSeq] = makeReceipt(header, record, candidateDigest);
        pos = nl + 1;
        durableSize = pos;
        expectedSeq += 1;
    }

    var log = new CommitLog(filePath, header, state, expectedSeq, durableSize);
    log.receipts = receipts;
    // The torn tail is incomplete and never committed: drop it physically so
    // later appends cannot leave stale bytes after a good record.
    var reaper = await fsp.open(filePath, 'r+');
    try {
        await reaper.truncate(durableSize);
        await reaper.sync();
    } finally {
        await reaper.close();
    }
    log.fd = await fsp.open(filePath, 'r+');
    return log;
}

function applyPatchToClone(state, patch) {
    var working = clone(state);
    // mutateDocument=true with operation validation; throws on invalid patch.
    var results = jsonpatch.applyPatch(working, clone(patch), true, true, true);
    return results.newDocument;
}

function makeReceipt(header, record, stateDigest) {
    return {
        id: header.id,
        seq: record.seq,
        prev: record.prev,
        patch: clone(record.patch),
        digest: stateDigest
    };
}

CommitLog.prototype.getState = function () {
    return clone(this.state);
};

CommitLog.prototype.close = async function () {
    if (this.fd) {
        await this.fd.close();
        this.fd = null;
    }
};

/**
 * Commit a patch.
 *
 * @param {Array} patch array of RFC 6902 operations
 * @param {object} options
 * @param {number} options.seq required sequence number; must equal lastSeq + 1.
 *   Reusing an existing seq returns the prior receipt when the patch content
 *   is identical, and rejects with CONFLICT otherwise.
 * @param {number} [options.failWrite] test fault: write only this many bytes
 *   then fail (simulates a torn write mid-record).
 * @param {boolean} [options.failFlush] test fault: write the full record but
 *   fail before the durability point, then roll the file back.
 */
CommitLog.prototype.commit = async function (patch, options) {
    options = options || {};
    if (!Array.isArray(patch)) {
        throw CommitLogError('BAD_PATCH', 'patch must be an array of operations');
    }
    var seq = options.seq;
    if (typeof seq !== 'number' || seq !== Math.floor(seq)) {
        throw CommitLogError('BAD_SEQ', 'an integer sequence number is required');
    }

    // Idempotent retry: same seq + same content returns the original receipt
    // and never applies the patch a second time.
    if (Object.prototype.hasOwnProperty.call(this.receipts, seq)) {
        var prior = this.receipts[seq];
        if (structuralEqual(prior.patch, patch)) {
            return clone(prior);
        }
        throw CommitLogError('CONFLICT',
            'seq ' + seq + ' already committed with different patch content');
    }

    // Sequences must be contiguous (1, 2, 3 ...); gaps are rejected.
    if (seq !== this.nextSeq) {
        throw CommitLogError('SEQ_GAP',
            'out-of-order sequence: expected ' + this.nextSeq + ' got ' + seq);
    }

    var prevDigest = digestOf(this.state);
    var candidate;
    try {
        candidate = applyPatchToClone(this.state, patch);
    } catch (e) {
        var bad = CommitLogError('BAD_PATCH', 'patch does not apply: ' + e.message);
        bad.cause = e;
        throw bad;
    }
    var stateDigest = digestOf(candidate);

    var record = {
        seq: seq,
        prev: prevDigest,
        patch: clone(patch),
        digest: stateDigest
    };
    var line = JSON.stringify(record) + '\n';
    var payload = Buffer.from(line, 'utf8');

    if (!this.fd) {
        this.fd = await fsp.open(this.filePath, 'r+');
    }

    // Append and flush FIRST; the new state is published only after that.
    try {
        if (typeof options.failWrite === 'number' && options.failWrite >= 0) {
            var n = Math.min(options.failWrite, payload.length);
            if (n > 0) {
                await writeAll(this.fd, payload.slice(0, n), this.durableSize);
            }
            throw CommitLogError('CORRUPT', 'injected write failure after ' + n + ' bytes');
        }
        await writeAll(this.fd, payload, this.durableSize);

        if (options.failFlush) {
            // The flush failed: survival of these bytes is unknown, so they are
            // NOT committed. Roll the file back to the last durable size.
            await this.fd.sync().catch(function () { });
            await this.fd.truncate(this.durableSize);
            await this.fd.sync();
            throw CommitLogError('CORRUPT', 'injected flush failure; write rolled back');
        }

        // Remove any stale tail left by an earlier failed attempt in this
        // process, so the file ends exactly after the new record.
        await this.fd.truncate(this.durableSize + payload.length);
        await this.fd.sync();
    } catch (e) {
        // A failed or unknown flush is never counted as committed; the
        // in-memory published state is left untouched.
        throw e;
    }

    // Durable on disk -> now publish the new state and issue the receipt.
    this.state = candidate;
    this.durableSize += payload.length;
    this.nextSeq = seq + 1;
    var receipt = makeReceipt({ id: this.id }, record, stateDigest);
    this.receipts[seq] = clone(receipt);
    return receipt;
};

async function writeAll(fh, buffer, position) {
    var offset = 0;
    while (offset < buffer.length) {
        var written = await fh.write(buffer, offset, buffer.length - offset, position + offset);
        if (!written || written.bytesWritten <= 0) {
            throw CommitLogError('CORRUPT', 'short write while appending record');
        }
        offset += written.bytesWritten;
    }
}

module.exports = {
    create: create,
    open: open,
    digestOf: digestOf,
    stableStringify: stableStringify,
    CommitLogError: CommitLogError,
    ALGORITHM: ALGORITHM,
    VERSION: VERSION
};
