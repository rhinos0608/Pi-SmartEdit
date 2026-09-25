const route = "/v1/items";

export function register(app: App): void {
  app.get(route, listItems);
}
