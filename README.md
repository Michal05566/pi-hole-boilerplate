# pi-hole-boilerplate

Reports the byte ranges of a file that are zero-filled, using `stat()` block
counts as a sparse-file heuristic and a block-by-block zero scan to find the
holes. The goal is the same information `FS_IOC_FIEMAP` gives you on Linux —
"where are the holes in this sparse file?" — without depending on a native
ioctl binding.

## Usage

```js
import { writeFileSync } from 'node:fs';
import { scanHoles, checkSparseSupport, DEFAULT_BLOCK_SIZE } from 'pi-hole-boilerplate';

// Create a test file: data, hole, data
writeFileSync('/tmp/sparse.dat', Buffer.concat([
  Buffer.alloc(4096, 0x41),
  Buffer.alloc(4096, 0x00),
  Buffer.alloc(4096, 0x42),
]));

const holes = await scanHoles('/tmp/sparse.dat', { checkSparse: false });
// holes is an array of [startOffset, endOffsetExclusive] pairs, e.g.
//   [[4096, 8192]]

// Fast predicate: does stat() even claim the file is sparse?
const { stat } = await import('node:fs/promises');
const stats = await stat('/tmp/sparse.dat');
const maybeSparse = checkSparseSupport(stats);
```

## Why this exists

The Linux `FIEMAP` ioctl tells you which extents of a file were never
written, which is exactly what backup tools, deduplicators, and anything that
replicates sparse files need. Node's standard library does not expose it, and
pulling in a native addon breaks the zero-dependency contract this library is
built under. The trade-off here is correctness for portability: instead of
asking the kernel which extents are holes, we read the file in block-sized
chunks and report runs whose bytes are all zero. This is a content definition
of a hole rather than an allocation definition — a block the kernel allocated
but filled with zeros will be reported as a hole. For almost every consumer of
sparse-file information that distinction does not matter, because the bytes a
reader sees are zero either way.

## Edge you will hit

`scanHoles` uses `stat().blocks * 512 < stat().size` as its
"is-this-sparse" fast path and returns an empty array when that test fails.
On filesystems that report an allocated block count equal to the logical size
even for files that contain zero regions (APFS copy-on-write clones behave
this way on macOS), you will get no holes back. Pass `{ checkSparse: false }`
to force a byte-level scan regardless of what `stat()` says. The scan reads
the whole file, so it is O(file size) — fine for the multi-gigabyte range,
not fine for a 4 TB image.
