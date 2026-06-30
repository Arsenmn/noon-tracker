import { NormalizedNoonOffer } from './noon.types';

export class NoonPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = NoonPayloadError.name;
  }
}

interface ParsedNoonOffer {
  skuConfig: string | null;
  offer: NormalizedNoonOffer;
}

export interface ParsedNoonVariant {
  sku: string;
  offers: ParsedNoonOffer[];
}

export interface ParsedNoonProduct {
  sku: string | null;
  title: string | null;
  variants: ParsedNoonVariant[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NoonPayloadError(`${path}.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new NoonPayloadError(`${path}.${field} must be a string or null`);
  }
  return value;
}

/** Converts an AED decimal to fils without binary floating-point arithmetic. */
export function parseAedToMinorUnits(value: unknown, path: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new NoonPayloadError(`${path} must be a decimal number`);
  }

  const decimal = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) {
    throw new NoonPayloadError(
      `${path} must be a non-negative AED amount with at most 2 decimals`,
    );
  }

  const minor = Number(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
  if (!Number.isSafeInteger(minor)) {
    throw new NoonPayloadError(`${path} exceeds the supported money range`);
  }
  return minor;
}

function parseOffer(value: unknown, path: string): ParsedNoonOffer {
  if (!isRecord(value)) {
    throw new NoonPayloadError(`${path} must be an object`);
  }

  const available = value.is_buyable;
  if (typeof available !== 'boolean') {
    throw new NoonPayloadError(`${path}.is_buyable must be a boolean`);
  }

  const listPriceMinor = parseAedToMinorUnits(value.price, `${path}.price`);
  const salePrice = value.sale_price;
  const priceMinor =
    salePrice === undefined || salePrice === null
      ? listPriceMinor
      : parseAedToMinorUnits(salePrice, `${path}.sale_price`);

  return {
    skuConfig: optionalString(value, 'sku_config', path),
    offer: {
      offerId: requiredString(value, 'offer_code', path),
      sellerId: optionalString(value, 'partner_code', path),
      sellerName: optionalString(value, 'store_name', path) ?? 'Unknown Seller',
      priceMinor,
      listPriceMinor,
      available,
    },
  };
}

export function parseNoonCatalogPayload(payload: unknown): ParsedNoonProduct {
  if (!isRecord(payload) || !isRecord(payload.product)) {
    throw new NoonPayloadError('payload.product must be an object');
  }

  const product = payload.product;
  if (!Array.isArray(product.variants)) {
    throw new NoonPayloadError('payload.product.variants must be an array');
  }

  return {
    sku: optionalString(product, 'sku', 'payload.product'),
    title: optionalString(product, 'product_title', 'payload.product'),
    variants: product.variants.map((variant, variantIndex) => {
      const path = `payload.product.variants[${variantIndex}]`;
      if (!isRecord(variant)) {
        throw new NoonPayloadError(`${path} must be an object`);
      }
      if (!Array.isArray(variant.offers)) {
        throw new NoonPayloadError(`${path}.offers must be an array`);
      }
      return {
        sku: requiredString(variant, 'sku', path),
        offers: variant.offers.map((offer, offerIndex) =>
          parseOffer(offer, `${path}.offers[${offerIndex}]`),
        ),
      };
    }),
  };
}
