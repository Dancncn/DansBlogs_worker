import type { Env } from './types';
import { json } from './utils';

async function adminAuth(request: Request, env: Env): Promise<{ authorized: boolean; email: string | null }> {
	const cfEmail = request.headers.get('CF-Access-Authenticated-User-Email');
	if (!cfEmail) return { authorized: false, email: null };

	const adminList = (env.ADMIN_EMAILS || '')
		.split(',')
		.map(e => e.trim().toLowerCase())
		.filter(Boolean);

	return {
		authorized: adminList.includes(cfEmail.toLowerCase()),
		email: cfEmail,
	};
}

export async function handleAdminStats(request: Request, env: Env): Promise<Response> {
	const auth = await adminAuth(request, env);
	if (!auth.authorized) return json({ error: 'Unauthorized' }, 403);

	const total = await env.DB.prepare('SELECT COUNT(*) as count FROM comments').first<{ count: number }>();
	const pending = await env.DB.prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'pending'").first<{ count: number }>();
	const approved = await env.DB.prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'approved'").first<{ count: number }>();
	const rejected = await env.DB.prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'rejected'").first<{ count: number }>();

	return json({
		total: total?.count ?? 0,
		pending: pending?.count ?? 0,
		approved: approved?.count ?? 0,
		rejected: rejected?.count ?? 0,
	});
}

export async function handleAdminComments(request: Request, env: Env): Promise<Response> {
	const auth = await adminAuth(request, env);
	if (!auth.authorized) return json({ error: 'Unauthorized' }, 403);

	const url = new URL(request.url);
	const status = url.searchParams.get('status');

	let query = `SELECT c.id, c.post_slug, c.body, c.status, c.created_at, c.updated_at,
                        u.login, u.name, u.avatar_url
                 FROM comments c
                 JOIN users u ON c.user_id = u.id`;
	const bindings: string[] = [];

	if (status && ['pending', 'approved', 'rejected'].includes(status)) {
		query += ' WHERE c.status = ?';
		bindings.push(status);
	}
	query += ' ORDER BY c.created_at DESC LIMIT 100';

	const result = await env.DB.prepare(query).bind(...bindings).all();
	return json({ comments: result.results });
}

export async function handleAdminCommentAction(request: Request, env: Env, action: 'approve' | 'reject'): Promise<Response> {
	const auth = await adminAuth(request, env);
	if (!auth.authorized) return json({ error: 'Unauthorized' }, 403);

	const { id } = await request.json() as { id?: string };
	if (!id) return json({ error: 'Missing id' }, 400);

	const newStatus = action === 'approve' ? 'approved' : 'rejected';
	const result = await env.DB.prepare(
		"UPDATE comments SET status = ?, updated_at = ? WHERE id = ?"
	).bind(newStatus, Date.now(), id).run();

	return json({ success: true, changes: result.meta?.changes ?? 0 });
}

export async function handleAdminCommentDelete(request: Request, env: Env): Promise<Response> {
	const auth = await adminAuth(request, env);
	if (!auth.authorized) return json({ error: 'Unauthorized' }, 403);

	const url = new URL(request.url);
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, 400);

	const result = await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
	return json({ success: true, changes: result.meta?.changes ?? 0 });
}

export async function handleAdminCheck(request: Request, env: Env): Promise<Response> {
	const auth = await adminAuth(request, env);
	return json({ isAdmin: auth.authorized, email: auth.email });
}
