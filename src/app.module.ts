import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { RecepcionModule } from './recepcion/recepcion.module';

@Module({
  imports: [PrismaModule, RecepcionModule],
})
export class AppModule {}