// language: JavaScript (ESM), file: src/imagegen.mjs, runtime: Node >= 20 (DSH host)
// Built-in image generation for the harness: the same private "imageGen" model the
// Antigravity IDE uses (`imageGenerationModelIds` → gemini-3.1-flash-image), called with
// responseModalities ["TEXT","IMAGE"] + imageConfig, exactly as the IDE does.
//
// Two endpoint traps are handled here:
//   - a refused generation is HTTP 200 with empty content and a `finishMessage`;
//   - a successful generation returns an inlineData part (image/jpeg).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AntigravityError, ERROR_CODES, httpError, transportError } from './errors.mjs';

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const DEFAULT_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];

/** Resolve the image model id this account advertises (falls back to the known id). */
export async function resolveImageModel(adapter, features) {
  if (features.imageModel) return features.imageModel;
  try {
    const catalogue = await adapter.loadCatalogue();
    const ids = Object.keys(catalogue.imageModels || {});
    if (ids.length > 0) return ids[0];
  } catch { /* fall through to the known id */ }
  return DEFAULT_IMAGE_MODEL;
}

/**
 * Create the image generator: one call = one image (candidateCount > 1 is rejected by the
 * endpoint, so `count` is implemented as sequential calls).
 */
export function createImageGenerator({ client, adapter, config, log, throttle }) {
  const features = config.features || {};
  const mediaDir = features.mediaOutputDir || path.join(os.tmpdir(), 'dsh-antigravity-media');
  const aspectRatios = features.imageAspectRatios || DEFAULT_ASPECT_RATIOS;

  /** Read an existing image for image-to-image editing, with size and type guards. */
  function readReference(referencePath) {
    const file = path.resolve(String(referencePath));
    const extension = path.extname(file).toLowerCase();
    const mimeType = extension === '.png' ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.webp' ? 'image/webp' : null;
    if (!mimeType) {
      throw new AntigravityError('reference_path must be a .png, .jpg/.jpeg or .webp image', ERROR_CODES.INVALID_REQUEST);
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new AntigravityError('reference_path does not exist: ' + file, ERROR_CODES.INVALID_REQUEST);
    }
    if (!stat.isFile()) throw new AntigravityError('reference_path is not a file: ' + file, ERROR_CODES.INVALID_REQUEST);
    if (stat.size > 20 * 1024 * 1024) {
      throw new AntigravityError('reference image is larger than 20 MiB', ERROR_CODES.INVALID_REQUEST);
    }
    return { inlineData: { mimeType, data: fs.readFileSync(file).toString('base64') } };
  }

  async function generateOne({ prompt, aspectRatio, model, signal, reference }) {
    const parts = [];
    if (reference) parts.push(reference);
    parts.push({ text: prompt });
    const request = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: features.imageMaxOutputTokens || 4096,
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio },
      },
    };
    let response;
    try {
      // Tool sub-calls are not covered by dsh-llm-retry: a couple of retries help with the
      // transient 429/503 answers the endpoint gives under load.
      const send = () => client.openStream({ model, request, signal, retries: 2 });
      response = throttle ? await throttle.run(send, signal) : await send();
    } catch (error) {
      throw error instanceof AntigravityError ? error : transportError(error, signal);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw httpError(response.status, body, response.headers);
    }

    let finishMessage = '';
    let text = '';
    let image = null;
    for await (const event of client.streamEvents(response.body)) {
      if (signal && signal.aborted) {
        throw new AntigravityError('image generation aborted', ERROR_CODES.ABORTED);
      }
      if (event.type === 'media') {
        const part = event.part || {};
        const inline = part.inlineData || part.fileData;
        if (inline && inline.data) {
          image = { mimeType: String(inline.mimeType || 'image/jpeg'), data: inline.data };
        }
      } else if (event.type === 'text') {
        text += event.text;
      } else if (event.type === 'finishMessage') {
        finishMessage = event.message;
      }
    }
    if (!image) {
      throw new AntigravityError(
        finishMessage || 'the image model returned no image for this prompt; rephrase it and retry',
        ERROR_CODES.EMPTY_RESPONSE,
      );
    }
    const extension = image.mimeType.split('/')[1]?.split(';')[0] || 'jpeg';
    const file = path.join(mediaDir, 'ag-' + crypto.randomBytes(8).toString('hex') + '.' + extension);
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    log('generated ' + image.mimeType + ' ' + file + ' (' + fs.statSync(file).size + ' bytes)');
    return { file, mimeType: image.mimeType, bytes: fs.statSync(file).size, text: text.trim() };
  }

  return {
    aspectRatios,
    /** Generate 1..4 images for one prompt; `referencePath` turns it into an edit. */
    async generate({ prompt, aspectRatio, count = 1, referencePath, signal }) {
      const text = String(prompt || '').trim();
      if (!text) throw new AntigravityError('image prompt must not be empty', ERROR_CODES.INVALID_REQUEST);
      const ratio = aspectRatio || features.imageAspectRatio || '1:1';
      if (!aspectRatios.includes(ratio)) {
        throw new AntigravityError('unsupported aspect ratio "' + ratio + '" (use ' + aspectRatios.join(', ') + ')', ERROR_CODES.INVALID_REQUEST);
      }
      const total = Math.max(1, Math.min(4, Number(count) || 1));
      const model = await resolveImageModel(adapter, features);
      const reference = referencePath ? readReference(referencePath) : undefined;
      const images = [];
      const notes = [];
      for (let index = 0; index < total; index++) {
        if (signal && signal.aborted) throw new AntigravityError('image generation aborted', ERROR_CODES.ABORTED);
        const result = await generateOne({ prompt: text, aspectRatio: ratio, model, signal, reference });
        images.push({ path: result.file, mimeType: result.mimeType, bytes: result.bytes, aspectRatio: ratio });
        if (result.text) notes.push(result.text);
      }
      return { images, text: notes.join('\n').trim(), model };
    },
  };
}

/** Markdown reference for one saved image (the chat UI renders absolute paths). */
export function imageMarkdown(file) {
  return '![' + path.basename(file) + '](' + String(file).replace(/\\/g, '/') + ')';
}
