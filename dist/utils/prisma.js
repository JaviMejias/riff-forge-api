"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
exports.prisma = new client_1.PrismaClient(process.env.DATABASE_URL ? {
    datasources: { db: { url: process.env.DATABASE_URL } }
} : undefined);
