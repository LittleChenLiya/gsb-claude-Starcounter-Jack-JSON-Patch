#!/usr/bin/env node
'use strict';
/*
 * Tiny command line front-end for the durable commit log.
 *
 *   node commitlog/cli.js init   --file LOG --id ID --base '{"k":1}'
 *   node commitlog/cli.js append --file LOG --id ID --base '{"k":1}' \
 *                                --seq 1 --patch '[{"op":"replace","path":"/k","value":2}]'
 *   node commitlog/cli.js state  --file LOG --id ID --base '{"k":1}'
 *
 * `append` replays the log (recovering state) before committing, so it can be
 * run repeatedly against the same log file to simulate process restarts.
 * Re-submitting the same seq + patch prints the original receipt without
 * applying the patch again. Output is a single line of JSON.
 */

var commitlog = require('./index.js');

function parseArgs(argv) {
    var args = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var token = argv[i];
        if (token.indexOf('--') === 0) {
            var key = token.slice(2);
            var next = argv[i + 1];
            if (next === undefined || next.indexOf('--') === 0) {
                args[key] = true;
            } else {
                args[key] = next;
                i += 1;
            }
        } else {
            args._.push(token);
        }
    }
    return args;
}

function parseJsonArg(value, name) {
    try {
        return JSON.parse(value);
    } catch (e) {
        throw new Error('argument ' + name + ' must be valid JSON: ' + e.message);
    }
}

function done(payload) {
    process.stdout.write(JSON.stringify(payload) + '\n');
}

async function main() {
    var args = parseArgs(process.argv.slice(2));
    var command = args._[0];
    var file = args.file;
    var id = args.id;
    if (!file || !id) {
        throw new Error('--file and --id are required');
    }
    var base = parseJsonArg(args.base, '--base');

    if (command === 'init') {
        var created = await commitlog.create(file, id, base);
        var initState = created.getState();
        await created.close();
        done({ ok: true, id: id, nextSeq: 1, state: initState,
            baseDigest: commitlog.digestOf(base) });
        return;
    }

    if (command === 'state') {
        var opened = await commitlog.open(file, id, base);
        var state = opened.getState();
        var nextSeq = opened.nextSeq;
        await opened.close();
        done({ ok: true, id: id, nextSeq: nextSeq, state: state,
            baseDigest: commitlog.digestOf(base) });
        return;
    }

    if (command === 'append') {
        if (args.seq === undefined) {
            throw new Error('--seq is required');
        }
        var seq = Number(args.seq);
        var patch = parseJsonArg(args.patch, '--patch');
        var options = { seq: seq };
        if (typeof args.failWrite !== 'undefined' && args.failWrite !== true) {
            options.failWrite = Number(args.failWrite);
        }
        if (args.failFlush) {
            options.failFlush = true;
        }
        var log = await commitlog.open(file, id, base);
        try {
            var receipt = await log.commit(patch, options);
            done({ ok: true, receipt: receipt, nextSeq: log.nextSeq,
                state: log.getState() });
        } finally {
            await log.close();
        }
        return;
    }

    throw new Error('unknown command: ' + command + ' (use init | append | state)');
}

main().catch(function (err) {
    process.stderr.write(String(err && (err.stack || err.message) || err) + '\n');
    process.exit(1);
});
