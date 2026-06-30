import {
  NoonPayloadError,
  parseAedToMinorUnits,
  parseNoonCatalogPayload,
} from '../noon-payload.parser';

describe('Noon payload parser', () => {
  it.each([
    [949, 94900],
    ['949', 94900],
    ['949.9', 94990],
    ['949.99', 94999],
    [0, 0],
  ])('converts %p AED to %p fils exactly', (input, expected) => {
    expect(parseAedToMinorUnits(input, 'price')).toBe(expected);
  });

  it.each([-1, '1.001', 'NaN', null, undefined])(
    'rejects invalid money value %p',
    (input) => {
      expect(() => parseAedToMinorUnits(input, 'price')).toThrow(
        NoonPayloadError,
      );
    },
  );

  it('rejects an offer without a stable offer identifier', () => {
    expect(() =>
      parseNoonCatalogPayload({
        product: {
          variants: [
            {
              sku: 'N1',
              offers: [{ price: 1, sale_price: null, is_buyable: true }],
            },
          ],
        },
      }),
    ).toThrow('offer_code must be a non-empty string');
  });
});
