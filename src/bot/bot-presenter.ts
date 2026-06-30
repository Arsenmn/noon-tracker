import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NoonProductSnapshot, NormalizedNoonOffer } from '../noon/noon.types';

const MAX_PRICE_MINOR = 100_000_000_00;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4_000;

export function parseTargetPriceMinor(value: string): number | null {
  const normalized = value.trim().replace(/\s+/g, '').replace(',', '.');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) {
    return null;
  }
  const minor =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 && minor <= MAX_PRICE_MINOR
    ? minor
    : null;
}

export function formatPrice(priceMinor: number): string {
  return `AED ${Math.floor(priceMinor / 100)}.${String(priceMinor % 100).padStart(2, '0')}`;
}

export function productHeading(snapshot: NoonProductSnapshot): string {
  const title = snapshot.title?.trim();
  return title ? `${title}\nSKU: ${snapshot.sku}` : `SKU: ${snapshot.sku}`;
}

export function currentOfferSummary(
  snapshot: NoonProductSnapshot,
  leader: NormalizedNoonOffer,
): string {
  const availableOfferCount = snapshot.offers.filter(
    (offer) => offer.available,
  ).length;
  return [
    productHeading(snapshot),
    `Текущий лидер: ${leader.sellerName}`,
    `Цена: ${formatPrice(leader.priceMinor)}`,
    `Доступных предложений: ${availableOfferCount}`,
  ].join('\n');
}

export function offerListMessages(
  snapshot: NoonProductSnapshot,
  leader: NormalizedNoonOffer,
): string[] {
  const offers = snapshot.offers
    .filter((offer) => offer.available)
    .sort((left, right) => {
      if (left.offerId === leader.offerId) return -1;
      if (right.offerId === leader.offerId) return 1;
      return (
        left.priceMinor - right.priceMinor ||
        left.offerId.localeCompare(right.offerId)
      );
    });
  const lines = offers.map((offer, index) =>
    offer.offerId === leader.offerId
      ? `🏆 ЛИДЕР — ${offer.sellerName} — ${formatPrice(offer.priceMinor)}`
      : `${index + 1}. ${offer.sellerName} — ${formatPrice(offer.priceMinor)}`,
  );
  return chunkLines('Все доступные предложения:', lines);
}

export function chunkLines(header: string, lines: string[]): string[] {
  const messages: string[] = [];
  let current = header;
  for (const line of lines) {
    if (`${current}\n${line}`.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
      messages.push(current);
      current = `${header} (продолжение)\n${line}`;
    } else {
      current += `\n${line}`;
    }
  }
  messages.push(current);
  return messages;
}

export function noonErrorMessage(error: unknown): string {
  if (error instanceof BadRequestException) {
    return 'Ссылка не распознана. Нужна HTTPS-ссылка на товар из noon.com/uae-en.';
  }
  if (error instanceof BadGatewayException) {
    return 'Noon вернул неожиданные данные. Попробуйте этот товар позже.';
  }
  if (error instanceof ServiceUnavailableException) {
    return 'Noon сейчас недоступен. Попробуйте ещё раз через несколько минут.';
  }
  return 'Не удалось проверить товар. Попробуйте ещё раз позже.';
}
