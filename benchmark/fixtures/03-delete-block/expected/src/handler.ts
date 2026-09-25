export function handleRequest(body: unknown) {

  const validated = validate(body);
  return process(validated);
}
