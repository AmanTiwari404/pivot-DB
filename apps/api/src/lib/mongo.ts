import { MongoClient } from 'mongodb';

const pool = new Map<string, MongoClient>();

export async function getMongoClient(connectionId: string, uri: string): Promise<MongoClient> {
  if (pool.has(connectionId)) {
    return pool.get(connectionId)!;
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await client.connect();
  pool.set(connectionId, client);
  return client;
}

export async function closeMongoClient(connectionId: string): Promise<void> {
  const client = pool.get(connectionId);
  if (client) {
    await client.close();
    pool.delete(connectionId);
  }
}

export async function closeAllClients(): Promise<void> {
  for (const [id, client] of pool.entries()) {
    await client.close().catch(() => {});
    pool.delete(id);
  }
}

export async function getFreshClient(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return client;
}
