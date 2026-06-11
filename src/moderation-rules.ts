/**
 * Content Moderation Rules
 * Separate file for easy rule management
 */

export type ModerationResult = 'ALLOW' | 'REVIEW' | 'REJECT';

// ============================================
// Technical Attack Patterns (Rule-based)
// Only blocks clear attack patterns, not normal words
// ============================================

// SQL injection - only block clear attack patterns, not normal words like "select"
export const SQL_INJECTION_PATTERNS = [
	/;\s*(drop|delete|update|insert|alter|create|truncate)/i,
	/(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,  // or 1=1, and 1=1
	/union\s+(all\s+)?select/i,
	/--\s*$/m,
	/;\s*$/m,
	/\bexec\s*\(/i,
	/\bexecute\s*\(/i,
	/\bxpa_/i,
	/\bsp_/i,
];

// XSS patterns - block HTML/JS injection tags, not normal words
export const XSS_PATTERNS = [
	/<script/i,
	/javascript:/i,
	/on\w+\s*=/i,          // onerror=, onclick=, onload=, etc.
	/<iframe/i,
	/<object/i,
	/<embed/i,
	/<svg/i,
	/data:/i,              // data: URL with content
	/vbscript:/i,
];

// ============================================
// English Vulgar Abbreviations (Rule-based)
// ============================================

export const VULGAR_ABBREVIATIONS = [
	/\bkys\b/i,
	/\bstfu\b/i,
	/\bf+u+c+k+\b/i,
	/\bb+i+t+c+h\b/i,
	/\bass\b(?!ess|ign|ume|ert|ist|ociat|embl)/i,
	/\bd+i+c+k\b/i,
	/\bp+u+s+s+y\b/i,
	/\bn+i+g+g+e+r\b/i,
	/\bfml\b/i,
	/\bgtfo\b/i,
];

// ============================================
// Chinese Profanity Patterns (Rule-based)
// ============================================

export const CHINESE_PROFANITY_PATTERNS = [
	/他妈[的]|t[mM][aA][mM][aA]/gi,                          // 他妈的
	/[傻逼破鞋]|[屄婊子]/gi,                                  // 傻逼/屄/婊子/破鞋
	/滚[你妈]|去死/g,                                        // 滚你妈/去死
	/我[操草艹]|woc|wocao/gi,                                // 卧槽等感叹
	/[尼玛的]|n[iI][mM][aA]/gi,                              // 尼玛(的)
	/王八蛋/g,                                              // 王八蛋
	/狗日(g?:的?|了)/g,                                      // 狗日的
	/[废物垃圾]/g,                                          // 废物/垃圾 (when used as insult)
	/[脑残智障弱智]/g,                                       // 脑残/智障/弱智
	/[麻痹嘣]/g,                                             // 麻痹/嘣
	/畜生/g,                                                 // 畜生
	/人渣/g,                                                 // 人渣
];

// ============================================
// AI Moderation (handled by callAI)
// ============================================
// The AI layer handles semantic analysis beyond these rules

// Content length limits (apply to all content)
export const MAX_CONTENT_LENGTH = 5000;
export const MAX_REPEAT_CHARS = 10;

/**
 * Technical attack detection - Layer 1 of moderation
 * Returns ALLOW if content passes all checks
 */
export function ruleFilter(content: string): { result: ModerationResult; reason?: string } {
	// Check for SQL injection
	for (const pattern of SQL_INJECTION_PATTERNS) {
		if (pattern.test(content)) {
			return { result: 'REJECT', reason: 'Invalid input pattern detected' };
		}
	}

	// Check for XSS
	for (const pattern of XSS_PATTERNS) {
		if (pattern.test(content)) {
			return { result: 'REJECT', reason: 'Invalid input pattern detected' };
		}
	}

	// Check for English vulgar abbreviations
	for (const pattern of VULGAR_ABBREVIATIONS) {
		if (pattern.test(content)) {
			return { result: 'REJECT', reason: 'Content contains inappropriate language' };
		}
	}

	// Check for Chinese profanity
	for (const pattern of CHINESE_PROFANITY_PATTERNS) {
		if (pattern.test(content)) {
			return { result: 'REJECT', reason: 'Content contains inappropriate language' };
		}
	}

	// Check for excessive length
	if (content.length > MAX_CONTENT_LENGTH) {
		return { result: 'REJECT', reason: 'Content exceeds maximum length' };
	}

	// Check for repetitive characters (spam indicator)
	if (new RegExp(`(.)\\1{${MAX_REPEAT_CHARS},}`).test(content)) {
		return { result: 'REJECT', reason: 'Invalid content pattern detected' };
	}

	// Content passes technical checks - AI will handle semantic analysis
	return { result: 'ALLOW' };
}
