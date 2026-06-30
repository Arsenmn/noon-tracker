import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MonitoredProductDocument = HydratedDocument<MonitoredProduct>;

@Schema({ collection: 'monitored_products', timestamps: true })
export class MonitoredProduct {
  @Prop({ required: true, unique: true })
  sku: string;

  @Prop({ required: true })
  canonicalUrl: string;

  @Prop({ type: String, default: null })
  title: string | null;

  @Prop({ required: true })
  availability: string;

  @Prop({ type: [Object], default: [] })
  offers: Array<{
    offerId: string;
    sellerId: string | null;
    sellerName: string;
    priceMinor: number;
    listPriceMinor: number;
    available: boolean;
  }>;

  @Prop({ required: true })
  lastSuccessfulCheckAt: Date;
}

export const MonitoredProductSchema =
  SchemaFactory.createForClass(MonitoredProduct);
