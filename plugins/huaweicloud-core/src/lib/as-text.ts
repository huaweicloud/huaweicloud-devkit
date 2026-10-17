// Byte-identical to String(value) for every value: String(s) === s, and
// every non-string flows through String() unchanged. The typeof check is
// what clears @typescript-eslint/no-base-to-string on unknown-typed reads
// without narrowing away the historical coercion — do not simplify it back
// to a bare String() call or a string-only ternary.
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}
