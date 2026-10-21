import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RecepcionController } from './recepcion.controller';
import { RecepcionService } from './recepcion.service';

@Module({
  imports: [PrismaModule],
  controllers: [RecepcionController],
  providers: [RecepcionService],
})
export class RecepcionModule {}
