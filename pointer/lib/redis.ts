import { Redis, type RedisOptions } from "ioredis";
import process from "node:process";

declare global {
	// Reuse the publisher across HMR reloads so we don't leak connections in dev.
	var __redisPub: Redis | undefined;
}

function buildOptions(): { url: string; options: RedisOptions } {
	const url = process.env.REDIS_URL ?? "redis://localhost:6379";
	// lazyConnect keeps `next build` from opening a socket during page-data
	// collection. Connections are established on first command.
	const options: RedisOptions = {
		lazyConnect: true,
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
	};
	return { url, options };
}

let cachedPub: Redis | undefined;

export function getRedis(): Redis {
	if (globalThis.__redisPub) return globalThis.__redisPub;
	if (cachedPub) return cachedPub;

	const { url, options } = buildOptions();
	cachedPub = new Redis(url, options);

	if (process.env.NODE_ENV !== "production") {
		globalThis.__redisPub = cachedPub;
	}
	return cachedPub;
}

// Each subscriber needs its own connection because `XREAD BLOCK ...` parks
// the socket. Callers MUST `quit()` the returned client when finished.
export function createRedisSubscriber(): Redis {
	const { url, options } = buildOptions();
	return new Redis(url, options);
}
