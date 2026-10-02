import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const TOKEN_A = 'runtime_session_reader_a_1234567890';
const TOKEN_B = 'runtime_session_reader_b_1234567890';
const ORIGIN = 'https://blog.example.test';
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));

test('bundled Worker runs against isolated workerd D1, KV, R2 and Durable Objects', { timeout: 60_000 }, async context => {
  const bundle = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'blog-worker-runtime-'));
  const blockedRequests: string[] = [];
  let runtime: Miniflare | undefined;
  const createRuntime = (secret: string) => new Miniflare({
    ...convertV4MiniflareOptions({
    name: 'runtime-blog',
    host: '127.0.0.1', port: 0,
    compatibilityDate: '2026-10-02',
    modulesRoot: directory,
    modules: [
      {
        type: 'ESModule', path: join(directory, 'harness.mjs'),
        // Only the DO exposes a test-only read probe. All API requests use the
        // unchanged bundled default export; scheduling and alarm() are inherited.
        contents: `import app, { RateLimiter as ActualLimiter } from './worker.mjs';
          export default app;
          export class RateLimiter extends ActualLimiter {
            constructor(state) { super(state); this.probeState = state; }
            async fetch(request) {
              if (request.method === 'GET' && new URL(request.url).pathname === '/__runtime/state') {
                return Response.json({
                  entries: Object.fromEntries(await this.probeState.storage.list()),
                  alarm: await this.probeState.storage.getAlarm()
                });
              }
              return super.fetch(request);
            }
          }`,
      },
      { type: 'ESModule', path: join(directory, 'worker.mjs'), contents: bundle },
    ],
    bindings: {
      GITHUB_CLIENT_ID: 'runtime-test-client', GITHUB_CLIENT_SECRET: secret,
      ADMIN_EMAILS: 'owner@example.test', PUBLIC_ALLOWED_ORIGIN: ORIGIN,
    },
    d1Databases: { DB: 'runtime-db' },
    kvNamespaces: { RATE_LIMIT_KV: 'runtime-rate-kv', MODERATION_KV: 'runtime-moderation-kv' },
    r2Buckets: { IMAGES: 'runtime-images' },
    durableObjects: { RATE_LIMITER: { className: 'RateLimiter', useSQLite: true } },
    resourcePersistencePath: join(directory, 'resources'),
    outboundService(request) {
      blockedRequests.push(new URL(request.url).hostname);
      return Response.json({ error: 'External network is disabled in runtime tests' }, { status: 503 });
    },
    log: new Log(LogLevel.ERROR),
    }),
    cf: false,
    telemetry: { enabled: false },
  });
  context.after(async () => {
    await runtime?.dispose();
    // Verify the absolute target before removing the isolated test directory.
    const actual = await realpath(directory);
    const temporaryRoot = await realpath(tmpdir());
    assert.equal(dirname(actual), temporaryRoot);
    assert.ok(basename(actual).startsWith('blog-worker-runtime-'));
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  runtime = createRuntime('runtime-signing-key');
  await runtime.ready;
  const api = async (path: string, init: RequestInit = {}) => {
    // Exercise the actual loopback HTTP listener, not an in-process handler.
    const response = await fetch(new URL(path, await runtime!.ready), { ...init, redirect: 'manual' });
    return response;
  };
  const headers = (token = TOKEN_A) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const database = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await database.batch(schema.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => database.prepare(sql)));
  for (const [user, email, token] of [
    ['email:runtime-a@example.test', 'runtime-a@example.test', TOKEN_A],
    ['email:runtime-b@example.test', 'runtime-b@example.test', TOKEN_B],
  ]) {
    await database.prepare('INSERT INTO users (id, login, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)')
      .bind(user, 'runtime-reader', email).run();
    await database.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)')
      .bind(token, user, Date.now() + 3_600_000).run();
  }

  await context.test('HTTP routing, credentialed CORS, D1 views and admin rejection', async () => {
    assert.equal((await api('/robots.txt')).status, 200);
    assert.equal((await api('/missing')).status, 404);
    const preflight = await api('/api/images', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'DELETE' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.ok(preflight.headers.get('access-control-allow-methods')?.includes('DELETE'));
    assert.equal((await api('/api/images', { method: 'OPTIONS', headers: { origin: 'https://untrusted.example' } })).status, 403);
    const forbidden = await api('/api/admin/stats', { headers: { origin: ORIGIN, 'CF-Access-Authenticated-User-Email': 'owner@example.test' } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get('access-control-allow-credentials'), 'true');
    assert.equal((await api('/api/admin/stats', { headers: headers() })).status, 403);
    assert.equal((await api('/api/me', { headers: headers() })).status, 200);
    const increment = await api('/api/views', { method: 'POST', headers: headers(), body: JSON.stringify({ post: 'runtime-arch' }) });
    assert.equal(increment.status, 200);
    assert.equal((await increment.json()).views, 1);
    assert.equal((await (await api('/api/views?post=runtime-arch')).json()).views, 1);
  });

  await context.test('real KV moderation cache feeds a persisted D1 comment with a private author ID', async () => {
    const body = 'Runtime validation is useful';
    const cache = await runtime!.getKVNamespace('MODERATION_KV');
    await cache.put(`mod:v3:${createHash('sha256').update(body).digest('hex')}`, 'ALLOW');
    const posted = await api('/api/comments', { method: 'POST', headers: headers(), body: JSON.stringify({ post_id: 'runtime-arch', content: body }) });
    assert.equal(posted.status, 201);
    const { comment } = await posted.json();
    assert.equal(comment.status, 'approved');
    assert.ok(!JSON.stringify(comment).includes('runtime-a@example.test'));
    const list = await (await api('/api/comments?post_id=runtime-arch')).json();
    assert.equal(list.comments[0].id, comment.id);
    assert.equal(list.comments[0].body, body);
  });

  await context.test('OAuth state cookies are protected and expired bearer sessions are rejected and removed', async () => {
    const start = await api('/api/auth/github/start?returnTo=%2Fblog%2Farch');
    assert.equal(start.status, 302);
    assert.equal(new URL(start.headers.get('location')!).hostname, 'github.com');
    const cookies = start.headers.getSetCookie();
    assert.equal(cookies.length, 3);
    for (const cookie of cookies) {
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Secure/);
      assert.match(cookie, /SameSite=Lax/);
      assert.match(cookie, /Max-Age=600/);
    }
    const callback = await api('/api/auth/github/callback', { headers: { cookie: '__Secure-gh_return_to=%2Fblog%2Farch' } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `${ORIGIN}/blog/arch`);
    const cleared = callback.headers.getSetCookie();
    assert.equal(cleared.length, 3);
    assert.deepEqual(cleared.map(cookie => cookie.split('=')[0]).sort(), cookies.map(cookie => cookie.split('=')[0]).sort());
    assert.ok(cleared.every(cookie => cookie.includes('Max-Age=0')));
    const expired = 'runtime_expired_session_1234567890';
    await database.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, 1)')
      .bind(expired, 'email:runtime-a@example.test').run();
    assert.equal((await api('/api/me', { headers: headers(expired) })).status, 401);
    assert.equal(await database.prepare('SELECT id FROM sessions WHERE id = ?').bind(expired).first(), null);
    assert.equal((await api('/api/me', { headers: { cookie: `token=${TOKEN_A}` } })).status, 401);
  });

  let firstImage = '';
  await context.test('R2 upload/list/serve/delete uses persistent random directories and enforces cross-user ownership', async () => {
    const upload = async (token: string) => {
      const result = await api('/api/images?category=avatars&filename=runtime.png', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, body: PNG,
      });
      assert.equal(result.status, 201);
      return (await result.json()).key as string;
    };
    const concurrent = await Promise.all([upload(TOKEN_A), upload(TOKEN_A), upload(TOKEN_A)]);
    assert.equal(new Set(concurrent).size, 1);
    firstImage = concurrent[0];
    assert.match(firstImage, /^images\/u_[0-9a-f-]{36}\/avatars\/runtime\.png$/);
    const second = await upload(TOKEN_B);
    assert.notEqual(firstImage, second);
    const list = await (await api('/api/images', { headers: headers(TOKEN_B) })).json();
    assert.deepEqual(list.images.map((entry: { key: string }) => entry.key), [second]);
    const served = await api(`/api/images?key=${encodeURIComponent(firstImage)}`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);
    assert.equal((await api('/api/images', { method: 'DELETE', headers: headers(TOKEN_B), body: JSON.stringify({ key: firstImage }) })).status, 403);
    assert.equal((await api('/api/images', { method: 'DELETE', headers: headers(TOKEN_B), body: JSON.stringify({ key: second }) })).status, 200);
    assert.equal((await api(`/api/images?key=${encodeURIComponent(second)}`)).status, 404);
  });

  await context.test('real SQLite Durable Object serializes concurrent requests and enforces a shared limit', async () => {
    const namespace = await runtime!.getDurableObjectNamespace('RATE_LIMITER');
    const stub = namespace.get(namespace.idFromName('isolated-concurrency-acceptance'));
    // Warm the cold object, then use a long window with room for a busy CI runner.
    await stub.fetch('https://rate-limiter.internal/__runtime/state');
    const windowMs = 60_000;
    const remaining = windowMs - Date.now() % windowMs;
    if (remaining < 5000) await delay(remaining + 25);
    const consume = () => stub.fetch('https://rate-limiter.internal/consume', {
      method: 'POST', body: JSON.stringify({ route: 'runtime-probe', limit: 1, windowMs }),
    });
    const attempts = await Promise.all(Array.from({ length: 8 }, consume));
    assert.equal(attempts.filter(response => response.status === 200).length, 1);
    assert.equal(attempts.filter(response => response.status === 429).length, 7);
  });

  await context.test('workerd scheduled alarms automatically remove expired SQLite DO buckets', async () => {
    const namespace = await runtime!.getDurableObjectNamespace('RATE_LIMITER');
    const stub = namespace.get(namespace.idFromName('isolated-alarm-acceptance'));
    const consume = () => stub.fetch('https://rate-limiter.internal/consume', {
      method: 'POST', body: JSON.stringify({ route: 'runtime-probe', limit: 1, windowMs: 1000 }),
    });
    assert.equal((await consume()).status, 200);
    const probe = async () => (await stub.fetch('https://rate-limiter.internal/__runtime/state')).json();
    const active = await probe();
    if (active.alarm !== null) assert.ok(Object.keys(active.entries).some(key => key.startsWith('bucket:')));
    const deadline = Date.now() + 6000;
    const isClean = (state: { alarm: number | null; entries: Record<string, unknown> }) =>
      state.alarm === null && Object.keys(state.entries).length === 1 && state.entries.schema === 2;
    // A short window may already have elapsed while the probe response travelled.
    let cleaned = isClean(active);
    while (!cleaned && Date.now() < deadline) {
      await delay(100);
      const state = await probe();
      cleaned = isClean(state);
    }
    assert.ok(cleaned, 'workerd must execute alarm() and remove the expired bucket without a manual alarm call');
    assert.equal((await consume()).status, 200);
  });

  await context.test('new workerd process and rotated signing key preserve D1 identities, R2 files and namespace ownership', async () => {
    await runtime!.dispose();
    runtime = createRuntime('runtime-signing-key-rotated');
    await runtime.ready;
    const list = await (await api('/api/images', { headers: headers() })).json();
    assert.deepEqual(list.images.map((entry: { key: string }) => entry.key), [firstImage]);
    assert.equal((await api(`/api/images?key=${encodeURIComponent(firstImage)}`)).status, 200);
    assert.equal((await (await api('/api/views?post=runtime-arch')).json()).views, 1);
    const unauthorized = await api('/api/images', { method: 'DELETE', headers: headers(TOKEN_B), body: JSON.stringify({ key: firstImage }) });
    assert.equal(unauthorized.status, 403);
    const removed = await api('/api/images', { method: 'DELETE', headers: headers(), body: JSON.stringify({ key: firstImage }) });
    assert.equal(removed.status, 200);
    assert.equal((await api(`/api/images?key=${encodeURIComponent(firstImage)}`)).status, 404);
  });
  assert.deepEqual(blockedRequests, [], 'normal local acceptance must not attempt any external request');

  await context.test('an attempted OAuth exchange is intercepted locally instead of reaching GitHub', async () => {
    const start = await api('/api/auth/github/start?returnTo=%2Fblog%2Farch');
    const auth = new URL(start.headers.get('location')!);
    const cookies = start.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const callback = await api(`/api/auth/github/callback?state=${encodeURIComponent(auth.searchParams.get('state')!)}&code=local-test-code`, { headers: { cookie: cookies } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `${ORIGIN}/blog/arch`);
    assert.deepEqual(blockedRequests, ['github.com']);
  });
});
