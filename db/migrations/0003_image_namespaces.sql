-- Additive, idempotent upgrade for existing databases. No user IDs or R2 keys
-- are rewritten. The application also lazily creates this table if necessary.
CREATE TABLE IF NOT EXISTS user_image_namespaces (
	user_id TEXT PRIMARY KEY NOT NULL,
	namespace TEXT NOT NULL UNIQUE,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
