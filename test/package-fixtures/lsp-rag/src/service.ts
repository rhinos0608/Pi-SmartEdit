import { CreateOrderInput, Order } from "./types";
import { OrderRepository } from "./repository";

export async function createOrder(
  input: CreateOrderInput,
  orderRepository: OrderRepository,
): Promise<Order> {
  const total = input.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );

  const order: Order = {
    id: crypto.randomUUID(),
    customerId: input.customerId,
    items: input.items,
    total,
    status: "pending",
    createdAt: new Date(),
  };

  await orderRepository.save(order);
  return order;
}

export async function getOrdersByCustomer(
  customerId: string,
  orderRepository: OrderRepository,
): Promise<Order[]> {
  return orderRepository.findByCustomerId(customerId);
}
