import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import { buildApp } from '../dist/app.js';
import { MAX_UPLOAD_BYTES } from '../dist/config.js';

let root;
let work;
let opus;
let wav;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'audio-converter-tests-'));
  work = join(root, 'requests');
  await mkdir(work);
  for (const [format, codec] of [['opus', 'libopus'], ['wav', 'pcm_s16le']]) {
    execFileSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=0.25',
      '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1',
      '-c:a', codec, '-y', join(root, `tone.${format}`),
    ]);
  }
  opus = await readFile(join(root, 'tone.opus'));
  wav = await readFile(join(root, 'tone.wav'));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail('Timed out waiting for cleanup or child-process state');
}

function appFor(t, options = {}) {
  const app = buildApp({ tempRoot: work, ...options });
  t.after(async () => {
    await app.close();
    await eventually(async () => (await readdir(work)).length === 0);
  });
  return app;
}

function multipart(parts) {
  const boundary = 'audio-test-' + randomUUID();
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`));
    if ('file' in part) {
      chunks.push(Buffer.from(`; filename="${part.filename ?? 'recording.opus'}"\r\nContent-Type: application/octet-stream\r\n\r\n`), part.file);
    } else {
      chunks.push(Buffer.from(`\r\n\r\n${part.value}`));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

function convert(app, parts) {
  return app.inject({ method: 'POST', url: '/convert', ...multipart(parts) });
}

function jsonError(response, status) {
  assert.equal(response.statusCode, status);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(Object.keys(response.json()), ['error']);
  assert.equal(typeof response.json().error, 'string');
  assert.doesNotMatch(response.body, /\/tmp\/|\/app\/|ffmpeg|stack|ENOENT|SIGKILL/i);
}

function probe(response, codec) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels', '-of', 'json', 'pipe:0'], { input: response.rawPayload });
  assert.equal(result.status, 0, result.stderr?.toString());
  const streams = JSON.parse(result.stdout.toString()).streams;
  assert.equal(streams.length, 1);
  assert.equal(streams[0].codec_type, 'audio');
  assert.equal(streams[0].codec_name, codec);
  assert.equal(streams[0].sample_rate, '16000');
  assert.equal(streams[0].channels, 1);
}

test('GET /health returns 200 and ok', async t => {
  const response = await appFor(t).inject('/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('missing file is rejected', async t => {
  jsonError(await convert(appFor(t), [{ name: 'target', value: 'm4a' }]), 400);
});

test('an empty POST without a file or content type is rejected', async t => {
  jsonError(await appFor(t).inject({ method: 'POST', url: '/convert' }), 400);
});

test('non-multipart request is rejected', async t => {
  jsonError(await appFor(t).inject({ method: 'POST', url: '/convert', payload: { target: 'm4a' } }), 415);
});

for (const target of ['flac', '', '__proto__', 'constructor', 'm4a;touch /tmp/x']) {
  test(`unsupported target ${JSON.stringify(target)} is rejected`, async t => {
    jsonError(await convert(appFor(t), [{ name: 'target', value: target }, { name: 'file', file: opus }]), 400);
  });
}

test('empty upload is rejected', async t => {
  jsonError(await convert(appFor(t), [{ name: 'file', file: Buffer.alloc(0) }]), 400);
});

test('configured upload limit is enforced', async t => {
  jsonError(await convert(appFor(t, { maxUploadBytes: 8 }), [{ name: 'file', file: Buffer.alloc(9) }]), 413);
});

test('default 25 MB upload limit is enforced', async t => {
  jsonError(await convert(appFor(t), [{ name: 'file', file: Buffer.alloc(MAX_UPLOAD_BYTES + 1) }]), 413);
});

test('a file exactly at the configured limit is accepted', async t => {
  const response = await convert(appFor(t, { maxUploadBytes: opus.length }), [{ name: 'file', file: opus }]);
  assert.equal(response.statusCode, 200);
  probe(response, 'aac');
});

for (const [target, type, codec] of [['m4a', 'audio/mp4', 'aac'], ['mp3', 'audio/mpeg', 'mp3'], ['wav', 'audio/wav', 'pcm_s16le']]) {
  test(`real Opus -> ${target}, including a target field after the file`, async t => {
    const response = await convert(appFor(t), [{ name: 'file', file: opus }, { name: 'target', value: target }]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], type);
    assert.equal(response.headers['content-disposition'], `attachment; filename="converted.${target}"`);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(response.rawPayload.length > 0);
    assert.equal(Number(response.headers['content-length']), response.rawPayload.length);
    probe(response, codec);
  });
}

test('target defaults to M4A and client filenames are not filesystem paths', async t => {
  const response = await convert(appFor(t), [{ name: 'file', file: opus, filename: '../../untrusted.wav' }]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'audio/mp4');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="converted.m4a"');
  probe(response, 'aac');
});

test('other decodable self-contained audio is accepted', async t => {
  const response = await convert(appFor(t), [{ name: 'file', file: wav, filename: 'no-extension' }]);
  assert.equal(response.statusCode, 200);
  probe(response, 'aac');
});

test('invalid audio returns a safe error and the next real conversion succeeds', async t => {
  const app = appFor(t);
  jsonError(await convert(app, [{ name: 'file', file: Buffer.from('not audio') }]), 422);
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await convert(app, [{ name: 'file', file: opus }])).statusCode, 200);
});

test('local-file concatenation scripts are rejected', async t => {
  const script = `ffconcat version 1.0\nfile '${join(root, 'tone.wav')}'\n`;
  jsonError(await convert(appFor(t), [{ name: 'file', file: Buffer.from(script) }]), 422);
});

test('remote playlists are rejected without making network requests', async t => {
  let requests = 0;
  const origin = createServer((request, reply) => {
    requests++;
    reply.end(wav);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => origin.close(resolve)));
  const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${origin.address().port}/private.wav\n#EXT-X-ENDLIST\n`;
  jsonError(await convert(appFor(t), [{ name: 'file', file: Buffer.from(playlist) }]), 422);
  assert.equal(requests, 0);
});

test('unexpected file field is rejected and drained', async t => {
  jsonError(await convert(appFor(t), [{ name: 'other', file: opus }]), 400);
});

test('multiple files are rejected', async t => {
  jsonError(await convert(appFor(t), [{ name: 'file', file: opus }, { name: 'file', file: opus }]), 400);
});

test('duplicate target fields are rejected', async t => {
  jsonError(await convert(appFor(t), [{ name: 'target', value: 'mp3' }, { name: 'target', value: 'wav' }, { name: 'file', file: opus }]), 400);
});

test('malformed multipart body is rejected and cleaned up', async t => {
  const response = await appFor(t).inject({ method: 'POST', url: '/convert', headers: { 'content-type': 'multipart/form-data; boundary=missing' }, payload: 'incomplete body' });
  jsonError(response, 400);
});

test('truncated multipart audio is rejected and cleaned up', async t => {
  const body = multipart([{ name: 'file', file: opus }]);
  const response = await appFor(t).inject({ method: 'POST', url: '/convert', ...body, payload: body.payload.subarray(0, body.payload.length - 200) });
  jsonError(response, 400);
});

test('missing FFmpeg returns a safe availability error', async t => {
  jsonError(await convert(appFor(t, { ffmpegPath: join(root, 'missing-binary') }), [{ name: 'file', file: opus }]), 503);
});

async function hangingBinary() {
  const marker = join(root, randomUUID() + '.pid');
  const binary = join(root, randomUUID() + '.mjs');
  await writeFile(binary, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},String(process.pid));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const pid = async () => {
    try { return Number(await readFile(marker, 'utf8')); } catch { return undefined; }
  };
  return { binary, pid };
}

function stopped(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

test('timeout kills the child, cleans files, and frees capacity while health stays responsive', async t => {
  const fake = await hangingBinary();
  const app = appFor(t, { ffmpegPath: fake.binary, conversionTimeoutMs: 750, maxConcurrentConversions: 1 });
  const pending = convert(app, [{ name: 'file', file: opus }]);
  await eventually(async () => Boolean(await fake.pid()));
  jsonError(await convert(app, [{ name: 'file', file: opus }]), 503);
  assert.equal((await app.inject('/health')).statusCode, 200);
  jsonError(await pending, 504);
  assert.ok(stopped(await fake.pid()));
  jsonError(await convert(app, [{ name: 'file', file: opus }, { name: 'target', value: 'bad' }]), 400);
  assert.equal((await app.inject('/health')).statusCode, 200);
});

test('HTTP client disconnection kills the child and cleans files', async t => {
  const fake = await hangingBinary();
  const app = appFor(t, { ffmpegPath: fake.binary });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const body = multipart([{ name: 'file', file: opus }]);
  const client = httpRequest(address + '/convert', { method: 'POST', headers: { ...body.headers, 'content-length': body.payload.length } });
  client.on('error', () => {});
  t.after(() => client.destroy());
  client.end(body.payload);
  await eventually(async () => Boolean(await fake.pid()));
  client.destroy();
  await eventually(async () => stopped(await fake.pid()) && (await readdir(work)).length === 0);
  assert.equal((await app.inject('/health')).statusCode, 200);
});

test('graceful shutdown cancels a conversion and removes its temporary directory', async t => {
  const fake = await hangingBinary();
  const app = appFor(t, { ffmpegPath: fake.binary });
  const pending = convert(app, [{ name: 'file', file: opus }]);
  await eventually(async () => Boolean(await fake.pid()));
  await app.close();
  jsonError(await pending, 400);
  assert.ok(stopped(await fake.pid()));
});

for (const action of ['disconnect', 'shutdown']) {
  test(`${action} during an unfinished upload removes temporary files`, async t => {
    const app = appFor(t);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const body = multipart([{ name: 'file', file: opus }]);
    const client = httpRequest(address + '/convert', { method: 'POST', headers: { ...body.headers, 'content-length': body.payload.length } });
    client.on('error', () => {});
    t.after(() => client.destroy());
    client.write(body.payload.subarray(0, body.payload.length - 200));
    await eventually(async () => (await readdir(work)).length > 0);
    if (action === 'disconnect') client.destroy();
    else await app.close();
    await eventually(async () => (await readdir(work)).length === 0);
    if (action === 'disconnect') assert.equal((await app.inject('/health')).statusCode, 200);
  });
}
