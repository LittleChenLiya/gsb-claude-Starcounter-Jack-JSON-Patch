# Durable patch commit log

A small append-only commit log on top of RFC 6902 JSON patches
(`fast-json-patch`). It turns a sequence of patches into a durable, restart-safe
record of how an initial JSON document (the **base state**) evolved.

## What is stored

The log is a single UTF-8 file with one JSON value per line.

1. A header line, written and flushed when the log is created:

   ```
   commitlog v{"v":1,"id":"orders-42","alg":"sha256","base":"sha256:ab12…"}
   ```

   `id` is the log identity and `base` is the digest of the original base state.
   Both are checked on every recovery, so recovered state is bound to the log
   identity and to the original state.

2. One record line per committed patch:

   ```json
   {"seq":1,"prev":"sha256:ab12…","patch":[{"op":"replace","path":"/version","value":2}],"digest":"sha256:cd34…"}
   ```

   * `seq` — consecutive sequence number, starting at `1`. Gaps are rejected.
   * `prev` — digest of the state immediately before this patch.
   * `patch` — the RFC 6902 patch operations.
   * `digest` — digest of the state resulting from applying the patch.

Digests use canonical JSON (object keys sorted recursively), so equal documents
always hash the same regardless of key insertion order.

## Commit protocol (apply-to-copy, publish only after flush)

`commit(patch, { seq })` works as follows:

1. Validate the sequence: it must be exactly `lastSeq + 1`.
   * The same `seq` with the **same patch** returns the **original receipt**
     (idempotent retry) — the patch is never applied twice.
   * The same `seq` with a **different patch** is rejected with `CONFLICT`.
   * Any gap (e.g. submitting `3` after `1`) is rejected with `SEQ_GAP`.
2. Apply the patch to a **clone** of the current state (validation enabled).
   The published state is not touched yet.
3. Append the record and `fsync` it.
4. Only after the durable flush succeeds is the new state published and a
   receipt returned. If the write/flush fails, nothing is considered committed:
   the file is rolled back to the last durable length and the state stays at
   the previous revision.

## Recovery rules

`open(file, id, base)` replays the log against the supplied base:

* header `id` and `base` digest must match, otherwise `ID_MISMATCH` /
  `BASE_MISMATCH`;
* records are replayed strictly as `1, 2, 3 …`, checking `prev` and the
  resulting `digest` for every record;
* a **corrupt record in the middle** (bad JSON, wrong shape, broken `prev` /
  digest chain, sequence gap, or a patch that no longer applies) **stops**
  recovery with an error — it is never skipped;
* the **only** thing recovery may discard is an **incomplete tail**: the final
  bytes that have no terminating newline, i.e. a write that was torn before the
  flush point. On open the torn tail is physically truncated away, so the
  matching `seq` can then be committed again.

## Node API

```js
const commitlog = require('./commitlog');

const file = 'D:/data/orders-42.jsonl';
const id = 'orders-42';
const base = { version: 1, items: [] };

let log = await commitlog.create(file, id, base);
await log.commit([{ op: 'replace', path: '/version', value: 2 }], { seq: 1 });
await log.commit([{ op: 'add', path: '/items/-', value: 'a' }], { seq: 2 });
await log.close();

// Process restart: replay from the log using the SAME id and base.
log = await commitlog.open(file, id, base);
log.getState(); // { version: 2, items: ['a'] }
log.nextSeq;    // 3
await log.close();
```

Errors carry `err.name === 'CommitLogError'` and a stable `err.code`:
`NOT_FOUND`, `BAD_HEADER`, `ID_MISMATCH`, `BASE_MISMATCH`, `BAD_SEQ`,
`SEQ_GAP`, `CONFLICT`, `CORRUPT`, `BAD_PATCH`.

## Node commands (CLI)

Each CLI invocation is a separate process: `append` replays the log first, so
repeated commands simulate restarts. `--base` must be the exact original base
document on every call.

```sh
# Create the log for a base state.
node commitlog/cli.js init --file D:/data/demo.jsonl --id demo \
  --base '{"version":1,"items":[]}'

# Append seq 1, then seq 2 (each in its own process; state is replayed).
node commitlog/cli.js append --file D:/data/demo.jsonl --id demo \
  --base '{"version":1,"items":[]}' --seq 1 \
  --patch '[{"op":"replace","path":"/version","value":2}]'
node commitlog/cli.js append --file D:/data/demo.jsonl --id demo \
  --base '{"version":1,"items":[]}' --seq 2 \
  --patch '[{"op":"add","path":"/items/-","value":"a"}]'

# Read the recovered state.
node commitlog/cli.js state --file D:/data/demo.jsonl --id demo \
  --base '{"version":1,"items":[]}'
# {"ok":true,"id":"demo","nextSeq":3,"state":{"version":2,"items":["a"]}, ...}

# Re-submitting seq 2 with the same patch returns the same receipt and does NOT
# apply the patch again.
```

## Recovery cookbook (after a crash)

1. Keep the **original base document** and **log id** used at creation.
2. Run `node commitlog/cli.js state --file <log> --id <id> --base <baseJson>`.
   * It prints the recovered state (the last contiguous, fully flushed prefix
     of the log).
   * A torn final write is ignored automatically; `nextSeq` is the sequence to
     retry.
   * If it exits non-zero with `CORRUPT`/`SEQ_GAP`, a record before the tail is
     bad. Recovery stops by design: do not delete middle records; restore the
     log from a replica/backup or fix the offending record out of band.
3. Retry the missing sequence with `append … --seq <nextSeq>`. Duplicate
   retries of an already committed seq/patch are answered with the original
   receipt.

## Tests

A small, dependency-free, deterministic suite lives in
`test/commitlog/commitLogSpec.js` and writes all scratch files under
`./.tmp-commitlog`:

```sh
npm run test-commitlog
# or
node test/commitlog/commitLogSpec.js
```

It covers: two-patch restart recovery, torn third write keeping only the first
two, a corrupt middle record stopping recovery, a corrupt complete last line
stopping recovery, id/base binding, contiguous sequencing, duplicate receipts
(no re-apply), flush-failure rollback, and cross-process restart via the CLI.
