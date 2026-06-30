import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosProxyConfig } from 'axios';
import {
  NoonPayloadError,
  parseNoonCatalogPayload,
} from '../noon-payload.parser';
import {
  NOON_CURRENCY,
  NoonDeliveryContext,
  NoonProductSnapshot,
} from '../noon.types';
import { parseNoonProductUrl } from '../noon-url';
import { NoonSessionService } from './noon-session.service';

const DEFAULT_API_BASE_URL =
  'https://www.noon.com/_vs/nc/mp-customer-catalog-api';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class NoonClientService {
  private readonly logger = new Logger(NoonClientService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: NoonSessionService,
  ) {}

  private getProxy(): AxiosProxyConfig | undefined {
    const value = this.configService.get<string>('PROXY_URL');
    if (!value) {
      return undefined;
    }
    const url = new URL(value);
    return {
      protocol: url.protocol.slice(0, -1),
      host: url.hostname,
      port: Number(url.port),
      ...(url.username
        ? {
            auth: {
              username: decodeURIComponent(url.username),
              password: decodeURIComponent(url.password),
            },
          }
        : {}),
    };
  }

  private getDeliveryContext(): NoonDeliveryContext {
    return {
      country: this.configService.get<string>('NOON_COUNTRY', 'ae'),
      locale: this.configService.get<string>('NOON_LOCALE', 'en-ae'),
      zoneCode: this.configService.get<string>('NOON_ZONE_CODE', 'AE_DXB-S14'),
      currency: NOON_CURRENCY,
    };
  }

  async extractOffersFromUrl(
    publicProductUrl: string,
  ): Promise<NoonProductSnapshot> {
    const reference = parseNoonProductUrl(publicProductUrl);
    const context = this.getDeliveryContext();
    const apiBaseUrl = this.configService
      .get<string>('NOON_API_BASE_URL', DEFAULT_API_BASE_URL)
      .replace(/\/$/, '');
    const apiUrl = new URL(
      `${apiBaseUrl}/api/v3/u/${encodeURIComponent(reference.slug)}/${encodeURIComponent(reference.sku)}/p/`,
    );
    const productUrl = new URL(reference.canonicalUrl);
    if (reference.requestedOfferCode) {
      apiUrl.searchParams.set('o', reference.requestedOfferCode);
      productUrl.searchParams.set('o', reference.requestedOfferCode);
    }
    const timeout = this.configService.get<number>(
      'NOON_REQUEST_TIMEOUT_MS',
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    let payload: unknown;
    let fetched = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const session = await this.sessionService.getSession(
        productUrl.toString(),
        attempt > 1,
      );
      const headers: Record<string, string> = {
        ...session.requestHeaders,
        'User-Agent': session.userAgent,
        Cookie: session.cookieHeader,
        Referer: productUrl.toString(),
        'x-mp-country': context.country,
        'x-locale': context.locale,
        'x-ecom-zonecode': context.zoneCode,
      };
      this.logger.log(
        `Sending Noon request sku=${reference.sku} attempt=${attempt} userAgent=${JSON.stringify(session.userAgent)} cookieHeaderLength=${session.cookieHeader.length} headerKeys=${Object.keys(headers).join(',')}`,
      );

      try {
        const response = await axios.get<unknown>(apiUrl.toString(), {
          proxy: this.getProxy(),
          timeout,
          headers,
        });
        payload = response.data;
        fetched = true;
        break;
      } catch (error: unknown) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        const reason = axios.isAxiosError(error)
          ? `HTTP ${status ?? 'network error'} code=${error.code ?? 'unknown'} message=${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
        this.logger.error(
          `Noon request failed sku=${reference.sku} attempt=${attempt} type=fetch reason=${reason}`,
        );
        if (
          attempt === 1 &&
          status !== undefined &&
          [401, 403, 429, 503].includes(status)
        ) {
          this.sessionService.invalidate();
          continue;
        }
        break;
      }
    }

    if (!fetched) {
      throw new ServiceUnavailableException(
        `Could not fetch Noon product ${reference.sku}`,
      );
    }

    try {
      const product = parseNoonCatalogPayload(payload);
      const normalizedSku = reference.sku.toLowerCase();
      const normalizedOfferCode = reference.requestedOfferCode?.toLowerCase();
      const targetedVariant = product.variants.find(
        (variant) =>
          variant.sku.toLowerCase() === normalizedSku ||
          variant.offers.some(
            ({ skuConfig, offer }) =>
              skuConfig?.toLowerCase() === normalizedSku ||
              (normalizedOfferCode !== undefined &&
                offer.offerId.toLowerCase() === normalizedOfferCode),
          ),
      );

      if (!targetedVariant) {
        throw new NoonPayloadError(
          `No variant matched catalog SKU ${reference.sku}`,
        );
      }

      const offers = targetedVariant.offers
        .map(({ offer }) => offer)
        .sort(
          (left, right) =>
            left.priceMinor - right.priceMinor ||
            left.offerId.localeCompare(right.offerId),
        );

      return {
        sku: reference.sku,
        title: product.title,
        canonicalUrl: reference.canonicalUrl,
        fetchedAt: new Date().toISOString(),
        context,
        availability: offers.some((offer) => offer.available)
          ? 'available'
          : 'no_available_offers',
        offers,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Noon payload rejected sku=${reference.sku} attempt=1 type=payload reason=${reason}`,
      );
      throw new BadGatewayException(
        `Noon returned an incompatible payload for ${reference.sku}: ${reason}`,
      );
    }
  }
}
