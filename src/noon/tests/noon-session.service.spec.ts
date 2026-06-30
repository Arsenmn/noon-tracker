import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium } from 'playwright-extra';
import { NoonSessionService } from '../services/noon-session.service';

describe('NoonSessionService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('extracts, logs and reuses cookies and user-agent until session expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T10:00:00.000Z'));
    const page = {
      setDefaultNavigationTimeout: jest.fn(),
      goto: jest.fn().mockResolvedValue(null),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue('Test Browser UA'),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      waitForRequest: jest.fn().mockResolvedValue({
        allHeaders: jest.fn().mockResolvedValue({
          accept: 'application/json',
          cookie: 'visitor_id=secret-cookie-value',
          'user-agent': 'Test Browser UA',
        }),
      }),
    };
    const context = {
      pages: jest.fn().mockReturnValue([page]),
      newPage: jest.fn(),
      setDefaultTimeout: jest.fn(),
      cookies: jest.fn().mockResolvedValue([
        {
          name: 'visitor_id',
          value: 'secret-cookie-value',
          expires: Date.now() / 1_000 + 120,
        },
      ]),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const launch = jest
      .spyOn(chromium, 'launchPersistentContext')
      .mockResolvedValue(context as never);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const service = new NoonSessionService(
      new ConfigService({
        NOON_COOKIE_SETTLE_MS: 1,
        NOON_COOKIE_REFRESH_MS: 240_000,
        NOON_COOKIE_EXPIRY_SKEW_MS: 30_000,
      }),
    );

    const first = await service.getSession(
      'https://www.noon.com/uae-en/product/N00000001A/p/',
    );
    const second = await service.getSession(
      'https://www.noon.com/uae-en/product/N00000001A/p/',
    );

    expect(first).toMatchObject({
      cookieHeader: 'visitor_id=secret-cookie-value',
      userAgent: 'Test Browser UA',
    });
    expect(second).toBe(first);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({
      'user-agent': 'Test Browser UA',
    });
    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('getSession output source=browser'),
        expect.stringContaining('getSession output source=cache'),
        expect.stringContaining('cookieNames=visitor_id'),
        expect.stringContaining('ttlMs=90000'),
      ]),
    );
    expect(messages.join('\n')).not.toContain('secret-cookie-value');
  });
});
