import { describe, it, expect } from "vitest";
import { createOrder, getOrdersByCustomer } from "./service";
import type { CreateOrderInput, Order } from "./types";
import type { OrderRepository } from "./repository";

function createMockRepository(): OrderRepository {
  const orders: Order[] = [];
  return {
    async save(order: Order) { orders.push(order); },
    async findById(id: string) { return orders.find(o => o.id === id) ?? null; },
    async findByCustomerId(customerId: string) { return orders.filter(o => o.customerId === customerId); },
    async updateStatus(id: string, status: Order["status"]) {
      const order = orders.find(o => o.id === id);
      if (order) order.status = status;
    },
  };
}

describe("createOrder", () => {
  it("should create an order with pending status", async () => {
    const repo = createMockRepository();
    const input: CreateOrderInput = {
      customerId: "cust-1",
      items: [{ productId: "prod-1", quantity: 2, price: 10 }],
      shippingAddress: { street: "123 Main St", city: "NYC", zipCode: "10001", country: "US" },
      paymentMethod: { type: "credit_card", details: {} },
    };
    const order = await createOrder(input, repo);
    expect(order.status).toBe("pending");
    expect(order.total).toBe(20);
  });
});
