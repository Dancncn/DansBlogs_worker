import type { Env } from './types';
import { COMMENT_MAX_LENGTH, COMMENT_MIN_LENGTH, COMMENT_DAILY_LIMIT } from './types';
import {
	json, bearerToken, normalizePostSlug, containsHtml, randomBase64Url,
	findSessionUser, checkRateLimit,
} from './utils';
import { moderateContent } from './moderation';

export async function handleCommentsGet(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const post = normalizePostSlug(url.searchParams.get('post_id'));
	if (!post) return json({ error: 'Invalid post slug' }, 400);

	const result = await env.DB.prepare(
		`SELECT
		 c.id AS id,
		 c.parent_id AS parent_id,
		 c.post_slug AS post_slug,
		 c.body AS body,
		 c.status AS status,
		 c.created_at AS created_at,
		 u.id AS user_id,
		 u.login AS user_login,
		 u.name AS user_name,
		 u.avatar_url AS user_avatar_url,
		 u.profile_url AS user_profile_url
		 FROM comments c
		 JOIN users u ON u.id = c.user_id
		 WHERE c.post_slug = ? AND c.status = 'approved'
		 ORDER BY c.created_at ASC`
	)
		.bind(post)
		.all<{
			id: string;
			parent_id: string | null;
			post_slug: string;
			body: string;
			status: string;
			created_at: number;
			user_id: string;
			user_login: string;
			user_name: string | null;
			user_avatar_url: string | null;
			user_profile_url: string | null;
		}>();

	interface CommentNode {
		id: string;
		parentId: string | null;
		postSlug: string;
		body: string;
		status: string;
		createdAt: number;
		replies: CommentNode[];
		user: {
			id: string;
			login: string;
			name: string | null;
			avatarUrl: string | null;
			profileUrl: string | null;
		};
	}

	const commentMap = new Map<string, CommentNode>();
	const rootComments: CommentNode[] = [];

	for (const row of result.results ?? []) {
		const comment: CommentNode = {
			id: row.id,
			parentId: row.parent_id,
			postSlug: row.post_slug,
			body: row.body,
			status: row.status,
			createdAt: row.created_at,
			replies: [],
			user: {
				id: row.user_id,
				login: row.user_login,
				name: row.user_name,
				avatarUrl: row.user_avatar_url,
				profileUrl: row.user_profile_url,
			},
		};
		commentMap.set(row.id, comment);
	}

	for (const comment of commentMap.values()) {
		if (comment.parentId && commentMap.has(comment.parentId)) {
			commentMap.get(comment.parentId)!.replies.push(comment);
		} else {
			rootComments.push(comment);
		}
	}

	return json({ comments: rootComments });
}

export async function handleCommentsPost(request: Request, env: Env): Promise<Response> {
	const rate = await checkRateLimit(request, env, 'comment_post');
	if (rate) return rate;

	const token = bearerToken(request);
	if (!token) return json({ error: 'Unauthorized' }, 401);

	const session = await findSessionUser(env, token);
	if (!session) return json({ error: 'Unauthorized' }, 401);

	if (!request.headers.get('content-type')?.includes('application/json')) {
		return json({ error: 'Content-Type must be application/json' }, 415);
	}

	let payload: { post_id?: unknown; content?: unknown; parent_id?: unknown };
	try {
		payload = (await request.json()) as { post_id?: unknown; content?: unknown; parent_id?: unknown };
	} catch {
		return json({ error: 'Invalid JSON' }, 400);
	}

	const post = normalizePostSlug(payload.post_id);
	if (!post) return json({ error: 'Invalid post slug' }, 400);

	const body = typeof payload.content === 'string' ? payload.content.trim() : '';
	if (body.length < COMMENT_MIN_LENGTH || body.length > COMMENT_MAX_LENGTH) {
		return json({ error: `Comment length must be ${COMMENT_MIN_LENGTH}-${COMMENT_MAX_LENGTH}` }, 400);
	}
	if (containsHtml(body)) return json({ error: 'HTML is not allowed' }, 400);

	const now = Date.now();
	const midnightUTC = new Date();
	midnightUTC.setUTCHours(24, 0, 0, 0);
	const todayStart = midnightUTC.getTime() - 24 * 60 * 60 * 1000;

	const dailyCountRow = await env.DB.prepare(
		`SELECT COUNT(*) as count FROM comments WHERE user_id = ? AND created_at >= ?`
	)
		.bind(session.user_id, todayStart)
		.first<{ count: number }>();

	if (dailyCountRow && dailyCountRow.count >= COMMENT_DAILY_LIMIT) {
		return json({ error: `Daily comment limit reached (${COMMENT_DAILY_LIMIT}/day). Resets at midnight UTC.` }, 429);
	}

	let parentId: string | null = null;
	if (payload.parent_id) {
		const parentIdStr = typeof payload.parent_id === 'string' ? payload.parent_id.trim() : '';
		if (parentIdStr) {
			const parentRow = await env.DB.prepare(
				`SELECT id FROM comments WHERE id = ? AND post_slug = ? LIMIT 1`
			)
				.bind(parentIdStr, post)
				.first<{ id: string }>();
			if (parentRow) parentId = parentIdStr;
		}
	}

	const modResult = await moderateContent(body, env);
	if (modResult.result === 'REJECT') {
		return json({ error: 'Comment rejected by moderation' }, 400);
	}

	const commentId = `c_${randomBase64Url(12)}`;

	await env.DB.prepare(
		`INSERT INTO comments (id, parent_id, post_slug, user_id, body, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)`
	)
		.bind(commentId, parentId, post, session.user_id, body, now, now)
		.run();

	return json(
		{
			comment: {
				id: commentId,
				parentId,
				postSlug: post,
				body,
				status: 'approved',
				createdAt: now,
				user: {
					id: session.user_id,
					login: session.login,
					name: session.name,
					avatarUrl: session.avatar_url,
					profileUrl: session.profile_url,
				},
			},
		},
		201
	);
}
