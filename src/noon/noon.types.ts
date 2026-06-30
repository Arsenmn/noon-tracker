export const NOON_CURRENCY = 'AED' as const;

export type NoonCurrency = typeof NOON_CURRENCY;

export interface NoonDeliveryContext {
  country: string;
  locale: string;
  zoneCode: string;
  currency: NoonCurrency;
}

export interface NormalizedNoonOffer {
  offerId: string;
  sellerId: string | null;
  sellerName: string;
  priceMinor: number;
  listPriceMinor: number;
  available: boolean;
}

export type ProductAvailability = 'available' | 'no_available_offers';

export interface NoonProductSnapshot {
  sku: string;
  title: string | null;
  canonicalUrl: string;
  fetchedAt: string;
  context: NoonDeliveryContext;
  availability: ProductAvailability;
  offers: NormalizedNoonOffer[];
}

export interface NoonProductReference {
  sku: string;
  slug: string;
  canonicalUrl: string;
  requestedOfferCode: string | null;
}
