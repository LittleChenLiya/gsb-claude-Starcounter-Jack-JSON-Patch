/*!
 * Small patch commit log (append-only JSONL) for fast-json-patch.
 *
 * Protocol:
 *  - Consecutive sequence numbers, no gaps.
 *  - Every record carries the pre-state summary (prev), the patch, the
 *    post-state summary (next) and a checksum (h).
 *  - A patch is first applied to a *copy* of the state; only after the
 *    record is fully persisted (write + fsync) is the in-memory state
 *    published. A failed persist is rolled back and never counts as
 *    committed.
 *  - Replaying the same sequence number with the same patch returns the
 *    original receipt (no re-apply); same seq with a different patch is
 *    rejected; gaps between sequence numbers are rejected.
 *  - Recovery replays the log against the original state. A torn
 *    (incomplete) tail record may be ignored and truncated; any bad
 *    record in the middle (or a complete-but-corrupt tail) is fatal.
 *  - logId is bound to the original state: logId = sha256(canonical(state)).
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { applyPatch } = require('../commonjs/core.js');

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class PatchLogError extends Error {
  constructor(message, props) {
    super(message);
    this.name = 'PatchLogError';
    Object.assign(this, props);
  }
}

class SeqConflictError extends PatchLogError {
  constructor(seq) {
    super('sequence ' + seq + ' already committed with a different patch', { seq: seq, code: 'SEQ_CONFLICT' });
    this.name = 'SeqConflictError';
  }
}

class SeqGapError extends PatchLogError {
  constructor(seq, expected) {
    super('sequence gap: got ' + seq + ', expected ' + expected + ' (gaps are forbidden)', { seq: seq, expected: expected, code: 'SEQ_GAP' });
    this.name = 'SeqGapError';
  }
}

class PatchApplyError extends PatchLogError {
  constructor(message, cause) {
    super(message, { code: 'PATCH_APPLY_FAILED', cause: cause });
    this.name = 'PatchApplyError';
  }
}

class LogCorruptError extends PatchLogError {
  constructor(message, props) {
    super(message, Object.assign({ code: 'LOG_CORRUPT' }, props));
    this.name = 'LogCorruptError';
  }
}

class CommitIOError extends PatchLogError {
  constructor(message, cause) {
    super(message, { code: 'COMMIT_IO_ERROR', committed: false, cause: cause });
    this.name = 'CommitIOError';
  }
}

class CommitTornError extends PatchLogError {
  constructor(message) {
    super(message, { code: 'COMMIT_TORN', committed: false });
    this.name = 'CommitTornError';
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys(value[k]);
    }
    return out;
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashState(state) {
  return sha256(canonical(state));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function checksumOf(record) {
  const copy = Object.assign({}, record);
  delete copy.h;
  return sha256(canonical(copy));
}

function receiptOf(record) {
  return {
    logId: record.logId,
    seq: record.seq,
    prev: record.prev,
    next: record.next,
    patchHash: hashState(record.patch),
    recordHash: record.h,
    ts: record.ts
  };
}

/* ------------------------------------------------------------------ */
/* PatchLog                                                            */
/* ------------------------------------------------------------------ */

class PatchLog {
  constructor(file, initialState) {
    this.file = file;
    this.originalState = clone(initialState);
    this.state = clone(initialState);
    this.logId = hashState(this.state);
    this.lastSeq = 0;
    this.records = [];
    this.header = null;
    this._goodOffset = 0; // file size after last fully-persisted record
  }

  /**
   * Create a new log file bound to `initialState`.
   * Fails if the file already exists.
   */
  static create(file, initialState) {
    if (fs.existsSync(file)) {
      throw new PatchLogError('log file already exists: ' + file, { code: 'LOG_EXISTS' });
    }
    const log = new PatchLog(file, initialState);
    log.header = {
      type: 'header',
      v: 1,
      logId: log.logId,
      stateHash: log.logId,
      createdAt: Date.now()
    };
    log.header.h = checksumOf(log.header);
    const line = JSON.stringify(log.header) + '\n';
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
      log._goodOffset = Buffer.byteLength(line, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return log;
  }

  /**
   * Open an existing log and recover it against `initialState`.
   * A torn tail record is ignored and truncated; any other corruption
   * is fatal.
   */
  static open(file, initialState) {
    if (!fs.existsSync(file)) {
      throw new PatchLogError('log file not found: ' + file, { code: 'LOG_NOT_FOUND' });
    }
    const log = new PatchLog(file, initialState);
    log._recover({ truncateTail: true });
    return log;
  }

  /**
   * Strictly verify the log (read-only, never truncates).
   * Throws LogCorruptError on any problem.
   */
  verify() {
    const probe = new PatchLog(this.file, this.originalState);
    probe._recover({ truncateTail: false });
    return {
      ok: true,
      logId: this.logId,
      lastSeq: probe.lastSeq,
      stateHash: hashState(probe.state),
      records: probe.records.length
    };
  }

  /**
   * Append (or idempotently replay) a patch.
   *
   * @param {Array} patch RFC-6902 operations
   * @param {{seq?: number, simulate?: string}} [opts]
   * @returns {{replayed: boolean, committed: boolean, receipt: object}}
   */
  commit(patch, opts) {
    opts = opts || {};
    if (!Array.isArray(patch)) {
      throw new PatchApplyError('patch must be an array of JSON-Patch operations');
    }
    patch = clone(patch); // never trust/mutate the caller's array

    const seq = opts.seq != null ? opts.seq : this.lastSeq + 1;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new SeqGapError(seq, this.lastSeq + 1);
    }

    // --- idempotency / conflict / gap checks (no apply, no write) ------
    if (seq <= this.lastSeq) {
      const existing = this.records[seq - 1];
      if (canonical(existing.patch) === canonical(patch)) {
        return { replayed: true, committed: false, receipt: receiptOf(existing) };
      }
      throw new SeqConflictError(seq);
    }
    if (seq > this.lastSeq + 1) {
      throw new SeqGapError(seq, this.lastSeq + 1);
    }

    // --- 1) apply on a copy first --------------------------------------
    const candidate = clone(this.state);
    try {
      applyPatch(candidate, patch, true);
    } catch (cause) {
      throw new PatchApplyError('patch rejected on copy, nothing committed: ' + cause.message, cause);
    }

    // --- 2) build the record with pre-state summary --------------------
    const record = {
      type: 'commit',
      logId: this.logId,
      seq: seq,
      prev: hashState(this.state),
      patch: patch,
      next: hashState(candidate),
      ts: Date.now()
    };
    record.h = checksumOf(record);
    const line = JSON.stringify(record) + '\n';

    // --- fault injection hooks (deterministic crash simulation) --------
    if (opts.simulate === 'tear') {
      // Simulate a crash mid-write: a partial line lands on disk,
      // nothing is fsync'd or published.
      const partial = line.slice(0, Math.floor(line.length / 2));
      const fd = fs.openSync(this.file, 'a');
      try {
        fs.writeSync(fd, partial);
      } finally {
        fs.closeSync(fd);
      }
      throw new CommitTornError('simulated crash: partial record written, state not published');
    }
    if (opts.simulate === 'ioerror') {
      // Simulate an I/O failure before anything reaches the disk.
      throw new CommitIOError('simulated I/O failure: record not persisted');
    }

    // --- 3) persist fully (write + fsync) -----------------------------
    const fd = fs.openSync(this.file, 'a');
    let written;
    try {
      written = fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (cause) {
      // A failed persist never counts as committed: roll the file back
      // to the last fully-persisted offset.
      try { fs.truncateSync(this.file, this._goodOffset); } catch (_) { /* best effort */ }
      throw new CommitIOError('persist failed, rolled back to offset ' + this._goodOffset, cause);
    } finally {
      fs.closeSync(fd);
    }

    // --- 4) publish only after the log is fully on disk ----------------
    this._goodOffset += written;
    this.state = candidate;
    this.records.push(record);
    this.lastSeq = seq;
    return { replayed: false, committed: true, receipt: receiptOf(record) };
  }

  getState() {
    return clone(this.state);
  }

  /* ---------------------------------------------------------------- */
  /* Recovery                                                          */
  /* ---------------------------------------------------------------- */

  _recover(opts) {
    const buf = fs.readFileSync(this.file);
    const rawLines = [];
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        if (i > start) rawLines.push({ start: start, text: buf.toString('utf8', start, i) });
        start = i + 1;
      }
    }

    if (rawLines.length === 0) {
      throw new LogCorruptError('log is empty: missing header');
    }

    // --- header ---------------------------------------------------------
    const headerLine = rawLines[0];
    let header;
    try {
      header = JSON.parse(headerLine.text);
    } catch (cause) {
      throw new LogCorruptError('header is unreadable', { at: 0, cause: cause });
    }
    if (header.type !== 'header' || header.v !== 1) {
      throw new LogCorruptError('header is corrupt or has an unsupported version', { at: 0 });
    }
    if (header.h !== checksumOf(header)) {
      throw new LogCorruptError('header checksum mismatch', { at: 0 });
    }
    if (header.logId !== this.logId || header.stateHash !== this.logId) {
      throw new LogCorruptError('header does not bind to the given original state', { at: 0 });
    }
    this.header = header;

    // --- commit records -------------------------------------------------
    let expected = 1;
    let goodEndOffset = headerLine.start + Buffer.byteLength(headerLine.text + '\n', 'utf8');
    let tornTail = null;

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      const at = i;
      let rec = null;
      let parseFailed = false;
      try {
        rec = JSON.parse(line.text);
      } catch (cause) {
        parseFailed = true;
      }

      const problems = [];
      if (parseFailed) {
        problems.push('record is incomplete (torn write)');
      } else {
        if (rec.type !== 'commit') problems.push('unexpected record type: ' + rec.type);
        if (rec.logId !== this.logId) problems.push('logId does not match header');
        if (rec.h !== checksumOf(rec)) problems.push('checksum mismatch');
        if (!Number.isInteger(rec.seq) || rec.seq !== expected) {
          problems.push('sequence mismatch: got ' + rec.seq + ', expected ' + expected);
        }
        if (rec.prev !== hashState(this.state)) {
          problems.push('pre-state summary (prev) does not match replayed state');
        }
      }

      if (problems.length === 0) {
        // replay the patch against a copy
        const candidate = clone(this.state);
        let applyFailed = null;
        try {
          applyPatch(candidate, rec.patch, true);
        } catch (cause) {
          applyFailed = cause;
        }
        if (applyFailed || rec.next !== hashState(candidate)) {
          problems.push(applyFailed
            ? 'patch cannot be replayed: ' + applyFailed.message
            : 'post-state summary (next) does not match replayed state');
        } else {
          // record is good
          this.state = candidate;
          this.records.push(rec);
          this.lastSeq = rec.seq;
          expected++;
          goodEndOffset = line.start + Buffer.byteLength(line.text + '\n', 'utf8');
          continue;
        }
      }

      // Bad record. Only an *incomplete* (torn) *tail* record may be
      // ignored. Anything else is fatal and the state is never published.
      const isLast = (i === rawLines.length - 1);
      if (parseFailed && isLast) {
        tornTail = { at: at, offset: line.start, reason: problems[0] };
        break;
      }
      throw new LogCorruptError('corrupt record at line ' + (at + 1) + ': ' + problems.join('; '), { at: at, problems: problems });
    }

    if (tornTail) {
      if (opts.truncateTail) {
        // cut the incomplete tail off so future appends stay contiguous
        fs.truncateSync(this.file, tornTail.offset);
        const fd = fs.openSync(this.file, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this._goodOffset = tornTail.offset;
      }
      this.tornTail = tornTail;
    } else {
      this._goodOffset = goodEndOffset;
    }
    return this;
  }
}

PatchLog.Error = PatchLogError;
PatchLog.SeqConflictError = SeqConflictError;
PatchLog.SeqGapError = SeqGapError;
PatchLog.PatchApplyError = PatchApplyError;
PatchLog.LogCorruptError = LogCorruptError;
PatchLog.CommitIOError = CommitIOError;
PatchLog.CommitTornError = CommitTornError;
PatchLog.hashState = hashState;
PatchLog.receiptOf = receiptOf;

module.exports = PatchLog;
