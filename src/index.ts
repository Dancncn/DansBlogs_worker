import type { Env } from './types';
import { RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_MS } from './types';
import { json, clampInt, resolveAllowedOrigin, withCors } from './utils';
import {
	handleGithubStart, handleGithubCallback, handleMe, handleMeUpdate,
	handleLogout, handleEmailSend, handleEmailVerify, handleDevLogin,
} from './auth';
import { handleCommentsGet, handleCommentsPost } from './comments';
import { handleViewsGet, handleViewsBatch, handleViewsPost } from './views';
import { handleImageRoute, handleImageUpload, handleImageDelete } from './images';
import {
	handleAdminStats, handleAdminComments, handleAdminCommentAction,
	handleAdminCommentDelete, handleAdminCheck,
} from './admin';
import { handleContact } from './contact';
import { handleModerationPage, handleModerationConfirm } from './moderation-approval';

export class RateLimiter {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		let payload: { ip?: unknown; route?: unknown; limit?: unknown; windowMs?: unknown };
		try {
			payload = (await request.json()) as { ip?: unknown; route?: unknown; limit?: unknown; windowMs?: unknown };
		} catch {
			return json({ error: 'Invalid JSON' }, 400);
		}

		const ip = typeof payload.ip === 'string' && payload.ip ? payload.ip.slice(0, 80) : 'unknown';
		const route = typeof payload.route === 'string' && payload.route ? payload.route.slice(0, 80) : 'default';
		const limit = clampInt(payload.limit, 1, 100, RATE_LIMIT_PER_MIN);
		const windowMs = clampInt(payload.windowMs, 1000, 10 * 60 * 1000, RATE_LIMIT_WINDOW_MS);

		const now = Date.now();
		const bucket = Math.floor(now / windowMs);
		const key = `${ip}:${route}:${bucket}`;
		const count = Number((await this.state.storage.get<number>(key)) ?? 0);

		if (count >= limit) {
			const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));
			return json({ error: 'Too Many Requests' }, 429, {
				'retry-after': String(retryAfter),
			});
		}

		await this.state.storage.put(key, count + 1, {
			expirationTtl: Math.ceil((windowMs * 2) / 1000),
		} as DurableObjectPutOptions & { expirationTtl: number });

		return json({ ok: true, remaining: limit - (count + 1) }, 200);
	}
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const origin = resolveAllowedOrigin(request, env);

		if (request.method === 'GET' && url.pathname === '/robots.txt') {
			return new Response('User-agent: *\nDisallow: /\n', {
				status: 200,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'x-robots-tag': 'noindex, nofollow, noarchive',
					'cache-control': 'public, max-age=3600',
				},
			});
		}

		if (url.pathname.startsWith('/api/') && request.method === 'OPTIONS') {
			if (!origin) return json({ error: 'CORS origin not allowed' }, 403);
			return withCors(
				new Response(null, {
					status: 204,
					headers: {
						'access-control-allow-methods': 'GET,POST,OPTIONS',
						'access-control-allow-headers': 'Authorization, Content-Type',
						'access-control-max-age': '86400',
					},
				}),
				origin
			);
		}

		try {
			let response: Response;
			const routeKey = `${request.method} ${url.pathname}`;
			switch (routeKey) {
				case 'GET /api/auth/github/start':
					response = await handleGithubStart(request, env);
					break;
				case 'GET /api/auth/github/callback':
					response = await handleGithubCallback(request, env);
					break;
				case 'GET /api/me':
					response = await handleMe(request, env);
					break;
				case 'POST /api/me':
					response = await handleMeUpdate(request, env);
					break;
				case 'POST /api/auth/logout':
					response = await handleLogout(request, env);
					break;
				case 'GET /api/comments':
					response = await handleCommentsGet(request, env);
					break;
				case 'POST /api/comments':
					response = await handleCommentsPost(request, env);
					break;
				case 'GET /api/views':
					response = await handleViewsGet(request, env);
					break;
				case 'GET /api/views/batch':
					response = await handleViewsBatch(request, env);
					break;
				case 'POST /api/views':
					response = await handleViewsPost(request, env);
					break;
				case 'GET /api/images':
					response = await handleImageRoute(request, env);
					break;
				case 'POST /api/images':
					response = await handleImageUpload(request, env);
					break;
				case 'DELETE /api/images':
					response = await handleImageDelete(request, env);
					break;
				case 'POST /api/upload':
					response = await handleImageUpload(request, env);
					break;
				case 'POST /api/auth/email/send':
					response = await handleEmailSend(request, env);
					break;
				case 'GET /api/auth/email/verify':
					response = await handleEmailVerify(request, env);
					break;
				case 'POST /api/auth/email/verify':
					response = await handleEmailVerify(request, env);
					break;
				case 'POST /api/auth/dev-login':
					response = await handleDevLogin(request, env);
					break;
				case 'POST /api/contact':
					response = await handleContact(request, env);
					break;
				case 'GET /api/moderate':
					response = await handleModerationPage(request, env);
					break;
				case 'POST /api/moderate/confirm':
					response = await handleModerationConfirm(request, env);
					break;
				case 'GET /api/admin/stats':
					response = await handleAdminStats(request, env);
					break;
				case 'GET /api/admin/comments':
					response = await handleAdminComments(request, env);
					break;
				case 'POST /api/admin/comment/approve':
					response = await handleAdminCommentAction(request, env, 'approve');
					break;
				case 'POST /api/admin/comment/reject':
					response = await handleAdminCommentAction(request, env, 'reject');
					break;
				case 'DELETE /api/admin/comment':
					response = await handleAdminCommentDelete(request, env);
					break;
				case 'GET /api/admin/check':
					response = await handleAdminCheck(request, env);
					break;
				default:
					response = json({ error: 'Not Found' }, 404, {
						'x-robots-tag': 'noindex, nofollow, noarchive',
					});
					break;
			}

			if (url.pathname.startsWith('/api/')) {
				return withCors(response, origin);
			}
			return response;
		} catch (error) {
			console.error('worker_error', error);
			return withCors(json({ error: 'Internal Server Error' }, 500), origin);
		}
	},
};
