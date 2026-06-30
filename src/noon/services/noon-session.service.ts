import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrowserContext } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

export interface NoonHttpSession {
  cookieHeader: string;
  userAgent: string;
  requestHeaders: Record<string, string>;
}

interface CachedNoonSession extends NoonHttpSession {
  expiresAt: number;
  cookieNames: string[];
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_SESSION_TTL_MS = 240_000;
const DEFAULT_EXPIRY_SKEW_MS = 30_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

@Injectable()
export class NoonSessionService {
  private readonly logger = new Logger(NoonSessionService.name);
  private cachedSession?: CachedNoonSession;
  private refreshPromise?: Promise<CachedNoonSession>;

  constructor(private readonly configService: ConfigService) {}

  async getSession(
    productUrl: string,
    forceRefresh = false,
  ): Promise<NoonHttpSession> {
    this.logger.log(
      `getSession called forceRefresh=${forceRefresh} cachePresent=${Boolean(this.cachedSession)}`,
    );
    if (
      !forceRefresh &&
      this.cachedSession &&
      this.cachedSession.expiresAt > Date.now()
    ) {
      this.logSessionOutput('cache', this.cachedSession);
      return this.cachedSession;
    }
    if (this.refreshPromise) {
      const session = await this.refreshPromise;
      this.logSessionOutput('pending-refresh', session);
      return session;
    }

    this.refreshPromise = this.createSession(productUrl).finally(() => {
      this.refreshPromise = undefined;
    });
    this.cachedSession = await this.refreshPromise;
    this.logSessionOutput('browser', this.cachedSession);
    return this.cachedSession;
  }

  invalidate(): void {
    this.cachedSession = undefined;
  }

  private async createSession(productUrl: string): Promise<CachedNoonSession> {
    const timeout = this.configService.get<number>(
      'NOON_COOKIE_BOOTSTRAP_TIMEOUT_MS',
      DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    );
    const settleMs = this.configService.get<number>(
      'NOON_COOKIE_SETTLE_MS',
      DEFAULT_SETTLE_MS,
    );
    const navigationTimeout = this.configService.get<number>(
      'NOON_COOKIE_NAVIGATION_TIMEOUT_MS',
      DEFAULT_NAVIGATION_TIMEOUT_MS,
    );
    const profileDirectory =
      this.configService.get<string>('NOON_BROWSER_PROFILE_DIR') ||
      join(tmpdir(), 'noon-tracker-browser-profile');
    const executablePath = this.configService.get<string>(
      'NOON_BROWSER_EXECUTABLE',
    );
    const configuredBrowserChannel = this.configService.get<string>(
      'NOON_BROWSER_CHANNEL',
    );
    const macChromePath =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browserChannel =
      configuredBrowserChannel ||
      (!executablePath &&
      process.platform === 'darwin' &&
      existsSync(macChromePath)
        ? 'chrome'
        : undefined);
    const useBrowserProxy =
      this.configService.get<string>(
        'NOON_BROWSER_USE_PROXY',
        this.configService.get<string>('PROXY_URL') ? 'true' : 'false',
      ) === 'true';
    const disableHttp2 =
      this.configService.get<string>(
        'NOON_DISABLE_HTTP2',
        useBrowserProxy ? 'true' : 'false',
      ) === 'true';

    this.logger.log(
      `Refreshing Noon browser cookies stage=launch proxy=${useBrowserProxy}`,
    );
    let context: BrowserContext | undefined;

    try {
      const browserProxy = useBrowserProxy ? this.getBrowserProxy() : undefined;
      context = await chromium.launchPersistentContext(profileDirectory, {
        headless:
          this.configService.get<string>('NOON_BROWSER_HEADLESS', 'true') !==
          'false',
        locale: 'en-AE',
        timezoneId: 'Asia/Dubai',
        timeout,
        ...(executablePath ? { executablePath } : {}),
        ...(browserChannel ? { channel: browserChannel } : {}),
        ...(browserProxy ? { proxy: browserProxy } : {}),
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          ...(disableHttp2 ? ['--disable-http2'] : []),
        ],
      });
      context.setDefaultTimeout(timeout);
      this.logger.log('Refreshing Noon browser cookies stage=navigate');

      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultNavigationTimeout(navigationTimeout);
      const detectedUserAgent = await this.withTimeout(
        page.evaluate(() => navigator.userAgent),
        timeout,
        'read browser user agent',
      );
      const normalizedUserAgent = detectedUserAgent.replace(
        'HeadlessChrome/',
        'Chrome/',
      );
      await page.setExtraHTTPHeaders({ 'user-agent': normalizedUserAgent });

      const catalogRequestPromise = page
        .waitForRequest(
          (request) => {
            const url = request.url();
            return (
              request.method() === 'GET' &&
              url.includes('/mp-customer-catalog-api/api/v3/u/') &&
              url.includes('/p/')
            );
          },
          { timeout: navigationTimeout },
        )
        .catch((error: unknown) => {
          this.logger.warn(
            `Noon catalog request was not captured; using context cookies: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
      await page
        .goto(productUrl, {
          waitUntil: 'commit',
          timeout: navigationTimeout,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Noon page navigation did not complete; reading persisted cookies: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
      const catalogRequest = await catalogRequestPromise;
      await page.waitForTimeout(settleMs);

      const capturedHeaders = catalogRequest
        ? await this.withTimeout(
            catalogRequest.allHeaders(),
            timeout,
            'read catalog request headers',
          )
        : {};

      const cookies = await this.withTimeout(
        context.cookies([productUrl]),
        timeout,
        'read context cookies',
      );
      const fallbackCookieHeader = cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
      const cookieHeader = capturedHeaders.cookie ?? fallbackCookieHeader;
      const userAgent = capturedHeaders['user-agent'] ?? normalizedUserAgent;
      if (!cookieHeader) {
        throw new Error('Noon browser session did not contain cookies');
      }
      this.logger.log('Refreshing Noon browser cookies stage=complete');

      const now = Date.now();
      const configuredExpiresAt =
        now +
        this.configService.get<number>(
          'NOON_COOKIE_REFRESH_MS',
          DEFAULT_SESSION_TTL_MS,
        );
      const expirySkewMs = this.configService.get<number>(
        'NOON_COOKIE_EXPIRY_SKEW_MS',
        DEFAULT_EXPIRY_SKEW_MS,
      );
      const persistentCookieExpiresAt = cookies.reduce((earliest, cookie) => {
        if (cookie.expires <= 0) {
          return earliest;
        }
        const rawExpiresAt = cookie.expires * 1_000;
        if (rawExpiresAt <= now) {
          return earliest;
        }
        return Math.min(
          earliest,
          Math.max(now + 1_000, rawExpiresAt - expirySkewMs),
        );
      }, Number.POSITIVE_INFINITY);

      return {
        cookieHeader,
        userAgent,
        requestHeaders: this.selectForwardHeaders(capturedHeaders),
        cookieNames: this.getCookieNames(cookieHeader),
        expiresAt: Math.max(
          now + 1_000,
          Math.min(configuredExpiresAt, persistentCookieExpiresAt),
        ),
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not extract Noon cookies: ${reason}`);
      throw new ServiceUnavailableException(
        'Could not establish Noon cookie session',
      );
    } finally {
      if (context) {
        try {
          await this.withTimeout(
            context.close(),
            CONTEXT_CLOSE_TIMEOUT_MS,
            'close browser context',
          );
        } catch (error: unknown) {
          this.logger.warn(
            `Could not close Noon browser context: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  private selectForwardHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const allowed = new Set([
      'accept',
      'accept-language',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'x-ab-test',
      'x-border-enabled',
      'x-lat',
      'x-lng',
      'x-rocket-enabled',
      'x-rocket-zonecode',
    ]);
    return Object.fromEntries(
      Object.entries(headers).filter(([key]) => allowed.has(key.toLowerCase())),
    );
  }

  private getCookieNames(cookieHeader: string): string[] {
    return cookieHeader
      .split(';')
      .map((part) => part.trim().split('=', 1)[0])
      .filter(Boolean);
  }

  private logSessionOutput(
    source: 'cache' | 'pending-refresh' | 'browser',
    session: CachedNoonSession,
  ): void {
    const requestHeaderKeys = Object.keys(session.requestHeaders);
    this.logger.log(
      `getSession output source=${source} userAgent=${JSON.stringify(session.userAgent)} cookieCount=${session.cookieNames.length} cookieNames=${session.cookieNames.join(',') || 'none'} cookieHeaderLength=${session.cookieHeader.length} requestHeaderKeys=${requestHeaderKeys.join(',') || 'none'} expiresAt=${new Date(session.expiresAt).toISOString()} ttlMs=${Math.max(0, session.expiresAt - Date.now())}`,
    );
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    stage: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out while trying to ${stage}`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private getBrowserProxy():
    { server: string; username?: string; password?: string } | undefined {
    const value = this.configService.get<string>('PROXY_URL');
    if (!value) {
      return undefined;
    }
    const url = new URL(value);
    return {
      server: `${url.protocol}//${url.host}`,
      ...(url.username
        ? {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          }
        : {}),
    };
  }
}
