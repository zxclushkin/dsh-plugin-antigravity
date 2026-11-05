// language: JavaScript (ESM), file: src/tool.mjs, runtime: Node >= 20 (DSH host)
// Registers the built-in `image_generate` tool with the harness tool registry, so any agent
// model (Gemini, Claude, GPT-OSS) can draw a picture mid-conversation — the same way the
// Antigravity IDE's agent uses its built-in image generation.
//
// The registry accepts a plain definition: { name, description, parameters, output:{schema,render},
// execute }. Schemas must stay inside the harness JSON-Schema subset
// (type/oneOf/properties/required/additionalProperties/items/enum/const + annotations).
import { imageMarkdown } from './imagegen.mjs';

export const IMAGE_TOOL_NAME = 'image_generate';

/** Tool definition for the harness registry. */
export function imageToolDefinition({ generator, config, log }) {
  const aspectRatios = generator.aspectRatios;
  return {
    name: IMAGE_TOOL_NAME,
    // One image takes ~10-30s; `count: 4` generates sequentially, so the registry default
    // tool timeout would be too small.
    timeoutMs: 300_000,
    description:
      'Generate or edit an image with the built-in image generation model (Google Antigravity '
      + 'imageGen) and save it as a file the user can see inline. Use it whenever the user asks '
      + 'for a picture, illustration, icon, diagram or photo, or asks to change an existing image '
      + '(pass its path as reference_path). It returns the saved absolute paths; refer to them in '
      + 'your final answer as markdown images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'What to draw (or how to change the reference image): subject, style, colors, composition.',
        },
        aspect_ratio: {
          type: 'string',
          enum: aspectRatios,
          description: 'Canvas aspect ratio; defaults to ' + (config.features?.imageAspectRatio || '1:1') + '.',
        },
        count: {
          type: 'integer',
          description: 'How many images to generate, 1 to 4 (default 1).',
        },
        reference_path: {
          type: 'string',
          description: 'Absolute path of an existing .png/.jpg/.jpeg/.webp image to edit (image-to-image).',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                mime_type: { type: 'string' },
                bytes: { type: 'integer' },
                attachment_id: { type: 'string' },
              },
              required: ['path'],
            },
          },
          text: { type: 'string' },
        },
        required: ['images'],
      },
      render(_args, value) {
        const blocks = [];
        const note = String(value.text || '').trim();
        if (note) blocks.push({ type: 'text', text: note });
        for (const image of value.images || []) {
          blocks.push({ type: 'text', text: imageMarkdown(image.path) });
        }
        const saved = (value.images || []).map((image) => image.path).join(', ');
        blocks.push({
          type: 'text',
          text: 'Saved image file' + (value.images.length > 1 ? 's' : '') + ': ' + saved
            + '\nUse these absolute paths in your answer.',
        });
        return blocks;
      },
    },
    async execute(args, exec) {
      log('image_generate: ' + JSON.stringify(args).slice(0, 200));
      const result = await generator.generate({
        prompt: args.prompt,
        aspectRatio: args.aspect_ratio,
        count: args.count,
        referencePath: args.reference_path,
        signal: exec && exec.signal,
      });
      return {
        images: result.images.map((image) => ({
          path: image.path,
          mime_type: image.mimeType,
          bytes: image.bytes,
          ...(image.attachmentId ? { attachment_id: image.attachmentId } : {}),
        })),
        ...(result.text ? { text: result.text } : {}),
      };
    },
  };
}

/** Register the image tool and return the registry disposer. */
export function registerImageTool(ctx, options) {
  return ctx.tools.register(imageToolDefinition(options));
}
