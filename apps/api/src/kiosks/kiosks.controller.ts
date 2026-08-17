import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Public kiosk info for the user app landing screen (spec §6). */
@Controller('kiosks')
export class KiosksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id/info')
  async info(@Param('id') id: string) {
    const kiosk = await this.prisma.kiosk.findUnique({ where: { id } });
    if (!kiosk) throw new NotFoundException('Kiosk not found');
    // Public-safe fields only — no secret, no printer IP.
    return { id: kiosk.id, name: kiosk.name, status: kiosk.status };
  }
}
