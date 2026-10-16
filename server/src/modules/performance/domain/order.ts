/** Name ascending in code-unit order (a DB collation would ignore dashes). */
export function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
