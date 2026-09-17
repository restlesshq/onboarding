import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import { OAS_UPLOAD_TIMEOUT_MS, postOas } from '../lib/oas-upload.js';

/** A payload that clears the gzip threshold, and compresses well - which a
 *  real spec does (~8x), being mostly repeated JSON scaffolding. */
function bigPayload() {
  return { setup_key: 'sk', oas_raw: 'x'.repeat(200 * 1024), format: 'json' };
}

const ok = () => ({ ok: true, status: 200 });

describe('postOas', () => {
  it('sends a small body uncompressed, since compressing it buys nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await postOas({ url: 'https://x/oas', payload: { setup_key: 'sk' }, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ setup_key: 'sk' });
  });

  it('gzips a large body, which is what keeps a big spec inside the timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const payload = bigPayload();
    await postOas({ url: 'https://x/oas', payload, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['Content-Encoding']).toBe('gzip');
    // The server has to get the same bytes back out.
    expect(JSON.parse(gunzipSync(init.body).toString('utf8'))).toEqual(payload);
    // The lever only matters if it is a big one.
    expect(init.body.length).toBeLessThan(
      Buffer.byteLength(JSON.stringify(payload)) / 4,
    );
  });

  it('retries uncompressed when the server is too old to inflate it', async () => {
    // A new CLI pins `@latest` and can land on a deploy that predates gzip
    // support. Without this the spec upload would break outright.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 415 })
      .mockResolvedValueOnce(ok());
    const res = await postOas({ url: 'https://x/oas', payload: bigPayload(), fetchImpl });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers['Content-Encoding']).toBe('gzip');
    expect(fetchImpl.mock.calls[1][1].headers['Content-Encoding']).toBeUndefined();
  });

  it('retries on the 400 an older server answers a compressed body with', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce(ok());
    await postOas({ url: 'https://x/oas', payload: bigPayload(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 413 - the spec is too big, and sending it twice will not help', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 413 });
    const res = await postOas({ url: 'https://x/oas', payload: bigPayload(), fetchImpl });

    expect(res.status).toBe(413);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows 30s, because the budget covers uploading the body too', async () => {
    // The 10s this replaced aborted mid-upload on a 2.9MB spec and reported a
    // bare timeout in place of the server's own 413.
    expect(OAS_UPLOAD_TIMEOUT_MS).toBe(30000);
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await postOas({ url: 'https://x/oas', payload: { setup_key: 'sk' }, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
