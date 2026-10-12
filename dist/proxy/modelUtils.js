"use strict";
/**
 * Centralized model capability detection.
 * Replaces ~9 duplicate regex blocks across proxy.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectModelCapabilities = detectModelCapabilities;
exports.detectModelCapabilitiesByName = detectModelCapabilitiesByName;
// ─── Detection ────────────────────────────────────────────────────────────
const THINKING_PATTERN = /thinking|reasoning|reasoner|o1|o3|r1|opus-4|sonnet-4|claude-4|3-7|4-7|3\.7|4\.7/i;
const DEEPSEEK_PATTERN = /deepseek/i;
const CLAUDE_PATTERN = /claude|opus|sonnet/i;
const CLAUDE_THINKING_PATTERN = /opus-4|sonnet-4|claude-4|claude-3-5|claude-3-7/i;
const THINKING_MODEL_PATTERN = /opus-4|sonnet-4|claude-4/i;
const IMAGE_SUPPORT_PATTERN = /gpt-4o|gpt-4-turbo|claude|gemini|vision|llava|qwenvl|pixtral|yi-vision|cogvlm|kimi|moonshot/i;
// Positive family matches avoid excluding vision models just because their name
// also contains a provider's text-only model family (for example DeepSeek-VL2).
const DEEPSEEK_IMAGE_PATTERN = /(?:^|[\s/])(?:deepseek[-_ ]?vl2?|janus(?:[-_ ]?pro)?|deepseek-flash|deepseek-v4\.1-flash)(?=$|[-_:/\s])/i;
/**
 * Detects model capabilities from a custom model config object.
 */
function detectModelCapabilities(m, includeDisplayName = true) {
    const nameLower = (m.name || '').toLowerCase();
    const extLower = (m.externalModelName || '').toLowerCase();
    const displayLower = includeDisplayName ? (m.displayName || '').toLowerCase() : '';
    const isThinking = m.supportsThinking ??
        (m.provider === 'anthropic' ||
            m.provider === 'openai' ||
            m.provider === 'openrouter' ||
            THINKING_PATTERN.test(nameLower) ||
            THINKING_PATTERN.test(extLower) ||
            (includeDisplayName && THINKING_PATTERN.test(displayLower)));
    const isDeepSeek = DEEPSEEK_PATTERN.test(nameLower) ||
        DEEPSEEK_PATTERN.test(extLower) ||
        (includeDisplayName && DEEPSEEK_PATTERN.test(displayLower));
    const isClaude = m.provider === 'anthropic' || CLAUDE_PATTERN.test(nameLower) || CLAUDE_PATTERN.test(extLower);
    const maxTokens = m.contextWindow ?? (isClaude ? 200000 : 1048576);
    const maxOutputTokens = m.maxOutputTokens ?? (isDeepSeek ? 32768 : isThinking ? 32768 : 16384);
    // Explicit configuration (including imported provider metadata) wins over
    // provider/name fallbacks, in both directions. Unknown models remain text-only.
    const allNames = nameLower + ' ' + extLower + ' ' + displayLower;
    const supportsImages = m.supportsVision ??
        (m.provider === 'anthropic' ||
            m.provider === 'google' ||
            IMAGE_SUPPORT_PATTERN.test(allNames) ||
            DEEPSEEK_IMAGE_PATTERN.test(allNames));
    return { isThinking, isDeepSeek, isClaude, maxTokens, maxOutputTokens, supportsImages };
}
/**
 * Simplified detection for Gemini↔Anthropic translation (checks modelName string only).
 */
function detectModelCapabilitiesByName(modelName) {
    const lower = (modelName || '').toLowerCase();
    return {
        isClaudeThinkingModel: CLAUDE_THINKING_PATTERN.test(lower),
        isThinkingModel: THINKING_MODEL_PATTERN.test(lower),
    };
}
//# sourceMappingURL=modelUtils.js.map