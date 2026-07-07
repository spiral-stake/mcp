// Minimal time helpers ported from v2-client/src/utils/time.ts (only what leverage.ts /
// pt.ts depend on). Kept in `core` so the ported files compile byte-for-byte.
export function currentTimestamp() {
  return Math.floor(Date.now() / 1000);
}
