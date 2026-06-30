import { BadRequestException } from '@nestjs/common';
import { NoonProductReference } from './noon.types';

const ALLOWED_HOSTS = new Set(['noon.com', 'www.noon.com']);
const SKU_PATTERN = /^[A-Z0-9]+$/i;

export function parseNoonProductUrl(value: string): NoonProductReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Invalid URL format provided');
  }

  if (
    url.protocol !== 'https:' ||
    !ALLOWED_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new BadRequestException(
      'Only HTTPS product links from noon.com are allowed',
    );
  }

  // Takes pathname and returns truthy array of path elements ["uae-en", "smartphones", "iphones", ...]
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0]?.toLowerCase() !== 'uae-en') {
    throw new BadRequestException(
      'Only Noon UAE English product links are allowed',
    );
  }

  const productMarker = segments.at(-1)?.toLowerCase() === 'p';
  const sku = segments.at(-2);
  const slug = segments.at(-3);
  if (!productMarker || !sku || !slug || !SKU_PATTERN.test(sku)) {
    throw new BadRequestException(
      'Could not parse product SKU from the Noon URL',
    );
  }

  const normalizedSku = sku.toUpperCase();
  return {
    sku: normalizedSku,
    slug,
    canonicalUrl: `https://www.noon.com/uae-en/${slug}/${normalizedSku}/p/`,
    requestedOfferCode: url.searchParams.get('o'),
  };
}
