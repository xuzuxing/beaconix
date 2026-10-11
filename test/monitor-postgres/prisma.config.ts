import { defineConfig, env } from 'prisma/config';

// Deliberately do not load dotenv or fall back to the application datasource.
export default defineConfig({
    schema: '../../prisma/schema.prisma',
    migrations: { path: env('MONITOR_TEST_MIGRATIONS_DIR') },
    datasource: { url: env('MONITOR_TEST_DATABASE_URL') },
});
