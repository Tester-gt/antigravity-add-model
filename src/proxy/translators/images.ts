/** Image inputs shared by the OpenAI and Anthropic request translators. */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

export interface GeminiImagePart {
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
}

type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type ImageSource = { type: 'base64'; media_type: ImageMimeType; data: string } | { type: 'url'; url: string };

function isImageMimeType(mimeType: unknown): boolean {
  return typeof mimeType === 'string' && /^image\//i.test(mimeType.trim());
}

export function hasImagePart(part: GeminiImagePart): boolean {
  return (
    isImageMimeType(part.inlineData?.mimeType) ||
    isImageMimeType(part.fileData?.mimeType) ||
    isImageDataUrl(part.fileData?.fileUri)
  );
}

function isImageDataUrl(value: unknown): boolean {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

export function assertUserImageParts(parts: GeminiImagePart[], role: string): void {
  if (role !== 'user' && parts.some(hasImagePart)) {
    throw new Error('Image inputs are only supported in user messages.');
  }
}

function imageMimeType(value: unknown): ImageMimeType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'image/jpeg' ||
    normalized === 'image/png' ||
    normalized === 'image/gif' ||
    normalized === 'image/webp'
  ) {
    return normalized;
  }
  throw new Error('Unsupported image format. Use JPEG, PNG, GIF, or WebP.');
}

function imageBase64(data: unknown): string {
  if (typeof data !== 'string') throw new Error('Invalid image input: expected base64 image data.');
  const normalized = data.replace(/\s/g, '');
  if (
    !normalized ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1 ||
    (normalized.includes('=') && normalized.length % 4 !== 0)
  ) {
    throw new Error('Invalid image input: expected base64 image data.');
  }
  return normalized;
}

/** Converting a file URL must never turn an attachment into a remote SMB read. */
export function localFilePath(url: URL): string {
  const remoteFileError = 'Only local file URLs are supported; network shares are not allowed.';
  if (
    url.protocol !== 'file:' ||
    (url.hostname && url.hostname.toLowerCase() !== 'localhost') ||
    /^[\\/]{2}/.test(url.pathname)
  ) {
    throw new Error(remoteFileError);
  }
  let localPath: string;
  try {
    localPath = fileURLToPath(url);
  } catch {
    throw new Error('Invalid local attachment file URL.');
  }
  if (/^[\\/]{2}/.test(localPath)) throw new Error(remoteFileError);
  return localPath;
}

/** Never fetch remote URLs here; the selected provider resolves them. */
export function getImageSource(part: GeminiImagePart): ImageSource | undefined {
  if (isImageMimeType(part.inlineData?.mimeType)) {
    const inline = part.inlineData!;
    return { type: 'base64', media_type: imageMimeType(inline.mimeType), data: imageBase64(inline.data) };
  }
  if (!isImageMimeType(part.fileData?.mimeType) && !isImageDataUrl(part.fileData?.fileUri)) return undefined;
  const file = part.fileData!;
  if (isImageDataUrl(file.fileUri)) {
    const match = /^data:(image\/[^;,]+);base64,([\s\S]*)$/i.exec(file.fileUri);
    if (!match) throw new Error('Invalid image data URL. Use a base64-encoded JPEG, PNG, GIF, or WebP image.');
    const mediaType = imageMimeType(match[1]);
    if (file.mimeType && imageMimeType(file.mimeType) !== mediaType) {
      throw new Error('Invalid image input: the declared format does not match the image data URL.');
    }
    return { type: 'base64', media_type: mediaType, data: imageBase64(match[2]) };
  }
  const mediaType = imageMimeType(file.mimeType);
  let url: URL;
  try {
    url = new URL(file.fileUri);
  } catch {
    throw new Error('Invalid image URL. Use a file, HTTP, or HTTPS URL.');
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.username || url.password) throw new Error('Image URLs must not contain embedded credentials.');
    return { type: 'url', url: file.fileUri };
  }
  if (url.protocol !== 'file:') throw new Error('Unsupported image URL. Use a file, HTTP, or HTTPS URL.');
  const localPath = localFilePath(url);
  let data: Buffer;
  try {
    data = readFileSync(localPath);
  } catch {
    // Filesystem errors include local paths; expose only a safe, actionable message.
    throw new Error('Unable to read the local image file. Check that it exists and is readable.');
  }
  if (!data.length) throw new Error('Invalid image input: the local image file is empty.');
  return { type: 'base64', media_type: mediaType, data: data.toString('base64') };
}
