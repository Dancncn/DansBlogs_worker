-- Complete schema snapshot for a NEW database. It already includes parent_id.
-- Do not apply the legacy 0002 migration after initializing from this snapshot.
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	github_id INTEGER UNIQUE,
	login TEXT NOT NULL,
	name TEXT,
	avatar_url TEXT,
	profile_url TEXT,
	email TEXT UNIQUE,
	email_verified INTEGER DEFAULT 0,
	is_admin INTEGER DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	ip TEXT,
	user_agent TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_image_namespaces (
	user_id TEXT PRIMARY KEY NOT NULL,
	namespace TEXT NOT NULL UNIQUE,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	post_slug TEXT NOT NULL,
	user_id TEXT NOT NULL,
	body TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE SET NULL,
	CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_comments_post_status_created_at
	ON comments(post_slug, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);

CREATE TABLE IF NOT EXISTS email_logins (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	token TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used INTEGER DEFAULT 0,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_logins_token ON email_logins(token);
CREATE INDEX IF NOT EXISTS idx_email_logins_email ON email_logins(email);

CREATE TABLE IF NOT EXISTS post_views (
	post_slug TEXT PRIMARY KEY,
	views INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
