/*!
 * Acceptance tests for the small patch commit log.
 * All fixtures are written to a temp dir on the D: drive (inside this
 * worktree) and removed afterwards. Run with:
 *
 *   node test/patchLogSpec.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const PatchLog = require("../src/patchLog.js");

const TMP = path.join(__dirname, ".tmp-patchlog-test");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write("  ok - " + name + "\n");
  } catch (err) {
    failed++;
    process.stdout.write("  FAIL - " + name + "\n");
    process.stdout.write("       " + (err && err.stack ? err.stack.split("\n")[0] : err) + "\n");
  }
}

function freshDir() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
}

function file(name) {
  return path.join(TMP, name);
}

function lines(name) {
  return fs.readFileSync(file(name), "utf8").split("\n").filter((l) => l.length > 0);
}

/* ------------------------------------------------------------------ */

test("1. two patches, restart (recover) restores the same state", () => {
  freshDir();
  const initial = { a: 1, list: [1, 2] };
  const log = PatchLog.create(file("log1.jsonl"), initial);

  const r1 = log.commit([{ op: "add", path: "/b", value: 2 }]);
  const r2 = log.commit([
    { op: "replace", path: "/a", value: 10 },
    { op: "add", path: "/list/-", value: 3 }
  ]);

  assert.equal(r1.committed, true);
  assert.equal(r2.committed, true);
  assert.equal(r1.receipt.seq, 1);
  assert.equal(r2.receipt.seq, 2);
  // hash chain: next of record 1 == prev of record 2
  assert.equal(r2.receipt.prev, r1.receipt.next);

  // restart: open a brand new instance over the same file
  const recovered = PatchLog.open(file("log1.jsonl"), initial);
  assert.deepStrictEqual(recovered.getState(), { a: 10, b: 2, list: [1, 2, 3] });
  assert.equal(recovered.lastSeq, 2);
  assert.equal(recovered.records.length, 2);
  assert.equal(recovered.records[0].h, r1.receipt.recordHash);
  assert.equal(recovered.records[1].h, r2.receipt.recordHash);
});

test("2. third write breaks (torn): only the first two are kept", () => {
  freshDir();
  const initial = { n: 0 };
  const log = PatchLog.create(file("log2.jsonl"), initial);
  log.commit([{ op: "replace", path: "/n", value: 1 }]);
  log.commit([{ op: "replace", path: "/n", value: 2 }]);
  const sizeBefore = fs.statSync(file("log2.jsonl")).size;

  let torn = null;
  try {
    log.commit([{ op: "replace", path: "/n", value: 3 }], { simulate: "tear" });
  } catch (err) {
    torn = err;
  }
  assert.ok(torn, "torn commit must throw");
  assert.equal(torn.code, "COMMIT_TORN");
  assert.equal(torn.committed, false);
  // in-memory state was NOT published
  assert.deepStrictEqual(log.getState(), { n: 2 });
  assert.equal(log.lastSeq, 2);

  // the partial line is on disk right after the good records
  const onDisk = fs.readFileSync(file("log2.jsonl"), "utf8");
  assert.ok(onDisk.length > sizeBefore, "partial line landed on disk");

  // restart: recovery ignores the incomplete tail and truncates it
  const recovered = PatchLog.open(file("log2.jsonl"), initial);
  assert.equal(recovered.lastSeq, 2);
  assert.deepStrictEqual(recovered.getState(), { n: 2 });
  assert.ok(recovered.tornTail, "torn tail must be reported");
  // file is cut back to the last fully-persisted record
  const after = fs.readFileSync(file("log2.jsonl"), "utf8");
  assert.equal(after.length, sizeBefore);
  assert.ok(after.endsWith("\n"));

  // appending after recovery stays contiguous
  const r3 = recovered.commit([{ op: "replace", path: "/n", value: 3 }]);
  assert.equal(r3.committed, true);
  assert.equal(r3.receipt.seq, 3);
  assert.deepStrictEqual(recovered.getState(), { n: 3 });
});

test("3. intermediate checksum-bad record is rejected", () => {
  freshDir();
  const initial = { v: 1 };
  const log = PatchLog.create(file("log3.jsonl"), initial);
  log.commit([{ op: "replace", path: "/v", value: 2 }]);
  log.commit([{ op: "replace", path: "/v", value: 3 }]);
  log.commit([{ op: "replace", path: "/v", value: 4 }]);

  // corrupt the middle record (flip a char inside its checksum)
  const all = lines("log3.jsonl");
  const rec = JSON.parse(all[2]);
  rec.h = rec.h.slice(0, rec.h.length - 1) + (rec.h.endsWith("0") ? "1" : "0");
  all[2] = JSON.stringify(rec);
  fs.writeFileSync(file("log3.jsonl"), all.join("\n") + "\n");

  assert.throws(
    () => PatchLog.open(file("log3.jsonl"), initial),
    (err) => err.code === "LOG_CORRUPT" && /checksum/.test(err.message),
    "intermediate corruption must be fatal"
  );

  // strict verify also rejects, and nothing was truncated
  assert.throws(() => {
    const p = new PatchLog(file("log3.jsonl"), initial);
    p._recover({ truncateTail: false });
  }, /checksum/);
  assert.equal(lines("log3.jsonl").length, 4, "verify must not modify the log");
});

test("4. duplicate submission: same seq+same content replays, no re-apply", () => {
  freshDir();
  const initial = { x: 1 };
  const log = PatchLog.create(file("log4.jsonl"), initial);
  const patch = [{ op: "replace", path: "/x", value: 2 }];
  const first = log.commit(patch);
  const linesAfterFirst = lines("log4.jsonl").length;

  // resubmit the very same request (same seq, same content)
  const replay = log.commit(patch, { seq: 1 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.committed, false);
  assert.equal(replay.receipt.recordHash, first.receipt.recordHash, "original receipt returned");
  assert.equal(lines("log4.jsonl").length, linesAfterFirst, "no new record written");
  assert.deepStrictEqual(log.getState(), { x: 2 }, "state unchanged by replay");

  // same seq, different content -> reject
  assert.throws(
    () => log.commit([{ op: "replace", path: "/x", value: 99 }], { seq: 1 }),
    (err) => err.code === "SEQ_CONFLICT"
  );
  assert.equal(lines("log4.jsonl").length, linesAfterFirst);

  // idempotent replay survives a restart too
  const recovered = PatchLog.open(file("log4.jsonl"), initial);
  const replay2 = recovered.commit(patch, { seq: 1 });
  assert.equal(replay2.replayed, true);
  assert.equal(replay2.receipt.recordHash, first.receipt.recordHash);
});

test("5. sequence numbers must not cross gaps", () => {
  freshDir();
  const initial = { a: 1 };
  const log = PatchLog.create(file("log5.jsonl"), initial);
  log.commit([{ op: "replace", path: "/a", value: 2 }]);

  assert.throws(
    () => log.commit([{ op: "replace", path: "/a", value: 3 }], { seq: 3 }),
    (err) => err.code === "SEQ_GAP" && err.expected === 2
  );
  assert.throws(
    () => log.commit([{ op: "replace", path: "/a", value: 4 }], { seq: 0 }),
    (err) => err.code === "SEQ_GAP"
  );
  assert.equal(log.lastSeq, 1, "gap attempts leave the log untouched");
  assert.equal(lines("log5.jsonl").length, 2);
});

test("6. patch that fails on the copy is never committed", () => {
  freshDir();
  const initial = { a: 1 };
  const log = PatchLog.create(file("log6.jsonl"), initial);
  assert.throws(
    () => log.commit([{ op: "test", path: "/a", value: 999 }]),
    (err) => err.code === "PATCH_APPLY_FAILED"
  );
  assert.equal(log.lastSeq, 0);
  assert.deepStrictEqual(log.getState(), { a: 1 });
  assert.equal(lines("log6.jsonl").length, 1, "only the header exists");
});

test("7. I/O failure is not counted as committed; file rolls back", () => {
  freshDir();
  const initial = { a: 1 };
  const log = PatchLog.create(file("log7.jsonl"), initial);
  log.commit([{ op: "replace", path: "/a", value: 2 }]);
  const sizeBefore = fs.statSync(file("log7.jsonl")).size;

  let ioerr = null;
  try {
    log.commit([{ op: "replace", path: "/a", value: 3 }], { simulate: "ioerror" });
  } catch (err) {
    ioerr = err;
  }
  assert.ok(ioerr);
  assert.equal(ioerr.code, "COMMIT_IO_ERROR");
  assert.equal(ioerr.committed, false);
  assert.equal(log.lastSeq, 1);
  assert.deepStrictEqual(log.getState(), { a: 2 });
  assert.equal(fs.statSync(file("log7.jsonl")).size, sizeBefore, "file rolled back");

  const recovered = PatchLog.open(file("log7.jsonl"), initial);
  assert.equal(recovered.lastSeq, 1);
  assert.deepStrictEqual(recovered.getState(), { a: 2 });
});

test("8. original state is bound to the log identity", () => {
  freshDir();
  const initial = { a: 1 };
  PatchLog.create(file("log8.jsonl"), initial);
  // opening with a different original state must be rejected
  assert.throws(
    () => PatchLog.open(file("log8.jsonl"), { a: 2 }),
    (err) => err.code === "LOG_CORRUPT" && /bind/.test(err.message)
  );
  // tampering with the header checksum is rejected
  const all = lines("log8.jsonl");
  const header = JSON.parse(all[0]);
  header.createdAt = header.createdAt + 1;
  fs.writeFileSync(file("log8.jsonl"), [JSON.stringify(header)].join("\n") + "\n");
  assert.throws(() => PatchLog.open(file("log8.jsonl"), initial), /checksum/);
});

test("9. verify is strict and read-only on a healthy log", () => {
  freshDir();
  const initial = { a: 1 };
  const log = PatchLog.create(file("log9.jsonl"), initial);
  log.commit([{ op: "replace", path: "/a", value: 2 }]);
  const probe = new PatchLog(file("log9.jsonl"), initial);
  const result = probe.verify();
  assert.equal(result.ok, true);
  assert.equal(result.lastSeq, 1);
  assert.equal(result.records, 1);
  assert.equal(result.stateHash, PatchLog.hashState({ a: 2 }));

  // verify also works on an instance opened via PatchLog.open (it must
  // bind against the original state, not the current one)
  const reopened = PatchLog.open(file("log9.jsonl"), initial);
  const result2 = reopened.verify();
  assert.equal(result2.ok, true);
  assert.equal(result2.lastSeq, 1);
  assert.equal(result2.stateHash, PatchLog.hashState({ a: 2 }));
});

test("10. CLI: init / apply / recover round-trip (D: drive paths)", () => {
  freshDir();
  const stateFile = file("state.json");
  const patchFile = file("patch.json");
  const logFile = file("cli.jsonl");
  fs.writeFileSync(stateFile, JSON.stringify({ a: 1 }));
  fs.writeFileSync(patchFile, JSON.stringify([{ op: "add", path: "/b", value: 2 }]));

  const cli = path.join(__dirname, "..", "bin", "patchlog.js");
  const run = (args) => execFileSync(process.execPath, [cli].concat(args), { encoding: "utf8" });

  const initOut = run(["init", logFile, stateFile]);
  assert.ok(JSON.parse(initOut).logId);

  const applyOut = JSON.parse(run(["apply", logFile, stateFile, patchFile]));
  assert.equal(applyOut.ok, true);
  assert.equal(applyOut.receipt.seq, 1);
  assert.deepStrictEqual(applyOut.state, { a: 1, b: 2 });

  // second apply is a no-op replay when re-sent with the same seq
  const replayOut = JSON.parse(run(["apply", logFile, stateFile, patchFile, "--seq", "1"]));
  assert.equal(replayOut.replayed, true);

  const recoverOut = JSON.parse(run(["recover", logFile, stateFile]));
  assert.equal(recoverOut.lastSeq, 1);
  assert.deepStrictEqual(recoverOut.state, { a: 1, b: 2 });

  const statusOut = JSON.parse(run(["status", logFile, stateFile]));
  assert.equal(statusOut.records, 1);
  assert.equal(statusOut.stateHash, PatchLog.hashState({ a: 1, b: 2 }));
});

/* ------------------------------------------------------------------ */

freshDir();
process.stdout.write("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed === 0 ? 0 : 1);
