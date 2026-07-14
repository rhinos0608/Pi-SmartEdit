export interface CreateOrderInput {
  customerId: string;
  items: OrderItem[];
  shippingAddress: Address;
  paymentMethod: PaymentMethod;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

export interface Address {
  street: string;
  city: string;
  zipCode: string;
  country: string;
}

export interface PaymentMethod {
  type: "credit_card" | "paypal" | "bank_transfer";
  details: Record<string, string>;
}

export interface Order {
  id: string;
  customerId: string;
  items: OrderItem[];
  total: number;
  status: "pending" | "confirmed" | "shipped" | "delivered";
  createdAt: Date;
}
