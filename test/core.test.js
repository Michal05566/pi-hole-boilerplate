import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanHoles, checkSparseSupport, DEFAULT_BLOCK_SIZE } from '../src/index.js';

const TMP = join(tmpdir(), 'pi-hole-boilerplate-test-' + process.pid);

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

teardown: {
  process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
}

test('scanHoles returns empty array for a zero-length file', async () => {
  setup();
  const p = join(TMP, 'empty');
  writeFileSync(p, Buffer.alloc(0));
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, []);
});

test('scanHoles with checkSparse disabled reports no holes for an all-non-zero file', async () => {
  setup();
  const p = join(TMP, 'full');
  const data = Buffer.alloc(8192, 0xff);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, []);
});

test('scanHoles detects a hole in the middle of a file', async () => {
  setup();
  const p = join(TMP, 'middle-hole');
  const data = Buffer.concat([
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(4096, 0x00),
    Buffer.alloc(4096, 0x42),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, [[4096, 8192]]);
});

test('scanHoles coalesces consecutive zero blocks into one range', async () => {
  setup();
  const p = join(TMP, 'big-hole');
  const data = Buffer.concat([
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(8192, 0x00),
    Buffer.alloc(4096, 0x42),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, [[4096, 12288]]);
});

test('scanHoles detects a leading hole', async () => {
  setup();
  const p = join(TMP, 'leading');
  const data = Buffer.concat([
    Buffer.alloc(4096, 0x00),
    Buffer.alloc(4096, 0x41),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, [[0, 4096]]);
});

test('scanHoles detects a trailing hole at end of file', async () => {
  setup();
  const p = join(TMP, 'trailing');
  const data = Buffer.concat([
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(4096, 0x00),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, [[4096, 8192]]);
});

test('scanHoles reports a partial trailing zero block', async () => {
  setup();
  const p = join(TMP, 'partial-trailing');
  const data = Buffer.concat([
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(2048, 0x00),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, [[4096, 6144]]);
});

test('scanHoles reports multiple distinct holes', async () => {
  setup();
  const p = join(TMP, 'multi');
  const data = Buffer.concat([
    Buffer.alloc(4096, 0x00),
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(4096, 0x00),
    Buffer.alloc(4096, 0x42),
    Buffer.alloc(4096, 0x00),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { checkSparse: false });
  assert.deepEqual(holes, [
    [0, 4096],
    [8192, 12288],
    [16384, 20480],
  ]);
});

test('scanHoles honours a custom blockSize', async () => {
  setup();
  const p = join(TMP, 'custom-block');
  const data = Buffer.concat([
    Buffer.alloc(512, 0x41),
    Buffer.alloc(512, 0x00),
    Buffer.alloc(512, 0x42),
  ]);
  writeFileSync(p, data);
  const holes = await scanHoles(p, { blockSize: 512, checkSparse: false });
  assert.deepEqual(holes, [[512, 1024]]);
});

test('checkSparseSupport returns false for a zero-size file', () => {
  assert.equal(checkSparseSupport({ size: 0, blocks: 0 }), false);
});

test('checkSparseSupport returns true when allocated blocks are smaller than logical size', () => {
  assert.equal(checkSparseSupport({ size: 8192, blocks: 8 }), true);
});

test('checkSparseSupport returns false when the file is fully allocated', () => {
  assert.equal(checkSparseSupport({ size: 4096, blocks: 8 }), false);
});

test('checkSparseSupport returns false for invalid input', () => {
  assert.equal(checkSparseSupport(null), false);
  assert.equal(checkSparseSupport({}), false);
  assert.equal(checkSparseSupport({ size: 'x', blocks: 1 }), false);
});

test('DEFAULT_BLOCK_SIZE is 4096', () => {
  assert.equal(DEFAULT_BLOCK_SIZE, 4096);
});
