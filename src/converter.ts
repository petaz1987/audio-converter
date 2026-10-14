import { spawn } from 'node:child_process';
import { HttpError } from './errors.js';

export const formats = {
  m4a: { contentType: 'audio/mp4', args: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'ipod'] },
  mp3: { contentType: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3'] },
  wav: { contentType: 'audio/wav', args: ['-c:a', 'pcm_s16le', '-f', 'wav'] },
} as const;
export type Target = keyof typeof formats;

export function isTarget(value: unknown): value is Target {
  return typeof value === 'string' && Object.hasOwn(formats, value);
}

// Exclude playlists/scripts that can reference other files or remote URLs.
const inputFormats = 'ogg,mov,mp3,wav,flac,aac,aiff,matroska,webm,amr,asf,au,caf,ac3,eac3';

export async function convertAudio(options: {
  input: string;
  output: string;
  target: Target;
  timeoutMs: number;
  signal: AbortSignal;
  ffmpegPath: string;
}): Promise<void> {
  if (options.signal.aborted) throw new HttpError(400, 'Request was interrupted.');
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', 'file,pipe', '-format_whitelist', inputFormats,
    '-threads', '1', '-i', options.input,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-ac', '1', '-ar', '16000', '-threads', '1',
    ...formats[options.target].args, options.output,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ffmpegPath, args, { shell: false, stdio: 'ignore' });
    let failure: HttpError | undefined;
    const stop = (error: HttpError) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new HttpError(400, 'Request was interrupted.'));
    const timer = setTimeout(() => stop(new HttpError(504, 'Audio conversion timed out.')), options.timeoutMs);
    timer.unref();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.once('error', () => { failure ??= new HttpError(503, 'Audio conversion is unavailable.'); });
    // A kill must complete before the child's temporary files are removed.
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new HttpError(422, 'The file could not be decoded or converted as audio.'));
      else resolve();
    });
  });
}
