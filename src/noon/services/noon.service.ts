import { Injectable } from '@nestjs/common';
import { NormalizedNoonOffer } from '../noon.types';

@Injectable()
export class NoonService {
  selectLeader(offers: NormalizedNoonOffer[]): NormalizedNoonOffer | null {
    const available = offers.filter((offer) => offer.available);
    if (available.length === 0) {
      return null;
    }

    return available.reduce((leader, offer) => {
      if (offer.priceMinor !== leader.priceMinor) {
        return offer.priceMinor < leader.priceMinor ? offer : leader;
      }
      return offer.offerId.localeCompare(leader.offerId) < 0 ? offer : leader;
    });
  }
}
