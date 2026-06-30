import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { NoonClientService } from './services/noon-client.service';
import { NoonProductSnapshot } from './noon.types';

export class ExtractOffersDto {
  url!: string;
}

@Controller('noon')
export class NoonController {
  constructor(private readonly noonClientService: NoonClientService) {}

  @Post('extract')
  @HttpCode(HttpStatus.OK)
  async extractOffers(
    @Body() body: ExtractOffersDto,
  ): Promise<NoonProductSnapshot> {
    return this.noonClientService.extractOffersFromUrl(body.url);
  }
}
