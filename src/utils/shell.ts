/** POSIX shell single-quote escaping: safe for any byte except NUL. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
