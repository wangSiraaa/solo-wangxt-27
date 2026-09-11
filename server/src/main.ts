import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();

  // 生产模式：托管 Vue 构建产物（先执行 npm run build --prefix client）
  const clientDist = join(__dirname, '..', '..', 'client', 'dist');
  if (existsSync(clientDist)) {
    app.useStaticAssets(clientDist);
    const http = app.getHttpAdapter().getInstance();
    http.use((req: any, res: any, next: any) =>
      req.path.startsWith('/api') || req.method !== 'GET'
        ? next()
        : res.sendFile(join(clientDist, 'index.html')),
    );
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`lab-lims server listening on http://localhost:${port}`);
}

bootstrap();
