import { ConfigService } from '@nestjs/config';
import { Request } from 'playwright';
import { chromium } from 'playwright-extra';
import { NoonBrowserSessionService } from '../services/noon-browser-session.service';

describe('NoonBrowserSessionService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reuses one browser context and captures headers without an extra wait', async () => {
    let requestListener: ((request: Request) => void) | undefined;
    const request = {
      method: () => 'GET',
      url: () =>
        'https://www.noon.com/_vs/nc/mp-customer-catalog-api/api/v3/u/product/N1/p/',
      allHeaders: jest.fn().mockResolvedValue({
        accept: 'application/json',
        cookie: 'visitor_id=secret',
        'user-agent': 'Browser Chrome UA',
      }),
    } as unknown as Request;
    const page = {
      isClosed: () => false,
      setDefaultTimeout: jest.fn(),
      setDefaultNavigationTimeout: jest.fn(),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      evaluate: jest
        .fn()
        .mockResolvedValue('Browser HeadlessChrome/149.0.0.0 UA'),
      on: jest.fn(
        (_event: string, listener: (request: Request) => void): void => {
          requestListener = listener;
        },
      ),
      off: jest.fn(),
      goto: jest.fn().mockImplementation(() => {
        requestListener?.(request);
        return Promise.resolve(null);
      }),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      pages: jest.fn().mockReturnValue([page]),
      newPage: jest.fn(),
      cookies: jest.fn().mockResolvedValue([
        {
          name: 'visitor_id',
          value: 'secret',
          expires: Date.now() / 1_000 + 300,
        },
      ]),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const launch = jest
      .spyOn(chromium, 'launchPersistentContext')
      .mockResolvedValue(context as never);
    const service = new NoonBrowserSessionService(
      new ConfigService({
        PROXY_URL: 'http://user:password@proxy.test:8080',
        NOON_COOKIE_SETTLE_MS: 1,
      }),
    );

    const first = await service.extract('https://noon.test/product-one');
    const second = await service.extract('https://noon.test/product-two');
    await service.onApplicationShutdown();

    expect(first).toMatchObject({
      cookieHeader: 'visitor_id=secret',
      userAgent: 'Browser Chrome UA',
      requestHeaders: { accept: 'application/json' },
    });
    expect(second.cookieHeader).toBe(first.cookieHeader);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        proxy: {
          server: 'http://proxy.test:8080',
          username: 'user',
          password: 'password',
        },
      }),
    );
  });
});
