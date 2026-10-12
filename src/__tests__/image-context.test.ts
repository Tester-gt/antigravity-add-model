import { describe, expect, it } from 'vitest';
import { trimContext, type GeminiBody } from '../proxy/requestOptions';

describe('image context budgeting', () => {
  it.each(['inlineData', 'fileData'] as const)(
    'budgets %s images independently of base64 size and preserves bytes',
    (field) => {
      for (const size of [100, 1024 * 1024]) {
        const data = 'a'.repeat(size);
        const part =
          field === 'inlineData'
            ? { inlineData: { mimeType: 'image/png', data } }
            : { fileData: { mimeType: 'image/png', fileUri: `data:image/png;base64,${data}` } };
        const body: GeminiBody = { contents: [{ role: 'user', parts: [{ text: 'Describe this image.' }, part] }] };
        const snapshot = JSON.stringify(body);

        const result = trimContext(body, 4096, 1024);

        expect(result.contents).toEqual(body.contents);
        expect(result.contents?.[0].parts?.[1]).toEqual(part);
        expect(JSON.stringify(body)).toBe(snapshot);
      }
    },
  );

  it('recognizes data image URLs without relying on their declared MIME type', () => {
    const body: GeminiBody = {
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: `data:image/png;base64,${'a'.repeat(100_000)}` } }] }],
    };
    expect(trimContext(body, 6000).contents).toEqual(body.contents);
  });

  it('still reserves output tokens and rejects a latest image turn that exceeds the budget', () => {
    const body: GeminiBody = {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }],
    };
    expect(() => trimContext(body, 4096, 3072)).toThrow(/latest turn/);
  });

  it('drops an old image turn together with its tool exchange and leaves the input unchanged', () => {
    const body: GeminiBody = {
      contents: [
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'old-image' } }] },
        { role: 'model', parts: [{ functionCall: { name: 'inspect', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'inspect', response: { ok: true } } }] },
        { role: 'model', parts: [{ text: 'The old image shows a tree.' }] },
        {
          role: 'user',
          parts: [{ text: 'What about this image?' }, { inlineData: { mimeType: 'image/png', data: 'new-image' } }],
        },
      ],
    };
    const snapshot = structuredClone(body);

    expect(trimContext(body, 4096, 2200).contents).toEqual(body.contents?.slice(4));
    expect(body).toEqual(snapshot);
  });

  it.each([
    { contents: [{ role: 'user', parts: [{ text: 'x'.repeat(30_000) }] }] },
    {
      systemInstruction: { parts: [{ text: 'x'.repeat(30_000) }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    },
    { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'text/plain', data: 'x'.repeat(30_000) } }] }] },
    {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'inspect',
                args: { inlineData: { mimeType: 'image/png', data: 'x'.repeat(30_000) } },
              },
            },
          ],
        },
      ],
    },
  ])('does not exempt text, system instructions, non-image data or tool arguments from the budget', (body) => {
    expect(() => trimContext(body, 6000)).toThrow(/latest turn/);
  });
});
