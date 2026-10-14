import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CONVERSION_TIMEOUT_MS, MAX_UPLOAD_BYTES } from './config.js';
import { convertAudio, formats, isTarget } from './converter.js';
import { HttpError } from './errors.js';

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  maxUploadBytes?: number;
  conversionTimeoutMs?: number;
  maxConcurrentConversions?: number;
  tempRoot?: string;
  // Trusted program configuration; never taken from an HTTP request.
  ffmpegPath?: string;
}

export function buildApp(options: AppOptions = {}) {
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const timeoutMs = options.conversionTimeoutMs ?? CONVERSION_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrentConversions ?? 2;
  const active = new Set<AbortController>();
  const app = Fastify({ logger: options.logger ?? false, requestTimeout: 120_000 });

  void app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: maxUploadBytes + 1, files: 1, fields: 1, parts: 2, fieldSize: 16, fieldNameSize: 64, headerPairs: 100 },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      void reply.code(413).send({ error: 'Uploaded file exceeds the size limit.' });
    } else if (['FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'].includes(code)) {
      void reply.code(400).send({ error: 'Send one file and at most one target field.' });
    } else if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      void reply.code(error.statusCode).send({ error: 'Invalid request.' });
    } else {
      request.log.error({ err: error }, 'Request failed');
      void reply.code(500).send({ error: 'Unable to process the request.' });
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/convert', async (request, reply) => {
    if (!request.headers['content-type']) throw new HttpError(400, 'A file field is required.');
    if (!request.isMultipart()) throw new HttpError(415, 'Use multipart/form-data with a file field.');
    if (active.size >= maxConcurrent) {
      return reply.code(503).header('Retry-After', '1').send({ error: 'Conversion capacity is busy. Try again shortly.' });
    }

    const controller = new AbortController();
    active.add(controller);
    controller.signal.addEventListener('abort', () => {
      if (!request.raw.complete) request.raw.destroy();
    }, { once: true });
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableFinished) abort(); };
    request.raw.on('aborted', abort);
    reply.raw.on('close', close);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'audio-converter-'));
      if (controller.signal.aborted) throw new HttpError(400, 'Request was interrupted.');
      const input = join(directory, randomUUID());
      let hasFile = false;
      let target: unknown = 'm4a';
      let invalidField = false;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.file.destroyed) throw new HttpError(400, 'Invalid multipart upload.');
            if (part.fieldname !== 'file') {
              invalidField = true;
              for await (const chunk of part.file) void chunk;
              continue;
            }
            hasFile = true;
            await pipeline(part.file, createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
            if (part.file.truncated || (await stat(input)).size > maxUploadBytes) {
              throw new HttpError(413, 'Uploaded file exceeds the size limit.');
            }
          } else if (part.fieldname === 'target' && !part.valueTruncated && !part.fieldnameTruncated) {
            target = part.value;
          } else {
            invalidField = true;
          }
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // Retain structured plugin and OS errors, but classify parser failures
        // as bad requests without returning parser messages or file paths.
        if (error instanceof Error && ('errno' in error || ('code' in error && String(error.code).startsWith('FST_')))) throw error;
        throw new HttpError(400, 'Invalid multipart upload.');
      }
      if (invalidField) throw new HttpError(400, 'Send one file and an optional target of m4a, mp3, or wav.');
      if (!hasFile) throw new HttpError(400, 'A file field is required.');
      if (!isTarget(target)) throw new HttpError(400, 'Target must be m4a, mp3, or wav.');
      if ((await stat(input)).size === 0) throw new HttpError(400, 'Uploaded file is empty.');

      const output = join(directory, `${randomUUID()}.${target}`);
      await convertAudio({ input, output, target, timeoutMs, signal: controller.signal, ffmpegPath: options.ffmpegPath ?? 'ffmpeg' });
      const size = (await stat(output)).size;
      if (size === 0) throw new HttpError(422, 'The file could not be decoded or converted as audio.');
      reply.type(formats[target].contentType)
        .header('Content-Disposition', `attachment; filename="converted.${target}"`)
        .header('Content-Length', size)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff');
      // A thenable reply keeps the file until streaming finishes or fails.
      await reply.send(createReadStream(output, { signal: controller.signal }));
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
      try {
        if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      } finally {
        active.delete(controller);
      }
    }
  });

  app.addHook('preClose', async () => {
    for (const controller of active) controller.abort();
  });
  return app;
}
