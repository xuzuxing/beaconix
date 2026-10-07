import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppController } from './app.controller';
import type { AppService } from './app.service';

describe('AppController test pages', () => {
    const controller = new AppController({} as AppService);

    it('exposes the rule engine test page data', () => {
        expect(controller.rulesTestPage()).toEqual({
            title: 'Beacon Rule Engine Test',
            apiBase: '/api',
            renderedAt: expect.any(String),
        });
    });

    it('ships the rules-test template with the expected hooks', () => {
        const templatePath = join(
            process.cwd(),
            'views',
            'rules-test.hbs',
        );

        expect(existsSync(templatePath)).toBe(true);

        const html = readFileSync(templatePath, 'utf8');
        expect(html).toContain('{{title}}');
        expect(html).toContain('{{apiBase}}');
        expect(html).toContain("data-action='create'");
        expect(html).toContain('/rule-meta');
    });
});
