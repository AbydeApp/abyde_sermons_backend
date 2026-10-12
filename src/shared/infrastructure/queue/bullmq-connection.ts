import type { ConnectionOptions } from 'bullmq';

export function bullConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    connectTimeout: 5_000,
    // No command timeout here: BullMQ workers rely on long blocking commands.
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
}
