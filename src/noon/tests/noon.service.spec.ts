import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNoonCatalogPayload } from '../noon-payload.parser';
import { NoonService } from '../services/noon.service';

describe('NoonService', () => {
  it('selects equal-price leaders deterministically by offer ID', () => {
    const raw = JSON.parse(
      readFileSync(
        join(__dirname, '..', 'fixtures', 'catalog-monitor-equal-price.json'),
        'utf8',
      ),
    ) as unknown;
    const product = parseNoonCatalogPayload(raw);
    const offers = product.variants[0].offers.map(({ offer }) => offer);

    expect(new NoonService().selectLeader(offers)?.offerId).toBe('offer-a');
  });

  it('ignores unavailable offers and returns null when none are available', () => {
    expect(
      new NoonService().selectLeader([
        {
          offerId: 'offer-a',
          sellerId: 'seller-a',
          sellerName: 'Seller A',
          priceMinor: 100,
          listPriceMinor: 100,
          available: false,
        },
      ]),
    ).toBeNull();
  });
});
