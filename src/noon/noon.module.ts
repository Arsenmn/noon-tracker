import { Module } from '@nestjs/common';
import { NoonService } from './services/noon.service';
import { NoonController } from './noon.controller';
import { NoonClientService } from './services/noon-client.service';
import { ConfigModule } from '@nestjs/config';
import { NoonSessionService } from './services/noon-session.service';
import { NoonBrowserSessionService } from './services/noon-browser-session.service';

@Module({
  imports: [ConfigModule],
  controllers: [NoonController],
  providers: [
    NoonService,
    NoonClientService,
    NoonSessionService,
    NoonBrowserSessionService,
  ],
  exports: [NoonClientService, NoonService],
})
export class NoonModule {}
