import { defineConfig, env } from 'prisma/config';
import {
    PROJECT_ACCESS_DATABASES,
    validateProjectAccessDatabase,
    validateProjectAccessDatabaseKind,
} from './database-safety';

// No dotenv import or application datasource fallback is permitted here.
const kind = validateProjectAccessDatabaseKind(
    process.env['PROJECT_ACCESS_TEST_KIND'],
);
const database = validateProjectAccessDatabase(
    kind,
    process.env[PROJECT_ACCESS_DATABASES[kind].variable],
);

export default defineConfig({
    schema: '../../prisma/schema.prisma',
    migrations: { path: env('PROJECT_ACCESS_TEST_MIGRATIONS_DIR') },
    datasource: { url: database.connectionString },
});
