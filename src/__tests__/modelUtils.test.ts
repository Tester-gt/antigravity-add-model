import { describe, it, expect } from 'vitest';
import { detectModelCapabilities, detectModelCapabilitiesByName } from '../proxy/modelUtils';

describe('detectModelCapabilities', () => {
  it('detects thinking for anthropic provider', () => {
    const result = detectModelCapabilities({ name: 'claude-3-5-sonnet', provider: 'anthropic' });
    expect(result.isThinking).toBe(true);
    expect(result.isClaude).toBe(true);
    expect(result.maxTokens).toBe(200_000);
    expect(result.maxOutputTokens).toBe(32_768);
  });

  it.each([
    'deepseek-vl-7b-chat',
    'deepseek-ai/deepseek-vl2',
    'deepseek-ai/deepseek-vl2-small',
    'deepseek-ai/Janus-1.3B',
    'deepseek-ai/Janus-Pro-7B',
    'janus:7b',
    'deepseek-flash',
    'DeepSeek-V4.1-Flash',
    'deepseek-v4-flash-vision-exp',
  ])('recognizes the multimodal model %s across provider formats', (name) => {
    for (const provider of ['deepseek', 'custom', 'ollama', 'openrouter', 'openai']) {
      expect(detectModelCapabilities({ name, provider }).supportsImages).toBe(true);
    }
  });

  it.each(['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'deepseek-v3', 'deepseek-v4-pro', 'janusaurus'])(
    'does not enable images for text-only or unknown model %s',
    (name) => {
      expect(detectModelCapabilities({ name, provider: 'deepseek' }).supportsImages).toBe(false);
    },
  );

  it('honors explicit image capabilities over every provider and model-name fallback', () => {
    for (const provider of ['google', 'anthropic', 'deepseek', 'custom', 'ollama', 'openrouter', 'openai']) {
      expect(detectModelCapabilities({ name: 'deepseek-r1', provider, supportsVision: true }).supportsImages).toBe(
        true,
      );
      expect(detectModelCapabilities({ name: 'deepseek-vl2', provider, supportsVision: false }).supportsImages).toBe(
        false,
      );
    }
  });

  it('recognizes image support from external and optional display names', () => {
    expect(
      detectModelCapabilities({ name: 'alias', externalModelName: 'deepseek-vl2', provider: 'custom' }).supportsImages,
    ).toBe(true);
    const alias = { name: 'alias', displayName: 'Janus-Pro-7B', provider: 'custom' };
    expect(detectModelCapabilities(alias).supportsImages).toBe(true);
    expect(detectModelCapabilities(alias, false).supportsImages).toBe(false);
  });

  it('detects thinking for openai provider', () => {
    const result = detectModelCapabilities({ name: 'gpt-4o', provider: 'openai' });
    expect(result.isThinking).toBe(true);
    expect(result.isClaude).toBe(false);
  });

  it('detects thinking for openrouter provider', () => {
    const result = detectModelCapabilities({ name: 'openai/gpt-4o', provider: 'openrouter' });
    expect(result.isThinking).toBe(true);
    expect(result.isClaude).toBe(false);
    expect(result.maxTokens).toBe(1_048_576);
  });

  it('detects thinking by name pattern', () => {
    const result = detectModelCapabilities({
      name: 'deepseek-r1',
      provider: 'ollama',
      externalModelName: 'deepseek-r1',
    });
    expect(result.isThinking).toBe(true);
    expect(result.isDeepSeek).toBe(true);
    expect(result.maxOutputTokens).toBe(32_768);
  });

  it('detects o1/o3 style reasoning models', () => {
    const result = detectModelCapabilities({ name: 'o1-preview', provider: 'openai' });
    expect(result.isThinking).toBe(true);
  });

  it('detects opus-4 / sonnet-4 as thinking', () => {
    const result = detectModelCapabilities({ name: 'claude-sonnet-4', provider: 'anthropic' });
    expect(result.isThinking).toBe(true);
  });

  it('detects non-thinking ollama model', () => {
    const result = detectModelCapabilities({ name: 'llama3', provider: 'ollama' });
    expect(result.isThinking).toBe(false);
    expect(result.isDeepSeek).toBe(false);
    expect(result.isClaude).toBe(false);
    expect(result.maxTokens).toBe(1_048_576);
    expect(result.maxOutputTokens).toBe(16_384);
  });

  it('honors explicit thinking capabilities over provider and alias heuristics', () => {
    for (const provider of ['google', 'anthropic', 'openai', 'openrouter']) {
      expect(
        detectModelCapabilities({
          name: 'models/reasoning-alias',
          provider,
          supportsThinking: false,
        }).isThinking,
      ).toBe(false);
    }
    expect(
      detectModelCapabilities({
        name: 'models/plain-alias',
        provider: 'google',
        supportsThinking: true,
      }).isThinking,
    ).toBe(true);
  });

  it('detects anthropic models as claude regardless of name', () => {
    const result = detectModelCapabilities({ name: 'some-unknown-model', provider: 'anthropic' });
    expect(result.isClaude).toBe(true);
  });

  it('detects claude by name pattern', () => {
    const result = detectModelCapabilities({ name: 'claude-haiku', provider: 'custom' });
    expect(result.isClaude).toBe(true);
  });

  it('detects deepseek by name', () => {
    const result = detectModelCapabilities({ name: 'deepseek-v3', provider: 'custom' });
    expect(result.isDeepSeek).toBe(true);
    expect(result.maxOutputTokens).toBe(32_768);
  });

  it('uses displayName for detection when includeDisplayName=true', () => {
    const result = detectModelCapabilities(
      { name: 'models/my-model', provider: 'ollama', displayName: 'DeepSeek R1 - Reasoning' },
      true,
    );
    expect(result.isDeepSeek).toBe(true);
    expect(result.isThinking).toBe(true);
  });

  it('skips displayName when includeDisplayName=false', () => {
    const result = detectModelCapabilities(
      { name: 'models/my-model', provider: 'ollama', displayName: 'DeepSeek R1 - Reasoning' },
      false,
    );
    expect(result.isDeepSeek).toBe(false);
  });

  it('detects by externalModelName', () => {
    const result = detectModelCapabilities({
      name: 'custom-model',
      provider: 'openrouter',
      externalModelName: 'anthropic/claude-3.5-sonnet',
    });
    expect(result.isClaude).toBe(true);
  });
});

describe('detectModelCapabilitiesByName', () => {
  it('detects claude thinking models', () => {
    const result = detectModelCapabilitiesByName('claude-3-5-sonnet');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(false);
  });

  it('detects claude 4 models as thinking', () => {
    const result = detectModelCapabilitiesByName('claude-sonnet-4-20250514');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(true);
  });

  it('detects opus-4 as thinking', () => {
    const result = detectModelCapabilitiesByName('claude-opus-4');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(true);
  });

  it('returns false for non-claude models', () => {
    const result = detectModelCapabilitiesByName('gpt-4o');
    expect(result.isClaudeThinkingModel).toBe(false);
    expect(result.isThinkingModel).toBe(false);
  });

  it('handles claude-3-7 models', () => {
    const result = detectModelCapabilitiesByName('claude-3-7-sonnet');
    expect(result.isClaudeThinkingModel).toBe(true);
    expect(result.isThinkingModel).toBe(false);
  });

  it('handles empty/null input gracefully', () => {
    const result = detectModelCapabilitiesByName('');
    expect(result.isClaudeThinkingModel).toBe(false);
    expect(result.isThinkingModel).toBe(false);
  });
});
