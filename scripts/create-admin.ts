// Bootstrap the initial SUPER_ADMIN user.
// Usage: pnpm admin:create
// Required env (can be set in .env): DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
// Optional env: ADMIN_NAME (used only when the user is newly created; defaults to "Super Admin")
//
// The admin module reuses the regular `users` table: a user with
// `globalRole = SUPER_ADMIN` can access every `/api/admin/*` route.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { PrismaClient } from '../src/generated/prisma/client';

const BCRYPT_ROUNDS = 12;

async function main() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME?.trim() || 'Super Admin';

    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set.');
        process.exit(1);
    }
    if (!email) {
        console.error('ADMIN_EMAIL is not set.');
        process.exit(1);
    }
    if (!password) {
        console.error('ADMIN_PASSWORD is not set.');
        process.exit(1);
    }
    if (password.length < 8 || password.length > 72) {
        console.error('ADMIN_PASSWORD must be between 8 and 72 characters.');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    try {
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const existing = await prisma.user.findUnique({ where: { email } });

        const user = await prisma.user.upsert({
            where: { email },
            update: {
                password: hashedPassword,
                globalRole: 'SUPER_ADMIN',
                isActive: true,
                emailVerified: true,
                deletedAt: null,
            },
            create: {
                email,
                password: hashedPassword,
                name,
                globalRole: 'SUPER_ADMIN',
                isActive: true,
                emailVerified: true,
            },
        });

        const action = existing ? 'updated' : 'created';
        console.log(
            `SUPER_ADMIN ${action}: ${user.email} (id=${user.id}, globalRole=${user.globalRole}, emailVerified=${user.emailVerified})`,
        );
        console.log('You can now log in at POST /api/auth/login.');
    } finally {
        await prisma.$disconnect();
        await pool.end();
    }
}

main().catch((error) => {
    console.error('Failed to create SUPER_ADMIN:', error);
    process.exit(1);
});
