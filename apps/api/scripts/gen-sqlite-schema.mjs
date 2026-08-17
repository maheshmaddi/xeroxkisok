// Derives prisma/schema.sqlite.prisma (local dev) from the canonical
// prisma/schema.prisma (PostgreSQL) and ensures the .local/ state dir exists.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, '..', 'prisma');
const src = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8');
const sqlite = src.replace('provider = "postgresql"', 'provider = "sqlite"');
if (sqlite === src) {
  console.error(
    'gen-sqlite-schema: did not find `provider = "postgresql"` in schema.prisma — update this script.',
  );
  process.exit(1);
}
writeFileSync(join(prismaDir, 'schema.sqlite.prisma'), sqlite);

const localDir = join(here, '..', '..', '..', '.local');
mkdirSync(localDir, { recursive: true });
mkdirSync(join(localDir, 'uploads'), { recursive: true });
console.log('Wrote prisma/schema.sqlite.prisma (provider=sqlite)');
