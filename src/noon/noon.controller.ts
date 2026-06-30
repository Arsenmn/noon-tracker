import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { NoonClientService } from './services/noon-client.service';
import { NoonProductSnapshot } from './noon.types';

// Create a simple DTO to enforce type safety for incoming data
export class ExtractOffersDto {
  url!: string;
}

@Controller('noon')
export class NoonController {
  constructor(private readonly noonClientService: NoonClientService) {}

  @Post('extract')
  @HttpCode(HttpStatus.OK) // Returns a 200 OK status instead of the default 201 Created for POSTs
  async testResult(
    @Body() body: ExtractOffersDto,
  ): Promise<NoonProductSnapshot> {
    // Correctly passes the complete URL string from the JSON body
    return await this.noonClientService.extractOffersFromUrl(body.url);
  }
}
