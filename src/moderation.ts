import type { Env } from './types';
import { ruleFilter, type ModerationResult } from './moderation-rules';

export type { ModerationResult };

async function hashContent(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkCache(contentHash: string, env: Env): Promise<ModerationResult | null> {
	const cached = await env.MODERATION_KV.get(`mod:${contentHash}`);
	if (cached) return cached as ModerationResult;
	return null;
}

async function cacheResult(contentHash: string, result: ModerationResult, env: Env): Promise<void> {
	await env.MODERATION_KV.put(`mod:${contentHash}`, result, { expirationTtl: 86400 });
}

async function callAI(content: string, env: Env): Promise<ModerationResult> {
	try {
		const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			messages: [
				{
					role: 'system',
					content: `You are a content quality moderator for a personal blog. Evaluate the user message and respond with EXACTLY one word: ALLOW or REJECT.

ALLOW: All normal, friendly communication is allowed:
- Questions of any kind (technical, casual, curious)
- Positive feedback, praise, appreciation (even short phrases like "great post!", "谢谢", "很棒")
- Thoughtful comments, opinions, discussions
- Technical feedback, suggestions
- Short acknowledgments like "thanks", "赞", "好评"
- Normal English comments without harmful intent

REJECT: Reject any content containing:
- English vulgar abbreviations: "rm", "kys", "stfu", "f**k", "s**t", "bitch", "damn", "ass", "dick", "pussy", "fag", "nigger" etc. (even in lowercase or with symbols)
- Any form of harassment, insults, or verbal abuse (English or Chinese)
- Profanity or cursing words
- Implicit threats or hostile language
- Spam or advertisements

IMPORTANT: Even if a comment seems positive overall, if it contains English vulgar abbreviations or harassment words, REJECT it. "Good article! rm yourself!" should be REJECTED because of "rm".`,
				},
				{
					role: 'user',
					content: `Message to check:\n${content}`,
				},
			],
		});

		const response = (result as { response: string }).response;
		const text = (response || '').trim().toUpperCase();

		if (text === 'ALLOW' || text === 'REJECT') return text;
		if (text.includes('ALLOW')) return 'ALLOW';
		if (text.includes('REJECT')) return 'REJECT';
		return 'ALLOW';
	} catch (error) {
		console.error('AI moderation failed:', error);
		return 'ALLOW';
	}
}

export async function moderateContent(
	content: string,
	env: Env
): Promise<{ result: ModerationResult; reason?: string; cached?: boolean }> {
	const ruleResult = ruleFilter(content);
	if (ruleResult.result !== 'ALLOW') return ruleResult;

	const contentHash = await hashContent(content);
	const cachedResult = await checkCache(contentHash, env);
	if (cachedResult) return { result: cachedResult, cached: true };

	const aiResult = await callAI(content, env);
	await cacheResult(contentHash, aiResult, env);

	return { result: aiResult };
}

async function callAIForUsername(username: string, env: Env): Promise<ModerationResult> {
	try {
		const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			messages: [
				{
					role: 'system',
					content: `You are a username quality moderator for a personal blog. Evaluate the username and respond with EXACTLY one word: ALLOW or REJECT.

ALLOW: Any normal, acceptable username including:
- Simple names like "John", "Mike", "dandan", "小明", "测试"
- English or Chinese names
- Nicknames and aliases
- Any name that is not explicitly offensive

REJECT: Only reject usernames that are:
- Obviously offensive or vulgar ( slurs, curses)
- Spam or advertisement ( "buy now", "free money")
- Extremely long or nonsensical strings

IMPORTANT: Be very permissive with usernames. Short names like "dan", "test", "dandan" should be ALLOWED. Only reject clearly offensive content.`,
				},
				{
					role: 'user',
					content: `Username to check:\n${username}`,
				},
			],
		});

		const response = (result as { response: string }).response;
		const text = (response || '').trim().toUpperCase();

		if (text === 'ALLOW' || text === 'REJECT') return text;
		if (text.includes('ALLOW')) return 'ALLOW';
		if (text.includes('REJECT')) return 'REJECT';
		return 'ALLOW';
	} catch (error) {
		console.error('Username AI moderation failed:', error);
		return 'ALLOW';
	}
}

export async function moderateUsername(
	username: string,
	env: Env
): Promise<{ result: ModerationResult; reason?: string }> {
	const ruleResult = ruleFilter(username);
	if (ruleResult.result !== 'ALLOW') return ruleResult;

	const aiResult = await callAIForUsername(username, env);
	return { result: aiResult };
}
