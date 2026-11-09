import { gzipSync } from 'node:zlib';

/**
 * The one way this CLI sends a spec to `POST /api/projects/:id/oas`, used by
 * both the pre-claim staging path and the post-claim re-sync.
 *
 * The spec is the only request in a run whose duration tracks the size of the
 * user's API, and the upload is the slow half of it: a 2.9MB spec is ~3.4MB on
 * the wire once JSON escaping is paid for, which measured 8-16s on an ordinary
 * connection. So it blew a 10s abort before the server could answer, and the
 * server's actionable 413 was replaced by a bare timeout. Both fixes live here
 * rather than in either caller.
 */

/** Compressing a small body costs more than it saves, and small bodies were
 *  never what timed out. A real spec gzips about 8x. */
const GZIP_MIN_BYTES = 128 * 1024;

/** Covers the server's 60s screening route plus 10s for upload and transport.
 *  Shared by login staging and authenticated update. */
export const OAS_UPLOAD_TIMEOUT_MS = 70000;
export const OAS_SCREENING_WAIT_MS = 2 * 60 * 60 * 1000;

export class OasScreeningError extends Error {
  constructor(message, { screeningId, retryAfterMs, cancelled = false } = {}) {
    super(message);
    this.name = 'OasScreeningError';
    this.cancelled = cancelled;
    if (screeningId) {
      this.pending = true;
      this.screening_id = screeningId;
      this.retry_after_ms = retryAfterMs;
    }
  }
}

function waitForScreening(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish(new Error('cancelled'));
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export async function postOas({
  url,
  payload,
  timeoutMs = OAS_UPLOAD_TIMEOUT_MS,
  fetchImpl = fetch,
  signal,
  onPending,
  readResponse = (res) => res,
}) {
  const authenticated = typeof payload.token === 'string' && payload.token.length > 0;
  const deadline = Date.now() + OAS_SCREENING_WAIT_MS;
  let screeningId;
  let retryAfterMs;

  const request = async (body, compressed) => {
    if (signal?.aborted) throw new Error('cancelled');
    if (authenticated && Date.now() >= deadline) {
      throw new OasScreeningError('Stopped waiting for spec screening after two hours. Publication was not confirmed.', { screeningId, retryAfterMs });
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, Math.min(timeoutMs, deadline - Date.now()));
    try {
      if (signal?.aborted) cancel();
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { 'X-Restless-Knowledge-Resume': '1' } : {}),
          ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
        },
        body: compressed ? gzipSync(Buffer.from(body, 'utf8')) : body,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error('request stopped');
      if (!authenticated || res.status !== 202) {
        const response = await readResponse(res);
        if (controller.signal.aborted) throw new Error('request stopped');
        return { res, response };
      }
      const data = await res.json().catch(() => null);
      if (controller.signal.aborted) throw new Error('request stopped');
      if (data?.pending !== true || typeof data.screening_id !== 'string'
        || !/^[a-f0-9]{64}$/i.test(data.screening_id)
        || !Number.isSafeInteger(data.retry_after_ms)
        || data.retry_after_ms < 1 || data.retry_after_ms > 60_000) {
        throw new OasScreeningError('The server returned invalid screening progress. No publication was confirmed.');
      }
      return { res, progress: data };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };

  try {
    let body = JSON.stringify(payload);
    let compressed = Buffer.byteLength(body, 'utf8') >= GZIP_MIN_BYTES;
    let reply = await request(body, compressed);
    // Older anonymous staging deployments cannot decode compressed uploads.
    if (!authenticated && compressed && (reply.res.status === 415 || reply.res.status === 400)) {
      reply = await request(body, false);
    }
    while (authenticated && reply.res.status === 202) {
      screeningId = reply.progress.screening_id;
      retryAfterMs = Math.max(1000, reply.progress.retry_after_ms);
      onPending?.();
      if (Date.now() + retryAfterMs >= deadline) {
        throw new OasScreeningError('Stopped waiting for spec screening after two hours. Publication was not confirmed.', { screeningId, retryAfterMs });
      }
      await waitForScreening(retryAfterMs, signal);
      body = JSON.stringify({ token: payload.token, screening_id: screeningId });
      compressed = false;
      reply = await request(body, compressed);
    }
    return reply.response;
  } catch (error) {
    if (error instanceof OasScreeningError) throw error;
    throw new OasScreeningError(signal?.aborted
      ? 'Spec screening cancelled. Publication was not confirmed.'
      : 'Spec upload or screening request failed. Publication was not confirmed.', {
      screeningId, retryAfterMs, cancelled: !!signal?.aborted,
    });
  }
}
