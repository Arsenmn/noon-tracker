import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NoonBrowserSessionService } from '../services/noon-browser-session.service';
import { NoonSessionService } from '../services/noon-session.service';

describe('NoonSessionService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('caches browser output until the earliest cookie expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T10:00:00.000Z'));
    const extract = jest.fn().mockResolvedValue({
      cookieHeader: 'visitor_id=secret-cookie-value',
      userAgent: 'Test Browser UA',
      requestHeaders: { accept: 'application/json' },
      cookieNames: ['visitor_id'],
      earliestCookieExpiry: Date.now() + 120_000,
    });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const service = new NoonSessionService(
      new ConfigService({
        NOON_COOKIE_REFRESH_MS: 240_000,
        NOON_COOKIE_EXPIRY_SKEW_MS: 30_000,
      }),
      { extract } as unknown as NoonBrowserSessionService,
    );

    const first = await service.getSession('https://noon.test/product');
    const second = await service.getSession('https://noon.test/product');

    expect(second).toBe(first);
    expect(extract).toHaveBeenCalledTimes(1);
    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('source=browser'),
        expect.stringContaining('source=cache'),
        expect.stringContaining('cookieNames=visitor_id'),
        expect.stringContaining('ttlMs=90000'),
      ]),
    );
    expect(messages.join('\n')).not.toContain('secret-cookie-value');
  });

  it('coalesces concurrent refreshes into one browser extraction', async () => {
    let resolveExtraction: ((value: object) => void) | undefined;
    const extract = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveExtraction = resolve;
      }),
    );
    const service = new NoonSessionService(new ConfigService(), {
      extract,
    } as unknown as NoonBrowserSessionService);

    const first = service.getSession('https://noon.test/one');
    const second = service.getSession('https://noon.test/two');
    resolveExtraction?.({
      cookieHeader: 'a=b',
      userAgent: 'UA',
      requestHeaders: {},
      cookieNames: ['a'],
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
