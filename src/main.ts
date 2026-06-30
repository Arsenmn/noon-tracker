import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3000;
  app.enableShutdownHooks();
  await app.listen(port);
  console.log(`Server running on ${port}`);
}
void bootstrap();
