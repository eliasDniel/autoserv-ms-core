import { Injectable, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient {
  constructor() {
    const logger = new Logger('PrismaService');
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL as string,
    });
    logger.log('BD conectada');
    super({ adapter });
  }
}
