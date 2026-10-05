#!/usr/bin/env node
/*!
 * patchlog - small patch commit log CLI
 *
 * Usage (all paths may be on D: drive):
 *   node bin/patchlog.js init    <logfile> <state.json>
 *   node bin/patchlog.js apply   <logfile> <state.json> <patch.json> [--seq N]
 *   node bin/patchlog.js recover <logfile> <state.json>
 *   node bin/patchlog.js verify  <logfile> <state.json>
 *   node bin/patchlog.js status  <logfile> <state.json>
 *
 * Commands:
 *   init    create a new log bound to the given original state
 *   apply   apply an RFC-6902 patch array (applied to a copy first,
 *           persisted with fsync, then published)
 *   recover replay the log; a torn tail record is ignored and truncated,
 *           any intermediate corruption is rejected
 *   verify  strict read-only verification (never truncates)
 *   status  print log identity, last sequence and state hash
 */
"use strict";

const fs = require("fs");
const PatchLog = require("../src/patchLog.js");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function die(message) {
  process.stderr.write("patchlog: " + message + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  const cmd = argv[2];
  const args = argv.slice(3);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seq") { flags.seq = Number(args[++i]); }
    else { positional.push(args[i]); }
  }
  return { cmd, positional, flags };
}

function main(argv) {
  const { cmd, positional, flags } = parseArgs(argv);

  try {
    if (cmd === "init") {
      const logfile = positional[0];
      const state = readJson(positional[1]);
      const log = PatchLog.create(logfile, state);
      process.stdout.write(JSON.stringify({ ok: true, logId: log.logId, file: logfile }, null, 2) + "\n");
      return;
    }

    if (cmd === "apply") {
      const logfile = positional[0];
      const state = readJson(positional[1]);
      const patch = readJson(positional[2]);
      const log = PatchLog.open(logfile, state);
      const result = log.commit(patch, flags.seq != null ? { seq: flags.seq } : {});
      process.stdout.write(JSON.stringify({
        ok: true,
        replayed: result.replayed,
        committed: result.committed,
        receipt: result.receipt,
        lastSeq: log.lastSeq,
        state: log.getState()
      }, null, 2) + "\n");
      return;
    }

    if (cmd === "recover") {
      const logfile = positional[0];
      const state = readJson(positional[1]);
      const log = PatchLog.open(logfile, state);
      process.stdout.write(JSON.stringify({
        ok: true,
        logId: log.logId,
        lastSeq: log.lastSeq,
        state: log.getState(),
        tornTail: log.tornTail || null
      }, null, 2) + "\n");
      return;
    }

    if (cmd === "verify") {
      const logfile = positional[0];
      const state = readJson(positional[1]);
      const probe = new PatchLog(logfile, state);
      probe._recover({ truncateTail: false });
      process.stdout.write(JSON.stringify({
        ok: true,
        logId: probe.logId,
        lastSeq: probe.lastSeq,
        stateHash: PatchLog.hashState(probe.state),
        records: probe.records.length
      }, null, 2) + "\n");
      return;
    }

    if (cmd === "status") {
      const logfile = positional[0];
      const state = readJson(positional[1]);
      const log = PatchLog.open(logfile, state);
      process.stdout.write(JSON.stringify({
        ok: true,
        logId: log.logId,
        lastSeq: log.lastSeq,
        stateHash: PatchLog.hashState(log.getState()),
        records: log.records.length
      }, null, 2) + "\n");
      return;
    }

    die("unknown command: " + cmd);
  } catch (err) {
    die((err.code ? err.code + ": " : "") + err.message);
  }
}

main(process.argv);
