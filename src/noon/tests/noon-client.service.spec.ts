import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { NoonClientService } from '../services/noon-client.service';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'),
  ) as unknown;
}

describe('NoonClientService', () => {
  const getSession = jest.fn();
  const invalidate = jest.fn();

  const createService = (): NoonClientService =>
    new NoonClientService(
      new ConfigService({
        NOON_ZONE_CODE: 'AE_DXB-S14',
        NOON_REQUEST_TIMEOUT_MS: 5000,
      }),
      { getSession, invalidate } as never,
    );

  beforeEach(() => {
    jest.restoreAllMocks();
    getSession.mockReset().mockResolvedValue({
      cookieHeader: 'visitor_id=test; anti_bot=test',
      userAgent: 'Browser User Agent',
      requestHeaders: {
        accept: 'application/json',
        'sec-ch-ua': 'Captured client hint',
        'x-lat': '251998495',
      },
    });
    invalidate.mockReset();
  });

  it('returns a validated product snapshot with exact minor-unit prices', async () => {
    const getSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: fixture('catalog-phone.json'),
    });

    const result = await createService().extractOffersFromUrl(
      'https://www.noon.com/uae-en/anonymized-phone/N70164930V/p/?o=offer-b&utm_source=test',
    );

    const { fetchedAt, ...snapshot } = result;
    expect(Number.isNaN(Date.parse(fetchedAt))).toBe(false);
    expect(snapshot).toEqual({
      sku: 'N70164930V',
      title: 'Anonymized smartphone',
      canonicalUrl:
        'https://www.noon.com/uae-en/anonymized-phone/N70164930V/p/',
      context: {
        country: 'ae',
        locale: 'en-ae',
        zoneCode: 'AE_DXB-S14',
        currency: 'AED',
      },
      availability: 'available',
      offers: [
        {
          offerId: 'offer-b',
          sellerId: 'seller-a',
          sellerName: 'Seller A',
          priceMinor: 94900,
          listPriceMinor: 129900,
          available: true,
        },
        {
          offerId: 'offer-a',
          sellerId: 'seller-b',
          sellerName: 'Seller B',
          priceMinor: 99999,
          listPriceMinor: 99999,
          available: true,
        },
      ],
    });
    const [calledUrl, calledConfig] = getSpy.mock.calls[0];
    expect(calledUrl).toContain(
      '/api/v3/u/anonymized-phone/N70164930V/p/?o=offer-b',
    );
    expect(calledConfig?.timeout).toBe(5000);
    expect(calledConfig?.headers?.Cookie).toBe(
      'visitor_id=test; anti_bot=test',
    );
    expect(calledConfig?.headers?.['User-Agent']).toBe('Browser User Agent');
    expect(calledConfig?.headers?.['sec-ch-ua']).toBe('Captured client hint');
    expect(calledConfig?.headers?.['x-lat']).toBe('251998495');
  });

  it('keeps unavailable offers and reports a successful empty availability state', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: fixture('catalog-headphones-unavailable.json'),
    });

    const result = await createService().extractOffersFromUrl(
      'https://www.noon.com/uae-en/anonymized-headphones/N00000002A/p/',
    );

    expect(result.availability).toBe('no_available_offers');
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].available).toBe(false);
  });

  it('reports incompatible payloads separately from upstream failures', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { product: {} } });

    await expect(
      createService().extractOffersFromUrl(
        'https://www.noon.com/uae-en/anonymized/N00000002A/p/',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('reports network failures as service unavailable', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('socket closed'));

    await expect(
      createService().extractOffersFromUrl(
        'https://www.noon.com/uae-en/anonymized/N00000002A/p/',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
