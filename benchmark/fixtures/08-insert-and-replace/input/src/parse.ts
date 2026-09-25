export function parseValues(input: string): string[] {
  const values = input.split(",");
  return values.map((value) => value.trim());
}
