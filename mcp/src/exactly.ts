/**
 * A literal tuple that must list EVERY member of a shared union, no more, no
 * less. `@devdigest/shared` is imported type-only here (its zod enums belong to
 * the server's zod instance), so enum values are copied — `exactly<U>()([...])`
 * makes a missing or extra value a typecheck error, so the copy can't drift.
 */
type MissingCheck<U extends string, T extends readonly U[]> = [Exclude<U, T[number]>] extends [never]
  ? unknown
  : { missing: Exclude<U, T[number]> };

export type Exactly<U extends string> = <const T extends readonly U[]>(values: T & MissingCheck<U, T>) => T;

export function exactly<U extends string>(): Exactly<U> {
  return (values) => values;
}
