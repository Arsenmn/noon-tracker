import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrowserContext, Page, Request } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

export interface BrowserSessionSnapshot {
  cookieHeader: string;
  userAgent: string;
  requestHeaders: Record<string, string>;
  cookieNames: string[];
  earliestCookieExpiry?: number;
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_BROWSER_IDLE_MS = 600_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const FORWARD_HEADER_NAMES = new Set([
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

@Injectable()
export class NoonBrowserSessionService implements OnApplicationShutdown {
  private readonly logger = new Logger(NoonBrowserSessionService.name);
  private context?: BrowserContext;
  private contextPromise?: Promise<BrowserContext>;
  private page?: Page;
  private userAgent?: string;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly configService: ConfigService) {}

  async extract(productUrl: string): Promise<BrowserSessionSnapshot> {
    try {
      const snapshot = await this.extractFromContext(productUrl);
      this.scheduleIdleClose();
      return snapshot;
    } catch (error: unknown) {
      await this.closeContext();
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.closeContext();
  }

  private async extractFromContext(
    productUrl: string,
  ): Promise<BrowserSessionSnapshot> {
    const context = await this.getContext();
    const page = await this.getPage(context);
    const userAgent = await this.getUserAgent(page);
    await page.setExtraHTTPHeaders({ 'user-agent': userAgent });

    const catalogRequest = await this.navigateAndCapture(page, productUrl);
    const capturedHeaders = catalogRequest
      ? await this.withTimeout(
          catalogRequest.allHeaders(),
          this.bootstrapTimeout,
          'read catalog request headers',
        )
      : {};
    const cookies = await this.withTimeout(
      context.cookies([productUrl]),
      this.bootstrapTimeout,
      'read context cookies',
    );
    const fallbackCookieHeader = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const cookieHeader = capturedHeaders.cookie ?? fallbackCookieHeader;

    if (!cookieHeader) {
      throw new Error('Noon browser session did not contain cookies');
    }

    return {
      cookieHeader,
      userAgent: capturedHeaders['user-agent'] ?? userAgent,
      requestHeaders: this.selectForwardHeaders(capturedHeaders),
      cookieNames: this.getCookieNames(cookieHeader),
      earliestCookieExpiry: this.getEarliestCookieExpiry(cookies),
    };
  }

  private get bootstrapTimeout(): number {
    return this.configService.get<number>(
      'NOON_COOKIE_BOOTSTRAP_TIMEOUT_MS',
      DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    );
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }
    if (!this.contextPromise) {
      this.contextPromise = this.launchContext();
    }

    try {
      this.context = await this.contextPromise;
      return this.context;
    } finally {
      this.contextPromise = undefined;
    }
  }

  private async launchContext(): Promise<BrowserContext> {
    const profileDirectory =
      this.configService.get<string>('NOON_BROWSER_PROFILE_DIR') ||
      join(tmpdir(), 'noon-tracker-browser-profile');
    const executablePath = this.configService.get<string>(
      'NOON_BROWSER_EXECUTABLE',
    );
    const configuredChannel = this.configService.get<string>(
      'NOON_BROWSER_CHANNEL',
    );
    const macChromePath =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const channel =
      configuredChannel ||
      (!executablePath &&
      process.platform === 'darwin' &&
      existsSync(macChromePath)
        ? 'chrome'
        : undefined);
    const useProxy = this.shouldUseProxy();
    const proxy = useProxy ? this.getBrowserProxy() : undefined;
    const disableHttp2 =
      this.configService.get<string>(
        'NOON_DISABLE_HTTP2',
        useProxy ? 'true' : 'false',
      ) === 'true';

    this.logger.log(`Launching reusable Noon browser proxy=${useProxy}`);
    return chromium.launchPersistentContext(profileDirectory, {
      headless:
        this.configService.get<string>('NOON_BROWSER_HEADLESS', 'true') !==
        'false',
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
      timeout: this.bootstrapTimeout,
      ...(executablePath ? { executablePath } : {}),
      ...(channel ? { channel } : {}),
      ...(proxy ? { proxy } : {}),
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        ...(disableHttp2 ? ['--disable-http2'] : []),
      ],
    });
  }

  private async getPage(context: BrowserContext): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    this.page = context.pages().find((page) => !page.isClosed());
    this.page ??= await context.newPage();
    this.page.setDefaultTimeout(this.bootstrapTimeout);
    this.page.setDefaultNavigationTimeout(
      this.configService.get<number>(
        'NOON_COOKIE_NAVIGATION_TIMEOUT_MS',
        DEFAULT_NAVIGATION_TIMEOUT_MS,
      ),
    );
    return this.page;
  }

  private async getUserAgent(page: Page): Promise<string> {
    if (this.userAgent) {
      return this.userAgent;
    }
    const detected = await this.withTimeout(
      page.evaluate(() => navigator.userAgent),
      this.bootstrapTimeout,
      'read browser user agent',
    );
    this.userAgent = detected.replace('HeadlessChrome/', 'Chrome/');
    return this.userAgent;
  }

  private async navigateAndCapture(
    page: Page,
    productUrl: string,
  ): Promise<Request | undefined> {
    let capturedRequest: Request | undefined;
    const captureRequest = (request: Request): void => {
      if (!capturedRequest && this.isCatalogRequest(request)) {
        capturedRequest = request;
      }
    };
    page.on('request', captureRequest);

    try {
      await page
        .goto(productUrl, {
          waitUntil: 'commit',
          timeout: this.configService.get<number>(
            'NOON_COOKIE_NAVIGATION_TIMEOUT_MS',
            DEFAULT_NAVIGATION_TIMEOUT_MS,
          ),
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Noon navigation incomplete; using available browser state: ${this.errorMessage(error)}`,
          );
          return null;
        });
      await page.waitForTimeout(
        this.configService.get<number>(
          'NOON_COOKIE_SETTLE_MS',
          DEFAULT_SETTLE_MS,
        ),
      );
      return capturedRequest;
    } finally {
      page.off('request', captureRequest);
    }
  }

  private isCatalogRequest(request: Request): boolean {
    const url = request.url();
    return (
      request.method() === 'GET' &&
      url.includes('/mp-customer-catalog-api/api/v3/u/') &&
      url.includes('/p/')
    );
  }

  private selectForwardHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(headers).filter(([key]) =>
        FORWARD_HEADER_NAMES.has(key.toLowerCase()),
      ),
    );
  }

  private getCookieNames(cookieHeader: string): string[] {
    return cookieHeader
      .split(';')
      .map((part) => part.trim().split('=', 1)[0])
      .filter(Boolean);
  }

  private getEarliestCookieExpiry(
    cookies: Awaited<ReturnType<BrowserContext['cookies']>>,
  ): number | undefined {
    const now = Date.now();
    const expiries = cookies
      .map((cookie) => cookie.expires * 1_000)
      .filter((expiresAt) => expiresAt > now);
    return expiries.length > 0 ? Math.min(...expiries) : undefined;
  }

  private shouldUseProxy(): boolean {
    return (
      this.configService.get<string>(
        'NOON_BROWSER_USE_PROXY',
        this.configService.get<string>('PROXY_URL') ? 'true' : 'false',
      ) === 'true'
    );
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

  private async closeContext(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.userAgent = undefined;
    if (!context) {
      return;
    }
    try {
      await this.withTimeout(
        context.close(),
        CONTEXT_CLOSE_TIMEOUT_MS,
        'close browser context',
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Could not close Noon browser context: ${this.errorMessage(error)}`,
      );
    }
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(
      () => {
        void this.closeContext();
      },
      this.configService.get<number>(
        'NOON_BROWSER_IDLE_MS',
        DEFAULT_BROWSER_IDLE_MS,
      ),
    );
    this.idleTimer.unref();
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
