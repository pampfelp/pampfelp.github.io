import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const baseRateLimit = redisUrl && redisToken
	? new Ratelimit({
		redis: new Redis({ url: redisUrl, token: redisToken }),
		limiter: Ratelimit.slidingWindow(100, "1 m"),
		analytics: false,
		prefix: "rate-limit",
	})
	: null;

export async function checkRateLimit({ request }: { request: Request }) {
	if (!baseRateLimit) return { success: true, limited: false };
	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";
	const { success } = await baseRateLimit.limit(ip);
	return { success, limited: !success };
}
