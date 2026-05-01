function greet(name: string): string {
  const message = `Hello, ${name}!`;
  console.log(message);
  return message;
}

function calculateTotal(price: number, quantity: number) {
  const subtotal = price * quantity;
  const tax = subtotal * 0.08;
  return subtotal * 1.08;
}

const x = 1;
const y = x + x;
const z = x * 2;
