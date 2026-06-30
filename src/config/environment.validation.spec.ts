import { validateEnvironment } from './environment.validation';

describe('validateEnvironment', () => {
  it('provides stable UAE delivery defaults and a numeric timeout', () => {
    expect(validateEnvironment({})).toEqual(
      expect.objectContaining({
        NOON_COUNTRY: 'ae',
        NOON_LOCALE: 'en-ae',
        NOON_ZONE_CODE: 'AE_DXB-S14',
        NOON_CURRENCY: 'AED',
        NOON_REQUEST_TIMEOUT_MS: 30_000,
        NOON_COOKIE_BOOTSTRAP_TIMEOUT_MS: 30_000,
        NOON_COOKIE_SETTLE_MS: 2_000,
        NOON_COOKIE_REFRESH_MS: 240_000,
        NOON_BROWSER_IDLE_MS: 600_000,
        NOON_BROWSER_HEADLESS: 'true',
        NOON_DISABLE_HTTP2: 'false',
        NOON_BROWSER_USE_PROXY: 'false',
      }),
    );
  });

  it('uses the configured proxy for the browser by default', () => {
    expect(
      validateEnvironment({ PROXY_URL: 'http://user:pass@proxy.test:8080' })
        .NOON_BROWSER_USE_PROXY,
    ).toBe('true');
  });

  it.each([
    [{ NOON_REQUEST_TIMEOUT_MS: 'zero' }, 'NOON_REQUEST_TIMEOUT_MS'],
    [{ NOON_REQUEST_TIMEOUT_MS: 0 }, 'NOON_REQUEST_TIMEOUT_MS'],
    [{ NOON_CURRENCY: 'USD' }, 'NOON_CURRENCY'],
    [{ NOON_API_BASE_URL: 'not-a-url' }, 'NOON_API_BASE_URL'],
    [{ PROXY_URL: 'not-a-url' }, 'PROXY_URL'],
    [{ NOON_COOKIE_REFRESH_MS: 0 }, 'NOON_COOKIE_REFRESH_MS'],
    [{ NOON_BROWSER_HEADLESS: 'sometimes' }, 'NOON_BROWSER_HEADLESS'],
    [{ NOON_DISABLE_HTTP2: 'sometimes' }, 'NOON_DISABLE_HTTP2'],
  ])('rejects invalid configuration %p', (config, message) => {
    expect(() => validateEnvironment(config)).toThrow(message);
  });
});
