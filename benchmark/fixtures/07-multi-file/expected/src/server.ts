const route = "/v2/items";

export function register(app: App): void {
  app.get(route, listItems);
}
