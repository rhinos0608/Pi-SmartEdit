export function handleRequest(body: unknown) {
  // Debug logging
  console.log("DEBUG: entering handler");
  console.log("DEBUG: request body:", body);

  const validated = validate(body);
  return process(validated);
}
