import { PrismaClient } from '@prisma/client';
import { databaseUrl } from '../../config/database';

export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } }
});
