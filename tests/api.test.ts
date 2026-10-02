import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { RateLimiter } from '../src/index';
import type { Env } from '../src/types';

const TOKEN = 'test_session_token_123456789012345';
const EMAIL = 'reader@example.test';
// Complete 1x1 PNG, with verified chunk CRCs and a decodable IDAT stream.
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
let database: DatabaseSync;
let env: Env;
let objects: Map<string, { bytes: ArrayBuffer; contentType?: string }>;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network request in test'); };
  database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  database.prepare('INSERT INTO users (id, login, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)')
    .run(`email:${EMAIL}`, 'reader', EMAIL);
  database.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)')
    .run(TOKEN, `email:${EMAIL}`, Date.now() + 60_000);
  const kv = new Map<string, string>();
  objects = new Map();
  env = {
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) { values = args; return statement; },
          async first() { return database.prepare(sql).get(...values as []) ?? null; },
          async all() { return { results: database.prepare(sql).all(...values as []) }; },
          async run() { const result = database.prepare(sql).run(...values as []); return { meta: { changes: Number(result.changes) } }; },
        };
        return statement;
      },
    },
    IMAGES: {
      async put(key: string, bytes: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
        objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
      },
      async get(key: string) {
        const object = objects.get(key);
        return object ? { body: object.bytes, httpEtag: '"abc123"', httpMetadata: { contentType: object.contentType } } : null;
      },
      async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) {
        return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).slice(0, limit).map(key => ({ key, size: objects.get(key)!.bytes.byteLength })), truncated: false };
      },
      async delete(key: string) { objects.delete(key); },
    },
    RATE_LIMITER: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response('{}') }) },
    RATE_LIMIT_KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } },
    MODERATION_KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } },
    AI: { run: async () => ({ response: 'ALLOW' }) },
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-only-signing-key',
    RESEND_API_KEY: 'test-only-resend-key', CONTACT_TO_EMAIL: 'owner@example.test',
    ADMIN_EMAILS: 'owner@example.test', PUBLIC_ALLOWED_ORIGIN: 'https://blog.example.test',
  } as unknown as Env;
});

afterEach(() => { globalThis.fetch = originalFetch; database.close(); });

async function api(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://api.example.test${path}`, init), env, {} as ExecutionContext);
}

function authenticated(body?: unknown): RequestInit {
  return { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

test('public comments use opaque author IDs for legacy email users, including nested replies', async () => {
  const post = await api('/api/comments', authenticated({ post_id: 'arch-linux', content: 'Useful technical post' }));
  assert.equal(post.status, 201);
  const { comment } = await post.json();
  assert.ok(comment.user.id);
  assert.ok(!JSON.stringify(comment).includes(EMAIL));
  const reply = await api('/api/comments', authenticated({ post_id: 'arch-linux', content: 'A useful reply', parent_id: comment.id }));
  assert.equal(reply.status, 201);
  const list = await (await api('/api/comments?post_id=arch-linux')).json();
  assert.equal(list.comments[0].user.id, comment.user.id);
  assert.equal(list.comments[0].replies[0].user.id, comment.user.id);
  assert.ok(!JSON.stringify(list).includes(EMAIL));
});

test('image uploads are isolated, listable and deletable across signing-key rotation; only verified owners can write legacy post URLs', async () => {
  const legacy = 'posts/cover.png';
  objects.set(legacy, { bytes: new ArrayBuffer(1), contentType: 'image/png' });
  const upload = () => api('/api/images?category=posts&filename=cover.png', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png', 'CF-Access-Authenticated-User-Email': 'owner@example.test' }, body: PNG,
  });
  const response = await upload();
  assert.equal(response.status, 201);
  const own = await response.json();
  assert.notEqual(own.key, legacy);
  assert.ok(!own.key.includes(EMAIL));
  assert.equal(objects.get(legacy)!.bytes.byteLength, 1);
  env.GITHUB_CLIENT_SECRET = 'rotated-test-key';
  const list = await (await api('/api/images', { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.deepEqual(list.images.map((image: { key: string }) => image.key), [own.key]);
  const served = await api(`/api/images?key=${encodeURIComponent(own.key)}`);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await api('/api/images', { ...authenticated({ key: legacy }), method: 'DELETE' })).status, 403);
  assert.equal((await api('/api/images', { ...authenticated({ key: own.key }), method: 'DELETE' })).status, 200);
  assert.ok(!objects.has(own.key));
  database.prepare('UPDATE users SET email = ?, email_verified = 0').run('owner@example.test');
  const unverified = await (await upload()).json();
  assert.notEqual(unverified.key, legacy);
  database.exec('UPDATE users SET email_verified = 1');
  const owner = await (await upload()).json();
  assert.equal(owner.key, legacy);
  assert.equal(objects.get(legacy)!.bytes.byteLength, PNG.byteLength);
});

test('mail provider rejection is reported by login/contact, while pending comments remain saved', async (context) => {
  const errors = context.mock.method(console, 'error', () => {});
  globalThis.fetch = async input => {
    assert.equal(new URL(String(input)).hostname, 'api.resend.com');
    return Response.json({ name: 'validation_error', message: 'Test provider rejection' }, { status: 422 });
  };
  assert.equal((await api('/api/auth/email/send', authenticated({ email: EMAIL }))).status, 500);
  assert.equal((await api('/api/contact', authenticated({ name: 'Reader', email: EMAIL, message: 'A useful message for the owner' }))).status, 500);
  const pending = await api('/api/comments', authenticated({ post_id: 'arch-linux', content: 'https://example.test/technical-reference' }));
  assert.equal(pending.status, 201);
  assert.equal((await pending.json()).comment.status, 'pending');
  assert.equal(errors.mock.callCount(), 3);
});

test('cross-origin authenticated delete supports preflight and response headers', async () => {
  const origin = 'https://blog.example.test';
  const preflight = await api('/api/images', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'DELETE' } });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-methods')?.split(',').includes('DELETE'));
  const result = await api('/api/images', { method: 'DELETE', headers: { origin } });
  assert.ok(result.headers.get('access-control-allow-methods')?.split(',').includes('DELETE'));
});

test('allowlisted credentialed requests receive CORS permission on preflight and actual responses only', async () => {
  const origin = 'https://blog.example.test';
  for (const [method, path] of [['OPTIONS', '/api/admin/check'], ['GET', '/api/admin/check'], ['POST', '/api/admin/comment/approve']]) {
    const response = await api(path, { method, headers: { origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  }
  for (const headers of [{ origin: 'https://untrusted.example' }, {}]) {
    const response = await api('/api/admin/check', { headers });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  }
});

test('moderation mail links expire, reject tampering and can only resolve pending comments once', async (context) => {
  let mail = '';
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'api.resend.com');
    mail = JSON.parse(String(init?.body)).html;
    return Response.json({ id: 'test-email' });
  };
  const response = await api('/api/comments', authenticated({ post_id: 'arch-linux', content: 'https://example.test/reference' }));
  const { comment } = await response.json();
  assert.equal(comment.status, 'pending');
  const links = [...mail.matchAll(/href="([^"]+\/api\/moderate\?[^"]+)"/g)].map(match => new URL(match[1]));
  assert.equal(links.length, 2);
  const approval = links[0];
  assert.ok(Number(approval.searchParams.get('exp')) > Date.now());
  const get = await api(`${approval.pathname}${approval.search}`);
  assert.equal(get.status, 200);
  const page = await get.text();
  assert.match(page, /name="exp"/);
  const confirm = (link: URL) => api('/api/moderate/confirm', { method: 'POST', body: new URLSearchParams(link.searchParams) });
  const tampered = new URL(approval);
  tampered.searchParams.set('id', 'other-comment');
  assert.equal((await confirm(tampered)).status, 403);
  const noExpiry = new URL(approval);
  noExpiry.searchParams.delete('exp');
  assert.equal((await confirm(noExpiry)).status, 403);
  const extended = new URL(approval);
  extended.searchParams.set('exp', String(Number(extended.searchParams.get('exp')) + 1000));
  assert.equal((await confirm(extended)).status, 403);
  assert.equal((await confirm(approval)).status, 200);
  assert.equal((await confirm(links[1])).status, 409);
  assert.equal((await confirm(approval)).status, 409);
  const published = await (await api('/api/comments?post_id=arch-linux')).json();
  assert.equal(published.comments[0].id, comment.id);
  context.mock.method(Date, 'now', () => Number(approval.searchParams.get('exp')) + 1);
  assert.equal((await confirm(approval)).status, 403);
});

test('rate limiter rejects excess requests, expires idle buckets and removes legacy storage', async (context) => {
  let now = 1_900_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const records = new Map<string, unknown>([['legacy:ip:route:123', 10]]);
  let alarm: number | null = null;
  const storage = {
    async get(key: string) { return records.get(key); },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) records.delete(item); },
    async deleteAll() { records.clear(); },
    async list({ prefix = '' } = {}) { return new Map([...records].filter(([key]) => key.startsWith(prefix))); },
    async getAlarm() { return alarm; },
    async setAlarm(value: number) { alarm = value; },
    async deleteAlarm() { alarm = null; },
    async transaction<T>(callback: (transaction: unknown) => Promise<T>) { return callback(storage); },
  };
  let initialized = Promise.resolve();
  const state = { storage, blockConcurrencyWhile(callback: () => Promise<void>) { initialized = callback(); return initialized; } };
  const limiter = new RateLimiter(state as unknown as DurableObjectState);
  await initialized;
  const consume = () => limiter.fetch(new Request('https://limiter.test', { method: 'POST', body: JSON.stringify({ ip: 'test', route: 'comments', limit: 1, windowMs: 1000 }) }));
  assert.equal((await consume()).status, 200);
  assert.equal((await consume()).status, 429);
  const slow = () => limiter.fetch(new Request('https://limiter.test', { method: 'POST', body: JSON.stringify({ route: 'slow', limit: 1, windowMs: 10_000 }) }));
  assert.equal((await slow()).status, 200);
  now += 1001;
  await limiter.alarm();
  assert.equal((await slow()).status, 429); // Another route's live window survives cleanup.
  assert.ok(alarm !== null);
  now += 10_001;
  await limiter.alarm();
  assert.ok(!records.has('legacy:ip:route:123'));
  assert.equal(records.size, 1); // Only the schema marker survives idle cleanup.
  assert.equal((await consume()).status, 200);
});

test('admin APIs reject fabricated Access headers and accept only a verified allowlisted email session', async () => {
  const forged = await api('/api/admin/stats', { headers: { 'CF-Access-Authenticated-User-Email': 'owner@example.test' } });
  assert.equal(forged.status, 403);
  const headers = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await api('/api/admin/stats', { headers })).status, 403);
  database.prepare('UPDATE users SET email = ?, email_verified = 0').run('owner@example.test');
  assert.equal((await api('/api/admin/stats', { headers })).status, 403);
  database.exec('UPDATE users SET email_verified = 1');
  assert.equal((await api('/api/admin/stats', { headers })).status, 200);
});

test('Access JWT authorization verifies signature, issuer, audience, expiry and the signed email', async () => {
  const keypair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keypair.publicKey);
  env.ACCESS_TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
  env.ACCESS_AUD = 'test-application';
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs');
    return Response.json({ keys: [{ ...publicKey, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
  };
  const claims = { iss: 'https://test-team.cloudflareaccess.com', aud: ['test-application'], email: 'owner@example.test', exp: Math.floor(Date.now() / 1000) + 300 };
  const makeToken = async (payload: object) => {
    const encoded = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keypair.privateKey, new TextEncoder().encode(encoded));
    return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
  };
  const check = (token: string) => api('/api/admin/stats', { headers: { 'Cf-Access-Jwt-Assertion': token, 'CF-Access-Authenticated-User-Email': 'owner@example.test' } });
  assert.equal((await check(await makeToken(claims))).status, 200);
  for (const invalid of [
    { ...claims, aud: ['other-app'] }, { ...claims, iss: 'https://other.cloudflareaccess.com' },
    { ...claims, exp: 1 }, { ...claims, email: 'attacker@example.test' },
    { ...claims, exp: undefined }, { ...claims, nbf: Math.floor(Date.now() / 1000) + 300 },
  ]) assert.equal((await check(await makeToken(invalid))).status, 403);
  const token = await makeToken(claims);
  const parts = token.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  assert.equal((await check(parts.join('.'))).status, 403);
  env.ACCESS_AUD = undefined;
  assert.equal((await check(token)).status, 403);
});

test('OAuth returns and CORS accept only explicit origins, rejecting network-path and backslash URLs', async () => {
  for (const value of ['//evil.example/path', '/\\evil.example/path', 'https://untrusted.pages.dev', 'https://danarnoux.com.evil.example']) {
    const response = await api('/api/auth/github/callback', { headers: { cookie: `__Secure-gh_return_to=${encodeURIComponent(value)}` } });
    assert.equal(new URL(response.headers.get('location')!).origin, 'https://blog.example.test');
  }
  const allowed = await api('/api/auth/github/callback', { headers: { cookie: `__Secure-gh_return_to=${encodeURIComponent('/blog/arch-linux')}` } });
  assert.equal(allowed.headers.get('location'), 'https://blog.example.test/blog/arch-linux');
  const rejected = await api('/api/comments', { method: 'OPTIONS', headers: { origin: 'https://untrusted.pages.dev' } });
  assert.equal(rejected.status, 403);
  env.PUBLIC_ALLOWED_ORIGIN += ',https://own-preview.pages.dev';
  const preview = await api('/api/comments', { method: 'OPTIONS', headers: { origin: 'https://own-preview.pages.dev' } });
  assert.equal(preview.status, 204);
});

test('profile update throttling stops AI calls before changing the profile', async () => {
  env.RATE_LIMITER = { idFromName: () => 'limited', get: () => ({ fetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) }) } as unknown as DurableObjectNamespace;
  let calls = 0;
  env.AI = { run: async () => { calls++; return { response: 'ALLOW' }; } } as unknown as Ai;
  const response = await api('/api/me', authenticated({ username: 'New reader name' }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(calls, 0);
  const profile = await (await api('/api/me', { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(profile.user.name, null);
});

test('image upload bounds reject active formats, oversized bodies and invalid paths without writing R2', async () => {
  const upload = (contentType: string, body: Uint8Array) => api('/api/images', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': contentType }, body,
  });
  assert.equal((await upload('image/svg+xml', new TextEncoder().encode('<svg/>'))).status, 415);
  assert.equal((await upload('image/png', new Uint8Array(5 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload('image/png', new Uint8Array())).status, 400);
  const invalid = await api('/api/images?prefix=..%2Fposts', { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(invalid.status, 400);
  assert.equal(objects.size, 0);
});

test('two regular accounts cannot overwrite, list or delete each other\'s same-named images', async () => {
  const secondToken = 'second_session_token_1234567890123';
  database.prepare('INSERT INTO users (id, login, created_at, updated_at) VALUES (?, ?, 0, 0)').run('github:42', 'second-reader');
  database.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)').run(secondToken, 'github:42', Date.now() + 60_000);
  const upload = async (token: string) => (await api('/api/images?category=misc&filename=photo.png', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, body: PNG,
  })).json();
  const first = await upload(TOKEN);
  const second = await upload(secondToken);
  assert.notEqual(first.key, second.key);
  const headers = { authorization: `Bearer ${secondToken}`, 'content-type': 'application/json' };
  const list = await (await api('/api/images', { headers })).json();
  assert.deepEqual(list.images.map((entry: { key: string }) => entry.key), [second.key]);
  const deletion = await api('/api/images', { method: 'DELETE', headers, body: JSON.stringify({ key: first.key }) });
  assert.equal(deletion.status, 403);
  assert.ok(objects.has(first.key));
});

test('image upload sniffs file signatures instead of trusting the declared MIME type', async () => {
  const upload = (contentType: string, body: Uint8Array) => api('/api/images', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': contentType }, body,
  });
  assert.equal((await upload('image/png', new TextEncoder().encode('plain text, not an image'))).status, 415);
  assert.equal((await upload('image/png', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status, 415);
  assert.equal((await upload('image/jpeg', PNG)).status, 415);
  assert.equal(objects.size, 0);
  assert.equal((await upload('image/png', PNG)).status, 201);
  assert.equal(objects.size, 1);
});

test('public comments hide legacy or email-bearing avatars while owners can replace their original profile URL', async () => {
  const privateAvatars = [
    `https://img.danarnoux.com/avatars/email_${EMAIL}/old.png`,
    `https://img.danarnoux.com/avatars/email_${encodeURIComponent(EMAIL)}/old.png`,
    `https://images.example.test/${encodeURIComponent(encodeURIComponent(EMAIL))}.png`,
    'https://img.danarnoux.com/avatars/email_old-address%40example.test/old.png',
  ];
  for (const avatar of privateAvatars) {
    database.prepare('UPDATE users SET avatar_url = ?').run(avatar);
    const posted = await api('/api/comments', authenticated({ post_id: 'arch-linux', content: 'Useful image reference' }));
    assert.equal(posted.status, 201);
    assert.equal((await posted.json()).comment.user.avatarUrl, null);
    const publicResult = await (await api('/api/comments?post_id=arch-linux')).json();
    assert.ok(publicResult.comments.every((comment: { user: { avatarUrl: unknown } }) => comment.user.avatarUrl === null));
    const own = await (await api('/api/me', { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.equal(own.user.avatarUrl, avatar);
  }
  const replacement = 'https://img.danarnoux.com/images/u_opaque/avatars/new.png';
  assert.equal((await api('/api/me', authenticated({ avatarUrl: replacement }))).status, 200);
  const updated = await (await api('/api/comments?post_id=arch-linux')).json();
  assert.ok(updated.comments.every((comment: { user: { avatarUrl: unknown } }) => comment.user.avatarUrl === replacement));
});

test('image namespaces are random database identities shared by concurrent requests and preserved through restart and key rotation', async () => {
  // Model an existing deployment that has not run the new additive migration.
  database.exec('DROP TABLE IF EXISTS user_image_namespaces');
  const upload = async () => {
    const response = await api('/api/images?category=avatars&filename=avatar.png', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png' }, body: PNG,
    });
    assert.equal(response.status, 201);
    return (await response.json()).key as string;
  };
  const simultaneous = await Promise.all(Array.from({ length: 8 }, upload));
  assert.equal(new Set(simultaneous).size, 1);
  const original = simultaneous[0];
  // A fresh binding object represents a restarted worker using the persisted DB.
  env.DB = { prepare: env.DB.prepare.bind(env.DB) } as D1Database;
  env.GITHUB_CLIENT_SECRET = 'another-rotated-key';
  env.MODERATION_SECRET = 'rotated-moderation-key';
  assert.equal(await upload(), original);
  // The same mailbox in a separately initialized store must not reproduce the
  // public directory, unlike SHA(email). No secret is used to create this ID.
  database.exec('DROP TABLE IF EXISTS user_image_namespaces');
  env.DB = { prepare: env.DB.prepare.bind(env.DB) } as D1Database;
  assert.notEqual(await upload(), original);
});
