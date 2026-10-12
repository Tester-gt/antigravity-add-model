import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mapGeminiToOpenAI } from '../proxy/translators/openai';
import { mapGeminiToAnthropic } from '../proxy/translators/anthropic';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// A real one-pixel PNG, including non-UTF-8 bytes in its header and compressed data.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const inlineImage = { inlineData: { mimeType: 'image/png', data: PNG } };
const imageUrl = 'https://example.com/screenshot.png?version=2';
type GeminiRequest = Parameters<typeof mapGeminiToOpenAI>[0];
let fixtureDirectory: string;
let localImageUri: string;
let localTextUri: string;
let emptyImageUri: string;

beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'antigravity-image-inputs-'));
  const imagePath = join(fixtureDirectory, 'screenshot # ü.png');
  const textPath = join(fixtureDirectory, 'notes # ü.txt');
  const emptyPath = join(fixtureDirectory, 'empty.png');
  writeFileSync(imagePath, Buffer.from(PNG, 'base64'));
  writeFileSync(textPath, 'A normal text attachment.');
  writeFileSync(emptyPath, Buffer.alloc(0));
  localImageUri = pathToFileURL(imagePath).href;
  localTextUri = pathToFileURL(textPath).href;
  emptyImageUri = pathToFileURL(emptyPath).href;
});

afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

describe.each(['openai', 'anthropic'] as const)('%s image request translation', (format) => {
  const translate = (body: GeminiRequest) =>
    format === 'openai' ? mapGeminiToOpenAI(body, 'deepseek-flash') : mapGeminiToAnthropic(body, 'deepseek-flash');
  const expectedInline = (data = PNG, mimeType = 'image/png') =>
    format === 'openai'
      ? { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
  const expectedUrl = (url = imageUrl) =>
    format === 'openai' ? { type: 'image_url', image_url: { url } } : { type: 'image', source: { type: 'url', url } };

  it('preserves ordered text and multiple images, including images in earlier user turns', () => {
    const body: GeminiRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'First image:' },
            inlineImage,
            { text: 'Second image:' },
            { fileData: { mimeType: 'image/png', fileUri: imageUrl } },
          ],
        },
        { role: 'model', parts: [{ text: 'I can see both images.' }] },
        { role: 'user', parts: [{ text: 'Compare them.' }] },
      ],
    };
    const original = structuredClone(body);
    const result = translate(body);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'First image:' },
        expectedInline(),
        { type: 'text', text: 'Second image:' },
        expectedUrl(),
      ],
    });
    expect(result.messages[1]).toMatchObject({ role: 'assistant', content: 'I can see both images.' });
    expect(result.messages[2]).toEqual({ role: 'user', content: 'Compare them.' });
    expect(body).toEqual(original);
  });

  it('supports an image-only message without adding a textual placeholder', () => {
    expect(translate({ contents: [{ role: 'user', parts: [inlineImage] }] }).messages[0].content).toEqual([
      expectedInline(),
    ]);
  });

  it('reads file URLs as binary with correctly decoded spaces, Unicode, and reserved characters', () => {
    expect(
      translate({
        contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: localImageUri } }] }],
      }).messages[0].content,
    ).toEqual([expectedInline()]);
  });

  it.each([
    ['image/png', 'file://untrusted-host/share/image.png'],
    ['image/png', 'file:////untrusted-host/share/image.png'],
    ['text/plain', 'file://untrusted-host/share/notes.txt'],
    ['text/plain', 'file:////untrusted-host/share/notes.txt'],
  ])('rejects remote file attachments before filesystem I/O (%s, %s)', (mimeType, fileUri) => {
    const read = vi.mocked(fs.readFileSync);
    const originalRead = read.getMockImplementation()!;
    read.mockClear().mockImplementation(() => {
      throw new Error('Unexpected filesystem I/O');
    });
    try {
      expect(() => translate({ contents: [{ role: 'user', parts: [{ fileData: { mimeType, fileUri } }] }] })).toThrow(
        'Only local file URLs are supported; network shares are not allowed.',
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockImplementation(originalRead);
    }
  });

  it('accepts the localhost authority for a genuinely local file', () => {
    const localhostUri = localImageUri.replace(/^file:\/\//, 'file://localhost');
    expect(
      translate({
        contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: localhostUri } }] }],
      }).messages[0].content,
    ).toEqual([expectedInline()]);
  });

  it('preserves the existing text-file attachment format', () => {
    const content = translate({
      contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'text/plain', fileUri: localTextUri } }] }],
    }).messages[0].content;
    expect(content).toBe(
      format === 'openai'
        ? `[File content from ${localTextUri}]:\nA normal text attachment.`
        : '[File:\nA normal text attachment.\n]',
    );
  });

  it.each(['http://127.0.0.1:1/unreachable.png', imageUrl])(
    'passes through remote image URLs without fetching %s',
    (url) => {
      expect(
        translate({ contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: url } }] }] })
          .messages[0].content,
      ).toEqual([expectedUrl(url)]);
    },
  );

  it('normalizes MIME casing and whitespace in base64 inputs', () => {
    expect(
      translate({
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'IMAGE/PNG', data: `${PNG.slice(0, 20)}\n${PNG.slice(20)}` } }],
          },
        ],
      }).messages[0].content,
    ).toEqual([expectedInline()]);
  });

  it.each([undefined, 'image/png'])(
    'normalizes image data URLs to native image inputs (declared MIME: %s)',
    (mimeType) => {
      expect(
        translate({
          contents: [{ role: 'user', parts: [{ fileData: { mimeType, fileUri: `data:image/png;base64,${PNG}` } }] }],
        }).messages[0].content,
      ).toEqual([expectedInline()]);
    },
  );

  it('rejects malformed data URLs without echoing embedded image data', () => {
    expect(() =>
      translate({
        contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'data:image/png,private-image-data' } }] }],
      }),
    ).toThrow('Invalid image data URL. Use a base64-encoded JPEG, PNG, GIF, or WebP image.');
  });

  it('rejects conflicting data-URL and declared image formats', () => {
    expect(() =>
      translate({
        contents: [
          { role: 'user', parts: [{ fileData: { mimeType: 'image/jpeg', fileUri: `data:image/png;base64,${PNG}` } }] },
        ],
      }),
    ).toThrow('Invalid image input: the declared format does not match the image data URL.');
  });

  it.each([false, true])('keeps images alongside tool results after all parallel results (split: %s)', (split) => {
    const results = [
      { functionResponse: { name: 'screenshot', id: 'shot-2', response: { ok: true } } },
      { text: 'Screenshot 2:' },
      inlineImage,
      { functionResponse: { name: 'screenshot', id: 'shot-1', response: { ok: true } } },
      { text: 'Screenshot 1:' },
      { fileData: { mimeType: 'image/png', fileUri: imageUrl } },
    ];
    const body: GeminiRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'screenshot', id: 'shot-1', args: {} } },
            { functionCall: { name: 'screenshot', id: 'shot-2', args: {} } },
          ],
        },
        ...(split
          ? [
              { role: 'user', parts: results.slice(0, 3) },
              { role: 'user', parts: results.slice(3) },
            ]
          : [{ role: 'user', parts: results }]),
        { role: 'model', parts: [{ text: 'Both screenshots received.' }] },
      ],
    };
    const messages = translate(body).messages;
    const companionContent = [
      { type: 'text', text: 'Screenshot 2:' },
      expectedInline(),
      { type: 'text', text: 'Screenshot 1:' },
      expectedUrl(),
    ];
    if (format === 'openai') {
      expect(messages.slice(1, 4)).toEqual([
        { role: 'tool', tool_call_id: 'shot-2', content: '{"ok":true}' },
        { role: 'tool', tool_call_id: 'shot-1', content: '{"ok":true}' },
        { role: 'user', content: companionContent },
      ]);
    } else {
      expect(messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'shot-2', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'shot-1', content: '{"ok":true}' },
          ...companionContent,
        ],
      });
    }
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Both screenshots received.' });
  });

  it.each(['model', 'assistant', 'system', 'tool'])(
    'rejects images in unsupported %s roles instead of dropping them',
    (role) => {
      expect(() => translate({ contents: [{ role, parts: [inlineImage] }] })).toThrow(
        'Image inputs are only supported in user messages.',
      );
    },
  );

  it('rejects system-instruction images instead of dropping them', () => {
    expect(() => translate({ systemInstruction: { parts: [inlineImage] }, contents: [] })).toThrow(
      'Image inputs are only supported in user messages.',
    );
  });

  it('rejects images alongside assistant tool calls instead of silently losing them', () => {
    expect(() =>
      translate({
        contents: [
          { role: 'model', parts: [inlineImage, { functionCall: { name: 'screenshot', id: 'shot-1', args: {} } }] },
        ],
      }),
    ).toThrow('Image inputs are only supported in user messages.');
  });

  it.each(['', 'private-image-data!', 'a', 'YWJj='])('rejects malformed base64 with a sanitized error', (data) => {
    expect(() =>
      translate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] }] }),
    ).toThrow('Invalid image input: expected base64 image data.');
  });

  it('rejects unsupported image formats without echoing image data', () => {
    expect(() =>
      translate({
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'image/svg+xml', data: 'private-svg-content' } }] },
        ],
      }),
    ).toThrow('Unsupported image format. Use JPEG, PNG, GIF, or WebP.');
  });

  it.each([
    ['private-invalid-url', 'Invalid image URL. Use a file, HTTP, or HTTPS URL.'],
    ['gs://private-bucket/private-image.png', 'Unsupported image URL. Use a file, HTTP, or HTTPS URL.'],
    ['https://user:private-password@example.com/private.png', 'Image URLs must not contain embedded credentials.'],
  ])('rejects unsupported or malformed URLs with a sanitized error (%s)', (fileUri, error) => {
    expect(() =>
      translate({ contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri } }] }] }),
    ).toThrow(error);
  });

  it('does not expose a missing local file path in errors', () => {
    const fileUri = pathToFileURL(join(fixtureDirectory, 'private-missing-file.png')).href;
    expect(() =>
      translate({ contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri } }] }] }),
    ).toThrow('Unable to read the local image file. Check that it exists and is readable.');
  });

  it('rejects empty local image files', () => {
    expect(() =>
      translate({
        contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: emptyImageUri } }] }],
      }),
    ).toThrow('Invalid image input: the local image file is empty.');
  });
});
