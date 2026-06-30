import {
  NoonPayloadError,
  parseNoonCatalogPayload,
} from './noon-payload.parser';
import {
  NoonDeliveryContext,
  NoonProductReference,
  NoonProductSnapshot,
} from './noon.types';

export function mapNoonCatalogSnapshot(
  payload: unknown,
  reference: NoonProductReference,
  context: NoonDeliveryContext,
): NoonProductSnapshot {
  const product = parseNoonCatalogPayload(payload);
  const sku = reference.sku.toLowerCase();
  const offerCode = reference.requestedOfferCode?.toLowerCase();
  const variant = product.variants.find(
    (candidate) =>
      candidate.sku.toLowerCase() === sku ||
      candidate.offers.some(
        ({ skuConfig, offer }) =>
          skuConfig?.toLowerCase() === sku ||
          (offerCode !== undefined &&
            offer.offerId.toLowerCase() === offerCode),
      ),
  );

  if (!variant) {
    throw new NoonPayloadError(
      `No variant matched catalog SKU ${reference.sku}`,
    );
  }

  const offers = variant.offers
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
}
