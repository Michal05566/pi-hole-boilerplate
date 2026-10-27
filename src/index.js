/**
 * pi-hole-boilerplate
 *
 * Public entry point. Re-exports the file-hole mapper so callers can import
 * everything from the package root.
 */
export { scanHoles } from './core.js';
export { DEFAULT_BLOCK_SIZE } from './core.js';
export { checkSparseSupport } from './core.js';
