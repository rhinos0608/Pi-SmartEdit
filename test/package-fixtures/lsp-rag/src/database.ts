export interface Database {
  insert(collection: string, data: unknown): Promise<void>;
  findOne(collection: string, query: Record<string, unknown>): Promise<any>;
  findMany(collection: string, query: Record<string, unknown>): Promise<any[]>;
  update(collection: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<void>;
  delete(collection: string, query: Record<string, unknown>): Promise<void>;
}
