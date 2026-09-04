/** Path-segment guard shared by deploy and update-package: values used to
 *  build file paths must never contain separators or traversal sequences. */
export function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
