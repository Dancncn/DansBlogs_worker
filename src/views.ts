import type { Env, PostViewsRow } from './types';
import { json, normalizePostSlug, checkRateLimit } from './utils';

export async function handleViewsGet(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const post = normalizePostSlug(url.searchParams.get('post'));
	if (!post) return json({ error: 'Invalid post slug' }, 400);

	const row = await env.DB.prepare('SELECT post_slug, views FROM post_views WHERE post_slug = ? LIMIT 1')
		.bind(post)
		.first<PostViewsRow>();

	return json({ post, views: Number(row?.views ?? 0) });
}

export async function handleViewsBatch(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const postsParam = url.searchParams.get('posts') || '';
	const slugs = postsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);

	if (slugs.length === 0) return json({ views: {} });

	const validSlugs = slugs.filter(s => normalizePostSlug(s) !== null);
	if (validSlugs.length === 0) return json({ views: {} });

	const placeholders = validSlugs.map(() => '?').join(',');
	const result = await env.DB.prepare(
		`SELECT post_slug, views FROM post_views WHERE post_slug IN (${placeholders})`
	).bind(...validSlugs).all<PostViewsRow>();

	const viewsMap: Record<string, number> = {};
	for (const slug of validSlugs) viewsMap[slug] = 0;
	for (const row of result.results ?? []) viewsMap[row.post_slug] = Number(row.views);

	return json({ views: viewsMap });
}

export async function handleViewsPost(request: Request, env: Env): Promise<Response> {
	const rate = await checkRateLimit(request, env, 'post_views');
	if (rate) return rate;

	if (!request.headers.get('content-type')?.includes('application/json')) {
		return json({ error: 'Content-Type must be application/json' }, 415);
	}

	let payload: { post?: unknown };
	try {
		payload = (await request.json()) as { post?: unknown };
	} catch {
		return json({ error: 'Invalid JSON' }, 400);
	}

	const post = normalizePostSlug(payload.post);
	if (!post) return json({ error: 'Invalid post slug' }, 400);

	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO post_views (post_slug, views, created_at, updated_at)
		 VALUES (?, 1, ?, ?)
		 ON CONFLICT(post_slug) DO UPDATE SET
		 	views = post_views.views + 1,
		 	updated_at = excluded.updated_at`
	)
		.bind(post, now, now)
		.run();

	const row = await env.DB.prepare('SELECT post_slug, views FROM post_views WHERE post_slug = ? LIMIT 1')
		.bind(post)
		.first<PostViewsRow>();

	return json({ post, views: Number(row?.views ?? 0), incremented: true });
}
