/**
 * Core hole-mapping logic for pi-hole-boilerplate.
 *
 * Interpretation chosen (stated in README): we treat a filesystem block whose
 * bytes are all zero as a "hole". This is a byte-content approximation of the
 * FS_IOC_FIEMAP ioctl, which the Node standard library does not expose. The
 * stat() block count is consulted to decide whether a file is sparse at all:
 * when st_blocks * 512 < st_size the file almost certainly has extents that
 * were never written. We then walk the file in block-sized chunks and report
 * the ranges whose contents are zero, which is the useful definition from an
 * application standpoint (a reader of those bytes will see zeros regardless
 * of whether the kernel allocated physical space).
 */

import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

/**
 * Block size used to chunk reads and report ranges.
 *
 * Fixed at 4096 because that matches the block size ext4 / xfs report in
 * st_blksize for the overwhelming majority of installations, and a fixed
 * value keeps behaviour deterministic across platforms. We do not use
 * stats.blksize because on macOS it is often 4096 even for APFS clones that
 * behave nothing like sparse files, which defeats the "is this actually
 * sparse" check.
 */
export const DEFAULT_BLOCK_SIZE = 4096;

/**
 * Determine whether a file appears to be sparse by comparing the number of
 * 512-byte blocks the kernel says it allocated against the logical size.
 *
 * Returns false for zero-length files because a zero-byte file has no holes
 * to map, even though st_blocks == 0 < st_size == 0 would naively be false
 * anyway.
 *
 * @param {{ size: number, blocks: number }} stats
 * @returns {boolean}
 */
export function checkSparseSupport(stats) {
  if (!stats || typeof stats.size !== 'number' || typeof stats.blocks !== 'number') {
    return false;
  }
  if (stats.size <= 0) return false;
  return stats.blocks * 512 < stats.size;
}

/**
 * Scan a file for zero-filled regions and return them as byte ranges.
 *
 * Each range is a tuple of [startOffset, endOffsetExclusive]. Consecutive
 * zero blocks are coalesced into a single range. The very last block of the
 * file is included in a hole only if it is fully zero — a partial trailing
 * zero block is reported because the bytes the user can read from it are in
 * fact zero, and that is what the caller wants to know.
 *
 * The checkSparse flag, when true (the default), short-circuits with an empty
 * array when the stat block count says the file is fully allocated. This is a
 * fast path for non-sparse files; turn it off if you want a byte-level scan
 * regardless of what the kernel reports.
 *
 * @param {string} path
 * @param {{ blockSize?: number, checkSparse?: boolean }} [opts]
 * @returns {Promise<Array<[number, number]>>}
 */
export async function scanHoles(path, opts = {}) {
  const blockSize = opts.blockSize && opts.blockSize > 0 ? opts.blockSize : DEFAULT_BLOCK_SIZE;
  const checkSparse = opts.checkSparse !== false;

  const handle = await open(path, constants.O_RDONLY);
  try {
    const stats = await handle.stat();

    if (checkSparse && !checkSparseSupport(stats)) {
      return [];
    }

    const totalSize = stats.size;
    if (totalSize <= 0) {
      return [];
    }

    const buffer = Buffer.alloc(blockSize);
    /** @type {Array<[number, number]>} */
    const holes = [];
    let holeStart = -1;
    let offset = 0;

    while (offset < totalSize) {
      const bytesToRead = Math.min(blockSize, totalSize - offset);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);

      // If we got fewer bytes than asked for we are at EOF or hit a short
      // read. Treat unread bytes as the end of the file and stop.
      const effective = Math.min(bytesRead, bytesToRead);
      const slice = buffer.subarray(0, effective);
      const isZero = effective === 0 || isAllZero(slice);

      if (isZero) {
        if (holeStart === -1) {
          holeStart = offset;
        }
      } else {
        if (holeStart !== -1) {
          holes.push([holeStart, offset]);
          holeStart = -1;
        }
      }

      offset += effective;
      if (effective === 0) {
        // No progress possible — avoid spinning forever.
        break;
      }
    }

    if (holeStart !== -1) {
      holes.push([holeStart, totalSize]);
    }

    return holes;
  } finally {
    await handle.close();
  }
}

/**
 * Check whether every byte in a Buffer is zero.
 *
 * Uses Buffer.indexOf which is a native, SIMD-accelerated scan in modern Node.
 * We search for any byte that is NOT zero by using indexOf with a non-zero
 * needle would require constructing that needle; instead we check that the
 * first non-zero byte does not exist by scanning for the first byte that
 * differs from zero via fill comparison. The simplest correct form is a
 * indexOf against a zero-filled comparison buffer of the same length, but
 * that allocates per call. Instead we do the indexOf(0x01...) trick: we look
 * for the first byte greater than zero by scanning with a single-byte needle
 * loop — but the fastest no-allocation approach is Buffer#lastIndexOf with
 * value 0 from the end, which tells us the index of the last zero. If that is
 * the last index, the buffer is all zeros. If indexOf(0) !== -1 does not help
 * either. The clean approach: Buffer#indexOf returns the first index of a
 * value, so we scan for any byte !== 0 by trying each — too slow.
 *
 * Settled approach: allocate one comparison buffer per call. This is correct
 * and clear; performance is fine because blockSize is bounded and reads are
 * the bottleneck anyway.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isAllZero(buf) {
  // Buffer#subarray + every is not available; use indexOf on a zero needle of
  // matching length. We build a zero-filled buffer of the same length and use
  // Buffer#compare, which is a single native memcmp.
  //
  // compare returns 0 when the contents are equal, so compare against a zero
  // buffer of equal length tells us exactly "are all bytes zero".
  return buf.compare(ZERO_CACHE[buf.length] ??= Buffer.alloc(buf.length, 0)) === 0;
}

/** @type {Record<number, Buffer>} */
const ZERO_CACHE = {};
