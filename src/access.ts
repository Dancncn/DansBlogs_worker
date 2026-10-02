import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './types';
import { isAdminEmail } from './utils';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Trust only Access tokens signed for our configured team and application.
// The unsigned CF-Access-Authenticated-User-Email header is never an identity.
export async function verifiedAccessAdminEmail(request: Request, env: Env): Promise<string | null> {
	const domain = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https:\/\//, '').replace(/\/$/, '');
	const audience = env.ACCESS_AUD;
	const token = request.headers.get('Cf-Access-Jwt-Assertion');
	if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !audience || !token || token.length > 16_384) return null;
	try {
		const issuer = `https://${domain}`;
		let keys = keySets.get(domain);
		if (!keys) {
			keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
			keySets.set(domain, keys);
		}
		const { payload } = await jwtVerify(token, keys, {
			issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'email', 'iss', 'aud'],
		});
		return typeof payload.email === 'string' && isAdminEmail(payload.email, env) ? payload.email : null;
	} catch {
		return null;
	}
}
