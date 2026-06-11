export interface Env {
	DB: D1Database;
	IMAGES: R2Bucket;
	RATE_LIMITER: DurableObjectNamespace;
	RATE_LIMIT_KV: KVNamespace;
	MODERATION_KV: KVNamespace;
	AI: Ai;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	PUBLIC_ALLOWED_ORIGIN?: string;
	SESSION_TTL_SECONDS?: string;
	RESEND_API_KEY?: string;
	BASE_URL?: string;
	TURNSTILE_SECRET_KEY?: string;
	DEV?: boolean;
	ADMIN_EMAILS?: string;
}

export interface SessionRow {
	user_id: string;
	login: string;
	name: string | null;
	avatar_url: string | null;
	profile_url: string | null;
	expires_at: number;
}

export interface PostViewsRow {
	post_slug: string;
	views: number;
}

export const STATE_COOKIE = '__Secure-gh_state';
export const VERIFIER_COOKIE = '__Secure-gh_verifier';
export const RETURN_TO_COOKIE = '__Secure-gh_return_to';

export const OAUTH_COOKIE_TTL_SECONDS = 600;
export const RATE_LIMIT_PER_MIN = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const COMMENT_MAX_LENGTH = 2000;
export const COMMENT_MIN_LENGTH = 1;
export const POST_SLUG_MAX_LENGTH = 180;
export const COMMENT_DAILY_LIMIT = 30;
export const FRONTEND_URL = 'https://danarnoux.com';
