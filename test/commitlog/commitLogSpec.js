'use strict';
/*
 * Small, deterministic tests for the durable patch commit log.
 * Run with:  node test/commitlog/commitLogSpec.js
 * or:        npm run test-commitlog
 *
 * All scratch data is written under ./.tmp-commitlog (D: drive worktree).
 */

var assert = require('assert');
var fs = require('fs');
var fsp = fs.promises;
var os = require('os');
var path = require('path');
var childProcess = require('child_process');
var commitlog = require('../../commitlog/index.js');

var ROOT = path.resolve(__dirname, '..', '..');
var TMP = path.join(ROOT, '.tmp-commitlog');
var CLI = path.join(ROOT, 'commitlog', 'cli.js');

function baseState() {
    return { name: 'doc', version: 1, items: ['a'] };
}

function p(n, op) {
    // numbered patch producing distinct, verifiable states
    if (op === 'bump') {
        return [{ op: 'replace', path: '/version', value: n }];
    }
    if (op === 'addItem') {
        return [{ op: 'add', path: '/items/-', value: 'i' + n }];
    }
    return op;
}

var passed = 0;
var failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        process.stdout.write('  ok - ' + name + '\n');
    } catch (e) {
        failed += 1;
        process.stdout.write('  FAIL - ' + name + '\n');
        process.stdout.write(String(e && e.stack || e) + '\n');
    }
}

async function rejects(code, promiseFactory) {
    var threw = null;
    try {
        await promiseFactory();
    } catch (e) {
        threw = e;
    }
    assert(threw, 'expected an error to be thrown');
    assert.strictEqual(threw.name, 'CommitLogError', 'wrong error name: ' + threw.name);
    assert.strictEqual(threw.code, code,
        'expected code ' + code + ' but got ' + threw.code + ' (' + threw.message + ')');
    return threw;
}

function runCli(args) {
    var res = childProcess.spawnSync(process.execPath, [CLI].concat(args), {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { TEMP: TMP, TMP: TMP })
    });
    if (res.status !== 0) {
        var err = new Error('cli failed (' + res.status + '): ' + res.stderr);
        err.stderr = res.stderr;
        err.stdout = res.stdout;
        throw err;
    }
    return JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
}

async function appendRaw(filePath, text) {
    var fh = await fsp.open(filePath, 'a');
    try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
    } finally {
        await fh.close();
    }
}

async function main() {
    await fsp.mkdir(TMP, { recursive: true });

    await test('two committed patches recover the same state after restart', async function () {
        var file = path.join(TMP, 'restart.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'log-restart', baseState());
        var r1 = await log.commit(p(2, 'bump'), { seq: 1 });
        assert.strictEqual(r1.seq, 1);
        assert.strictEqual(r1.prev, commitlog.digestOf(baseState()));
        var r2 = await log.commit(p(3, 'addItem'), { seq: 2 });
        assert.strictEqual(r2.seq, 2);
        assert.strictEqual(r2.prev, r1.digest);
        var expected = { name: 'doc', version: 2, items: ['a', 'i3'] };
        assert.deepStrictEqual(log.getState(), expected);
        assert.strictEqual(log.nextSeq, 3);
        await log.close();

        // "restart": reopen with the original base and id, replay the log.
        var reopened = await commitlog.open(file, 'log-restart', baseState());
        assert.deepStrictEqual(reopened.getState(), expected);
        assert.strictEqual(reopened.nextSeq, 3);
        await reopened.close();
    });

    await test('state is bound to log id and original base', async function () {
        var file = path.join(TMP, 'bound.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'bound-id', baseState());
        await log.commit(p(2, 'bump'), { seq: 1 });
        await log.close();

        await rejects('ID_MISMATCH', function () {
            return commitlog.open(file, 'other-id', baseState());
        });
        var changedBase = baseState();
        changedBase.version = 99;
        await rejects('BASE_MISMATCH', function () {
            return commitlog.open(file, 'bound-id', changedBase);
        });
    });

    await test('duplicate seq + same content returns original receipt and does not re-apply', async function () {
        var file = path.join(TMP, 'dup.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'dup-id', { v: 1 });
        var patch = [{ op: 'replace', path: '/v', value: 5 }];
        var receipt = await log.commit(patch, { seq: 1 });
        // Same call again (e.g. retried request): identical receipt, one record.
        var again = await log.commit(patch, { seq: 1 });
        assert.deepStrictEqual(again, receipt);
        assert.strictEqual(log.nextSeq, 2);
        assert.strictEqual(log.getState().v, 5);
        await log.close();

        var lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
        assert.strictEqual(lines.length, 2, 'header + exactly one record');

        // After a real restart the duplicate is still served from the log.
        var reopened = await commitlog.open(file, 'dup-id', { v: 1 });
        var afterRestart = await reopened.commit(patch, { seq: 1 });
        assert.deepStrictEqual(afterRestart, receipt);
        assert.strictEqual(reopened.nextSeq, 2);
        await reopened.close();
    });

    await test('duplicate seq with different content is rejected', async function () {
        var file = path.join(TMP, 'conflict.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'conflict-id', { v: 1 });
        await log.commit([{ op: 'replace', path: '/v', value: 5 }], { seq: 1 });
        await rejects('CONFLICT', function () {
            return log.commit([{ op: 'replace', path: '/v', value: 6 }], { seq: 1 });
        });
        assert.strictEqual(log.getState().v, 5);
        await log.close();
    });

    await test('sequence numbers must be contiguous: gaps are rejected', async function () {
        var file = path.join(TMP, 'gap.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'gap-id', { v: 1 });
        await rejects('SEQ_GAP', function () {
            return log.commit([{ op: 'replace', path: '/v', value: 2 }], { seq: 2 }); // first seq must be 1
        });
        await rejects('BAD_SEQ', function () {
            return log.commit([{ op: 'replace', path: '/v', value: 2 }], {}); // missing seq
        });
        await log.commit([{ op: 'replace', path: '/v', value: 2 }], { seq: 1 });
        await rejects('SEQ_GAP', function () {
            return log.commit([{ op: 'replace', path: '/v', value: 3 }], { seq: 3 }); // skips 2
        });
        // seq 2 still works.
        await log.commit([{ op: 'replace', path: '/v', value: 3 }], { seq: 2 });
        assert.strictEqual(log.getState().v, 3);
        await log.close();
    });

    await test('third patch torn mid-write: only the first two survive', async function () {
        var file = path.join(TMP, 'torn.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'torn-id', baseState());
        await log.commit(p(2, 'bump'), { seq: 1 });
        await log.commit(p(3, 'addItem'), { seq: 2 });
        var twoPatchState = { name: 'doc', version: 2, items: ['a', 'i3'] };
        assert.deepStrictEqual(log.getState(), twoPatchState);
        // Simulate the OS dying after writing 12 bytes of record 3.
        await rejects('CORRUPT', function () {
            return log.commit([{ op: 'replace', path: '/version', value: 9 }],
                { seq: 3, failWrite: 12 });
        });
        // Flush failure is not "committed": state still at revision 2.
        assert.strictEqual(log.nextSeq, 3);
        assert.deepStrictEqual(log.getState(), twoPatchState);
        await log.close();

        // Restart: the incomplete tail line is the ONLY thing ignored.
        var recovered = await commitlog.open(file, 'torn-id', baseState());
        assert.deepStrictEqual(recovered.getState(), twoPatchState);
        assert.strictEqual(recovered.nextSeq, 3);
        // The torn tail was pruned; record 3 can now be committed for real.
        var r3 = await recovered.commit([{ op: 'replace', path: '/version', value: 9 }],
            { seq: 3 });
        assert.strictEqual(r3.seq, 3);
        assert.strictEqual(recovered.getState().version, 9);
        await recovered.close();
    });

    await test('flush failure before durability point is not committed', async function () {
        var file = path.join(TMP, 'flushfail.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'ff-id', { v: 1 });
        await rejects('CORRUPT', function () {
            return log.commit([{ op: 'replace', path: '/v', value: 2 }],
                { seq: 1, failFlush: true });
        });
        assert.strictEqual(log.nextSeq, 1);
        assert.deepStrictEqual(log.getState(), { v: 1 });
        await log.close();
        var reopened = await commitlog.open(file, 'ff-id', { v: 1 });
        assert.deepStrictEqual(reopened.getState(), { v: 1 });
        assert.strictEqual(reopened.nextSeq, 1);
        await reopened.commit([{ op: 'replace', path: '/v', value: 2 }], { seq: 1 });
        assert.strictEqual(reopened.getState().v, 2);
        await reopened.close();
    });

    await test('corrupt record in the middle stops recovery (it is not ignored)', async function () {
        var file = path.join(TMP, 'middlebad.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'mb-id', { v: 1 });
        await log.commit([{ op: 'replace', path: '/v', value: 2 }], { seq: 1 });
        await log.commit([{ op: 'replace', path: '/v', value: 3 }], { seq: 2 });
        await log.close();

        var raw = await fsp.readFile(file, 'utf8');
        var lines = raw.split('\n');
        // lines: [header, record1, record2, '']; tamper the MIDDLE record
        // (seq 1) so its patch no longer matches its stored digest.
        var tampered = JSON.parse(lines[1]);
        tampered.patch[0].value = 7;
        lines[1] = JSON.stringify(tampered);
        await fsp.writeFile(file, lines.join('\n'), 'utf8');

        await rejects('CORRUPT', function () {
            return commitlog.open(file, 'mb-id', { v: 1 });
        });
    });

    await test('a complete but bad last line also stops recovery', async function () {
        var file = path.join(TMP, 'lastbad.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'lb-id', { v: 1 });
        await log.commit([{ op: 'replace', path: '/v', value: 2 }], { seq: 1 });
        await log.close();
        // Fully terminated line (has newline) that is garbage: not a torn tail.
        await appendRaw(file, '{"seq":2,"this":"is not a valid record"}\n');
        await rejects('CORRUPT', function () {
            return commitlog.open(file, 'lb-id', { v: 1 });
        });
    });

    await test('patched clone failures do not publish state', async function () {
        var file = path.join(TMP, 'badpatch.jsonl');
        await fsp.rm(file, { force: true });
        var log = await commitlog.create(file, 'bp-id', { v: 1 });
        await rejects('BAD_PATCH', function () {
            return log.commit([{ op: 'replace', path: '/missing', value: 1 }], { seq: 1 });
        });
        assert.deepStrictEqual(log.getState(), { v: 1 });
        assert.strictEqual(log.nextSeq, 1);
        await log.close();
    });

    await test('Node CLI: two patches over separate processes restart to same state', async function () {
        var file = path.join(TMP, 'cli.jsonl');
        await fsp.rm(file, { force: true });
        var base = '{"name":"doc","version":1,"items":["a"]}';
        var init = runCli(['init', '--file', file, '--id', 'cli-id', '--base', base]);
        assert.strictEqual(init.ok, true);

        var p1 = '[{"op":"replace","path":"/version","value":2}]';
        var p2 = '[{"op":"add","path":"/items/-","value":"i3"}]';
        // Each invocation is a brand-new process: it replays the log first.
        var a1 = runCli(['append', '--file', file, '--id', 'cli-id',
            '--base', base, '--seq', '1', '--patch', p1]);
        assert.strictEqual(a1.receipt.seq, 1);
        var a2 = runCli(['append', '--file', file, '--id', 'cli-id',
            '--base', base, '--seq', '2', '--patch', p2]);
        assert.deepStrictEqual(a2.state, { name: 'doc', version: 2, items: ['a', 'i3'] });

        // Duplicate submit in yet another process -> original receipt, no re-apply.
        var dup = runCli(['append', '--file', file, '--id', 'cli-id',
            '--base', base, '--seq', '2', '--patch', p2]);
        assert.deepStrictEqual(dup.receipt, a2.receipt);
        assert.strictEqual(dup.nextSeq, 3);

        var st = runCli(['state', '--file', file, '--id', 'cli-id', '--base', base]);
        assert.deepStrictEqual(st.state, { name: 'doc', version: 2, items: ['a', 'i3'] });
        assert.strictEqual(st.nextSeq, 3);
    });

    process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
    process.stderr.write(String(e && e.stack || e) + '\n');
    process.exit(1);
});
