const DEFAULT_NOON_API_BASE_URL =
  'https://www.noon.com/_vs/nc/mp-customer-catalog-api';

// Validates .env
function nonEmptyString(
  config: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = config[key] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

// Checks if URL is valid
function validUrl(value: string, key: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
}

export function validateEnvironment(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const config = { ...input };
  const numericDefaults: Record<string, number> = {
    NOON_REQUEST_TIMEOUT_MS: 30_000,
    NOON_COOKIE_BOOTSTRAP_TIMEOUT_MS: 30_000,
    NOON_COOKIE_NAVIGATION_TIMEOUT_MS: 10_000,
    NOON_COOKIE_SETTLE_MS: 2_000,
    NOON_COOKIE_REFRESH_MS: 240_000,
    NOON_COOKIE_EXPIRY_SKEW_MS: 30_000,
    NOON_BROWSER_IDLE_MS: 600_000,
    MONITORING_JOB_ATTEMPTS: 3,
    MONITORING_JOB_BACKOFF_MS: 5_000,
    NOTIFICATION_JOB_ATTEMPTS: 5,
    NOTIFICATION_JOB_BACKOFF_MS: 3_000,
  };
  for (const [key, fallback] of Object.entries(numericDefaults)) {
    const value = Number(config[key] ?? fallback);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    config[key] = value;
  }

  const currency = nonEmptyString(config, 'NOON_CURRENCY', 'AED');
  if (currency !== 'AED') {
    throw new Error('NOON_CURRENCY must be AED for Noon UAE tracking');
  }

  config.NOON_API_BASE_URL = validUrl(
    nonEmptyString(config, 'NOON_API_BASE_URL', DEFAULT_NOON_API_BASE_URL),
    'NOON_API_BASE_URL',
  );
  config.NOON_COUNTRY = nonEmptyString(config, 'NOON_COUNTRY', 'ae');
  config.NOON_LOCALE = nonEmptyString(config, 'NOON_LOCALE', 'en-ae');
  config.NOON_ZONE_CODE = nonEmptyString(
    config,
    'NOON_ZONE_CODE',
    'AE_DXB-S14',
  );
  config.NOON_CURRENCY = currency;
  for (const key of [
    'NOON_BROWSER_HEADLESS',
    'NOON_DISABLE_HTTP2',
    'NOON_BROWSER_USE_PROXY',
  ]) {
    const fallback =
      key === 'NOON_BROWSER_HEADLESS'
        ? 'true'
        : key === 'NOON_BROWSER_USE_PROXY' && config.PROXY_URL
          ? 'true'
          : 'false';
    const value = config[key] ?? fallback;
    if (value !== 'true' && value !== 'false') {
      throw new Error(`${key} must be true or false`);
    }
    config[key] = value;
  }

  if (config.PROXY_URL) {
    if (typeof config.PROXY_URL !== 'string') {
      throw new Error('PROXY_URL must be a valid URL');
    }
    config.PROXY_URL = validUrl(config.PROXY_URL, 'PROXY_URL');
  }

  return config;
}
