import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Local-dev storage driver receives uploads as a raw body on this route
  // (in prod the browser PUTs directly to a presigned R2 URL instead).
  app.use('/jobs/:id/file', express.raw({ type: () => true, limit: '51mb' }));

  app.enableCors({ origin: true });

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`[api] listening on http://localhost:${port}`);
}

bootstrap();
