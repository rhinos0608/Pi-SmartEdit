import { Database } from "./database";
import { Order } from "./types";

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  findByCustomerId(customerId: string): Promise<Order[]>;
  updateStatus(id: string, status: Order["status"]): Promise<void>;
}

export function createOrderRepository(db: Database): OrderRepository {
  return {
    async save(order: Order): Promise<void> {
      await db.insert("orders", order);
    },
    async findById(id: string): Promise<Order | null> {
      return db.findOne("orders", { id });
    },
    async findByCustomerId(customerId: string): Promise<Order[]> {
      return db.findMany("orders", { customerId });
    },
    async updateStatus(id: string, status: Order["status"]): Promise<void> {
      await db.update("orders", { id }, { status });
    },
  };
}
