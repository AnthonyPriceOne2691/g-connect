import { describe, expect, it, vi } from 'vitest';

import { gcError } from '../src/core/errors.js';
import { withRetry } from '../src/core/retry.js';

const noSleep = async (): Promise<void> => undefined;

describe('withRetry', () => {
  it('возвращает результат без повторов, если всё хорошо', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('повторяет 429 и отдаёт результат со второй попытки', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw { code: 429, message: 'Quota exceeded' };
        return 'ok';
      },
      { sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('не повторяет 403 — там нужен человек, а не задержка', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw { code: 403, message: 'The caller does not have permission' };
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ payload: { code: 'forbidden' } });
    expect(calls).toBe(1);
  });

  it('исчерпав попытки, отдаёт ошибку ядра, а не сырую', async () => {
    await expect(
      withRetry(
        async () => {
          throw { code: 503, message: 'Backend error' };
        },
        {
          maxRetries: 2,
          sleep: noSleep,
        },
      ),
    ).rejects.toMatchObject({ payload: { code: 'google_unavailable', retryable: true } });
  });

  it('сообщает о повторе — панели нужно «попытка 2 из 3» (§13.7)', async () => {
    const seen: string[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw gcError('google_unavailable');
        return 'ok';
      },
      {
        maxRetries: 2,
        backoffMs: 10,
        sleep: noSleep,
        onRetry: (attempt, total, delay) => seen.push(`${attempt}/${total}@${delay}`),
      },
    );
    expect(seen).toEqual(['2/3@10', '3/3@20']);
  });
});
