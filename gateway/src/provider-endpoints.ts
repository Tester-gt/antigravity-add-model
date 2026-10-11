/** Preserve provider-specific prefixes such as /inference/v1 and /openai/v1. */
export function providerUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Provider URL must use HTTP(S) without embedded credentials');
  }
  url.hash = '';
  return url;
}

export function openAIEndpoint(baseUrl: string, endpoint: 'models' | 'chat/completions'): string {
  const url = providerUrl(baseUrl);
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
  if (!/\/v\d+(?:beta)?(?:\/|$)/.test(path)) path += '/v1';
  url.pathname = `${path}/${endpoint}`;
  return url.toString();
}

/** Workers AI needs a real account path; the catalog default is only a form placeholder. */
export function workersAIBaseUrl(baseUrl: string): URL {
  const url = providerUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1$/i.test(path)) {
    throw new Error('Set WORKERS_AI_BASE_URL to https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1 with your actual account ID.');
  }
  url.pathname = path;
  return url;
}
