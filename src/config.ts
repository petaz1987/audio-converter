export const MAX_UPLOAD_BYTES = 25_000_000;
export const CONVERSION_TIMEOUT_MS = 60_000;

function integer(value: string | undefined, fallback: number, name: string, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if ((value !== undefined && !/^\d+$/.test(value)) || !Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return result;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: integer(env.PORT, 3000, 'PORT', 65535),
    maxUploadBytes: integer(env.MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES, 'MAX_UPLOAD_BYTES', MAX_UPLOAD_BYTES),
    conversionTimeoutMs: integer(env.CONVERSION_TIMEOUT_MS, CONVERSION_TIMEOUT_MS, 'CONVERSION_TIMEOUT_MS', CONVERSION_TIMEOUT_MS),
    maxConcurrentConversions: integer(env.MAX_CONCURRENT_CONVERSIONS, 2, 'MAX_CONCURRENT_CONVERSIONS', 16),
  };
}
