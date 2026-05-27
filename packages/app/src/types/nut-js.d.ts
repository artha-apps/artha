/**
 * Ambient module shim for `@nut-tree-fork/nut-js`.
 *
 * The package is an optional native dependency (mouse/keyboard automation) that
 * is rebuilt via electron-rebuild on install. It is loaded lazily at runtime and
 * may be absent in some environments, so we declare it here as an untyped module
 * to keep `tsc` happy without pinning to the package's own (heavy) type surface.
 */
declare module '@nut-tree-fork/nut-js';
