import type { Env, SessionRow } from './types';
import { json, bearerToken, findSessionUser, checkRateLimit, clampInt, isSessionAdmin } from './utils';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/x-icon']);
const CATEGORIES = new Set(['posts', 'avatars', 'misc']);

// Format sniffing only: confirms the file signature agrees with the MIME type.
// It does not fully decode the image or certify the integrity of every chunk.
function imageType(bytes: ArrayBuffer): string | null {
	const data = new Uint8Array(bytes);
	const matches = (offset: number, signature: readonly number[]) =>
		data.length >= offset + signature.length && signature.every((byte, index) => data[offset + index] === byte);
	const text = (offset: number, length: number) => String.fromCharCode(...data.subarray(offset, offset + length));
	if (matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	if (matches(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
	if (data.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp';
	if (data.length >= 14 && text(0, 2) === 'BM') return 'image/bmp';
	if (data.length >= 6 && matches(0, [0, 0, 1, 0]) && (data[4] !== 0 || data[5] !== 0)) return 'image/x-icon';
	if (data.length >= 16 && text(4, 4) === 'ftyp') {
		const boxSize = new DataView(bytes).getUint32(0);
		if (boxSize >= 16 && boxSize <= data.length) {
			if (['avif', 'avis'].includes(text(8, 4))) return 'image/avif';
			for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
				if (['avif', 'avis'].includes(text(offset, 4))) return 'image/avif';
			}
		}
	}
	return null;
}

const namespaceTables = new WeakMap<D1Database, Promise<void>>();

// A random, persisted namespace cannot be recomputed from a guessed mailbox.
// The additive lazy initialization keeps pre-migration databases usable.
async function userPrefix(session: SessionRow, env: Env): Promise<string> {
	let ready = namespaceTables.get(env.DB);
	if (!ready) {
		ready = env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_image_namespaces (
			user_id TEXT PRIMARY KEY NOT NULL,
			namespace TEXT NOT NULL UNIQUE,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)`).run().then(() => {}).catch(error => {
			namespaceTables.delete(env.DB);
			throw error;
		});
		namespaceTables.set(env.DB, ready);
	}
	await ready;
	const readNamespace = () => env.DB.prepare('SELECT namespace FROM user_image_namespaces WHERE user_id = ?')
		.bind(session.user_id).first<{ namespace: string }>();
	let row = await readNamespace();
	if (!row) {
		await env.DB.prepare(`INSERT INTO user_image_namespaces (user_id, namespace) VALUES (?, ?)
			ON CONFLICT(user_id) DO NOTHING`).bind(session.user_id, crypto.randomUUID()).run();
		// Concurrent first uploads converge on the row that won the unique key.
		row = await readNamespace();
	}
	if (!row) throw new Error('Image namespace could not be initialized');
	return `images/u_${row.namespace}/`;
}

function validKey(key: string): boolean {
	return !!key && key.length <= 1024 && !/[\\\u0000-\u001f]/.test(key)
		&& key.split('/').every(part => !!part && part !== '.' && part !== '..');
}

function imageUrl(key: string): string {
	return `https://img.danarnoux.com/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function handleImageRoute(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.searchParams.has('key')) {
		const key = url.searchParams.get('key') || '';
		if (!validKey(key)) return json({ error: 'Invalid image key' }, 400);
		const object = await env.IMAGES.get(key);
		if (!object) return json({ error: 'Image not found' }, 404);
		return new Response(object.body, { headers: {
			'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
			'cache-control': 'public, max-age=3600',
			'x-content-type-options': 'nosniff',
		} });
	}
	const token = bearerToken(request);
	const session = token ? await findSessionUser(env, token) : null;
	if (!session) return json({ error: 'Unauthorized' }, 401);
	const prefix = (url.searchParams.get('prefix') || '').replace(/\/$/, '');
	if (prefix && !validKey(prefix)) return json({ error: 'Invalid image prefix' }, 400);
	const root = isSessionAdmin(session, env) ? '' : await userPrefix(session, env);
	const effectivePrefix = `${root}${prefix ? `${prefix}/` : ''}`;
	const result = await env.IMAGES.list({
		prefix: effectivePrefix,
		limit: clampInt(url.searchParams.get('limit') || 100, 1, 1000, 100),
		cursor: url.searchParams.get('cursor') || undefined,
	});
	return json({
		images: result.objects.map(object => ({ key: object.key, size: object.size, url: imageUrl(object.key) })),
		truncated: result.truncated, cursor: result.truncated ? result.cursor : undefined,
	});
}

async function readImage(request: Request): Promise<ArrayBuffer | null> {
	if (!request.body) return new ArrayBuffer(0);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return null; }
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes.buffer;
}

export async function handleImageUpload(request: Request, env: Env): Promise<Response> {
	const token = bearerToken(request);
	const session = token ? await findSessionUser(env, token) : null;
	if (!session) return json({ error: 'Unauthorized' }, 401);
	const rate = await checkRateLimit(request, env, 'image_upload');
	if (rate) return rate;
	const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	if (!IMAGE_TYPES.has(contentType)) return json({ error: 'Unsupported image type' }, 415);
	if (Number(request.headers.get('content-length')) > MAX_IMAGE_BYTES) return json({ error: 'Image exceeds 5 MiB' }, 413);
	const url = new URL(request.url);
	const category = url.searchParams.get('category') || 'misc';
	const safeCategory = CATEGORIES.has(category) ? category : 'misc';
	const filename = (url.searchParams.get('filename') || 'image').replace(/[^a-zA-Z0-9\-_.]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'image';
	const bytes = await readImage(request);
	if (!bytes) return json({ error: 'Image exceeds 5 MiB' }, 413);
	if (!bytes.byteLength) return json({ error: 'Image is empty' }, 400);
	if (imageType(bytes) !== contentType) return json({ error: 'Image content does not match its Content-Type' }, 415);
	// Keep existing article URLs writable only by the verified owner.
	const key = isSessionAdmin(session, env) && safeCategory !== 'avatars'
		? `${safeCategory}/${filename}` : `${await userPrefix(session, env)}${safeCategory}/${filename}`;
	await env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
	return json({ key, url: imageUrl(key) }, 201);
}

export async function handleImageDelete(request: Request, env: Env): Promise<Response> {
	const token = bearerToken(request);
	const session = token ? await findSessionUser(env, token) : null;
	if (!session) return json({ error: 'Unauthorized' }, 401);
	let payload: { key?: unknown };
	try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
	const key = typeof payload.key === 'string' ? payload.key : '';
	if (!validKey(key)) return json({ error: 'Invalid image key' }, 400);
	const ownPrefixes = [await userPrefix(session, env), `images/${session.user_id}/`, `avatars/${session.user_id.replace(':', '_')}/`];
	const owned = ownPrefixes.some(prefix => key.startsWith(prefix));
	const admin = isSessionAdmin(session, env) && /^(posts|misc|avatars|images)\//.test(key);
	if (!owned && !admin) return json({ error: 'Cannot delete other users\' images' }, 403);
	await env.IMAGES.delete(key);
	return json({ ok: true });
}
