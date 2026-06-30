import { BadRequestException } from '@nestjs/common';
import { parseNoonProductUrl } from '../noon-url';

describe('parseNoonProductUrl', () => {
  it('canonicalizes a UAE URL by SKU and removes tracking parameters', () => {
    expect(
      parseNoonProductUrl(
        'https://noon.com/uae-en/item/N70164930V/p/?utm_source=x&o=offer-1',
      ),
    ).toEqual({
      sku: 'N70164930V',
      slug: 'item',
      canonicalUrl: 'https://www.noon.com/uae-en/item/N70164930V/p/',
      requestedOfferCode: 'offer-1',
    });
  });

  it.each([
    'https://example.com/uae-en/item/N70164930V/p/',
    'http://noon.com/uae-en/item/N70164930V/p/',
    'https://noon.com/saudi-en/item/N70164930V/p/',
    'https://noon.com/uae-en/not-a-product',
  ])('rejects non-UAE Noon product URL %s', (url) => {
    expect(() => parseNoonProductUrl(url)).toThrow(BadRequestException);
  });
});
