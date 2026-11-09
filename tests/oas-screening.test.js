import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

import { OAS_SCREENING_WAIT_MS, OAS_UPLOAD_TIMEOUT_MS, postOas } from '../lib/oas-upload.js';

const screeningId = 'a'.repeat(64);
const pending = (overrides = {}) => ({
  ok: true, status: 202,
  json: async () => ({ pending: true, screening_id: screeningId, retry_after_ms: 1000, ...overrides }),
});
const payload = { token: 'fixture-token', oas_raw: 'private-spec-sentinel', format: 'json' };
const upload = (options) => postOas({ url: 'https://x/oas', payload, ...options });
const interruptedRequest = (_url, init) => new Promise((_resolve, reject) =>
  init.signal.addEventListener('abort', () => reject(new Error('fixture-token private-spec-sentinel'))));

afterEach(() => vi.useRealTimers());

describe('authenticated OAS screening', () => {
  it('declares the published resume protocol implemented by authenticated requests', async () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    expect(manifest.version).toBe('0.13.0');
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[''].version).toBe(manifest.version);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await upload({ fetchImpl });
    expect(String(manifest.restless.knowledgeResumeProtocol))
      .toBe(fetchImpl.mock.calls[0][1].headers['X-Restless-Knowledge-Resume']);
  });

  it('opts in, adopts replacement IDs and never re-uploads raw specs while polling', async () => {
    vi.useFakeTimers();
    const replacement = 'b'.repeat(64);
    const fetchImpl = vi.fn().mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending({ screening_id: replacement }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const onPending = vi.fn();
    const result = upload({ fetchImpl, onPending });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).status).toBe(200);
    expect(onPending).toHaveBeenCalledTimes(2);
    const requests = fetchImpl.mock.calls.map(([, init]) => init);
    expect(requests.every((init) => init.headers['X-Restless-Knowledge-Resume'] === '1')).toBe(true);
    expect(requests.map((init) => JSON.parse(init.body))).toEqual([
      payload,
      { token: 'fixture-token', screening_id: screeningId },
      { token: 'fixture-token', screening_id: replacement },
    ]);
  });

  it('does not opt anonymous staging into screening', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    expect((await upload({ payload: { setup_key: 'sk' }, fetchImpl })).status).toBe(201);
    expect(fetchImpl.mock.calls[0][1].headers['X-Restless-Knowledge-Resume']).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { pending: false }, { screening_id: undefined }, { screening_id: 'not-an-id' },
    { screening_id: 12 }, { retry_after_ms: undefined }, { retry_after_ms: '1000' },
    { retry_after_ms: 0 }, { retry_after_ms: -1 }, { retry_after_ms: 1.5 },
    { retry_after_ms: 60_001 }, { retry_after_ms: Infinity },
  ])('stops on invalid pending metadata: %j', async (overrides) => {
    const fetchImpl = vi.fn().mockResolvedValue(pending(overrides));
    await expect(upload({ fetchImpl })).rejects.toThrow('invalid screening progress');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed pending JSON without exposing its body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 202, json: async () => { throw new Error('private-spec-sentinel'); },
    });
    await expect(upload({ fetchImpl })).rejects.toThrow('invalid screening progress');
  });

  it.each([400, 401, 403, 413, 415, 426, 503])('does not retry an authenticated HTTP %s', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status });
    const result = await upload({ payload: { ...payload, oas_raw: 'x'.repeat(200 * 1024) }, fetchImpl });
    expect(result.status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retains safe pending context when a resumed request is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValueOnce(pending()).mockImplementationOnce(interruptedRequest);
    const result = upload({ fetchImpl, signal: controller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    const error = await result;
    expect(error).toMatchObject({ pending: true, cancelled: true, screening_id: screeningId, retry_after_ms: 1000 });
    expect(error.message).not.toMatch(/fixture-token|private-spec-sentinel/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['timeout', 'cancel'])('keeps final response parsing abortable on %s', async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValueOnce(pending()).mockImplementationOnce((_url, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('private-spec-sentinel')), { once: true });
      }),
    }));
    const result = upload({
      fetchImpl, signal: controller.signal, readResponse: (res) => res.json(),
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    if (reason === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(OAS_UPLOAD_TIMEOUT_MS);
    expect(await result).toMatchObject({
      pending: true, screening_id: screeningId, cancelled: reason === 'cancel',
    });
    expect((await result).message).not.toContain('private-spec-sentinel');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending wait without issuing another request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(pending());
    const result = upload({ fetchImpl, signal: controller.signal, onPending: () => controller.abort() });
    await expect(result).rejects.toMatchObject({ pending: true, cancelled: true, screening_id: screeningId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not send an already cancelled upload', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(upload({ fetchImpl, signal: controller.signal })).rejects.toMatchObject({ cancelled: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a resumed request to 70 seconds and preserves the opaque ID on timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(pending()).mockImplementationOnce(interruptedRequest);
    const result = upload({ fetchImpl }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000 + OAS_UPLOAD_TIMEOUT_MS);
    expect(await result).toMatchObject({ pending: true, screening_id: screeningId });
    expect((await result).message).not.toMatch(/fixture-token|private-spec-sentinel/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('allows more than an hour but stops polling at its total deadline', async () => {
    vi.useFakeTimers();
    expect(OAS_SCREENING_WAIT_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    const fetchImpl = vi.fn().mockResolvedValue(pending({ retry_after_ms: 60_000 }));
    const result = upload({ fetchImpl }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(OAS_SCREENING_WAIT_MS);
    expect(await result).toMatchObject({ pending: true, screening_id: screeningId });
    expect((await result).message).toContain('two hours');
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(OAS_SCREENING_WAIT_MS / 60_000);
  });
});
