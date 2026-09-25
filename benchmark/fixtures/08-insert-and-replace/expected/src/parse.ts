export function parseValues(input: string): string[] {
  if (input.length === 0) return [];
  const values = input.split(";");
  return values.map((value) => value.trim());
}
