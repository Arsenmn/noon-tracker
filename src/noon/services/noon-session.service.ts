import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrowserSessionSnapshot,
  NoonBrowserSessionService,
} from './noon-browser-session.service';

export interface NoonHttpSession {
  cookieHeader: string;
  userAgent: string;
  requestHeaders: Record<string, string>;
}

interface CachedNoonSession extends NoonHttpSession {
  expiresAt: number;
  cookieNames: string[];
}

const DEFAULT_SESSION_TTL_MS = 240_000;
const DEFAULT_EXPIRY_SKEW_MS = 30_000;
const MINIMUM_SESSION_TTL_MS = 1_000;

@Injectable()
export class NoonSessionService {
  private readonly logger = new Logger(NoonSessionService.name);
  private cachedSession?: CachedNoonSession;
  private refreshPromise?: Promise<CachedNoonSession>;

  constructor(
    private readonly configService: ConfigService,
    private readonly browserSession: NoonBrowserSessionService,
  ) {}

  async getSession(
    productUrl: string,
    forceRefresh = false,
  ): Promise<NoonHttpSession> {
    if (!forceRefresh && this.isCacheValid()) {
      this.logSession('cache', this.cachedSession as CachedNoonSession);
      return this.cachedSession as CachedNoonSession;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(productUrl).finally(() => {
        this.refreshPromise = undefined;
      });
    }

    const source = forceRefresh ? 'forced-refresh' : 'browser';
    const session = await this.refreshPromise;
    this.logSession(source, session);
    return session;
  }

  invalidate(): void {
    this.cachedSession = undefined;
  }

  private isCacheValid(): boolean {
    return Boolean(
      this.cachedSession && this.cachedSession.expiresAt > Date.now(),
    );
  }

  private async refresh(productUrl: string): Promise<CachedNoonSession> {
    try {
      const browserSnapshot = await this.browserSession.extract(productUrl);
      const session = this.toCachedSession(browserSnapshot);
      this.cachedSession = session;
      return session;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not extract Noon session: ${reason}`);
      throw new ServiceUnavailableException(
        'Could not establish Noon cookie session',
      );
    }
  }

  private toCachedSession(snapshot: BrowserSessionSnapshot): CachedNoonSession {
    const now = Date.now();
    const configuredExpiry =
      now +
      this.configService.get<number>(
        'NOON_COOKIE_REFRESH_MS',
        DEFAULT_SESSION_TTL_MS,
      );
    const expirySkewMs = this.configService.get<number>(
      'NOON_COOKIE_EXPIRY_SKEW_MS',
      DEFAULT_EXPIRY_SKEW_MS,
    );
    const cookieExpiry = snapshot.earliestCookieExpiry
      ? Math.max(
          now + MINIMUM_SESSION_TTL_MS,
          snapshot.earliestCookieExpiry - expirySkewMs,
        )
      : Number.POSITIVE_INFINITY;

    return {
      cookieHeader: snapshot.cookieHeader,
      userAgent: snapshot.userAgent,
      requestHeaders: snapshot.requestHeaders,
      cookieNames: snapshot.cookieNames,
      expiresAt: Math.max(
        now + MINIMUM_SESSION_TTL_MS,
        Math.min(configuredExpiry, cookieExpiry),
      ),
    };
  }

  private logSession(
    source: 'cache' | 'browser' | 'forced-refresh',
    session: CachedNoonSession,
  ): void {
    this.logger.log(
      `getSession output source=${source} userAgent=${JSON.stringify(session.userAgent)} cookieCount=${session.cookieNames.length} cookieNames=${session.cookieNames.join(',') || 'none'} cookieHeaderLength=${session.cookieHeader.length} requestHeaderKeys=${Object.keys(session.requestHeaders).join(',') || 'none'} expiresAt=${new Date(session.expiresAt).toISOString()} ttlMs=${Math.max(0, session.expiresAt - Date.now())}`,
    );
  }
}
