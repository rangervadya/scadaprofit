/**
 * Small text helpers shared across API modules (P2-1).
 *
 * `cleanLabel` collapses control characters and whitespace and truncates, so a
 * user-supplied name can be stored and rendered safely.
 */
export function cleanLabel(value, maxLength = 100) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
