import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const pricing = await prisma.pricingProfile.upsert({
    where: { id: 'standard' },
    update: {},
    create: {
      id: 'standard',
      name: 'Standard',
      bwA4: 200, // ₹2 / side
      colorA4: 800, // ₹8 / side
      bwA3: 400,
      colorA3: 1500,
      photo4x6: 1500,
      passportSheet: 2000,
    },
  });

  const secret = process.env.SEED_KIOSK_SECRET ?? 'dev-secret-001';
  for (const [id, name] of [
    ['K001', 'Dev Kiosk — Local'],
    ['K002', 'Load Test Kiosk A'],
    ['K003', 'Load Test Kiosk B'],
  ] as const) {
    await prisma.kiosk.upsert({
      where: { id },
      update: {},
      create: { id, name, secretKey: bcrypt.hashSync(secret, 10), printerIp: '127.0.0.1', pricingId: pricing.id },
    });
  }

  console.log(`Seeded kiosks K001–K003 (secret: ${secret}) with pricing profile "${pricing.name}"`);
}

main().finally(() => prisma.$disconnect());
