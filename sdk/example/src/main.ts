import { initRum, type RumBrowserClient } from '@beaconix/rum-browser';
import { createApp, defineComponent, h } from 'vue';
import './style.css';

const endpoint = element<HTMLInputElement>('endpoint');
const publicKey = element<HTMLInputElement>('public-key');
const release = element<HTMLInputElement>('release');
const status = element<HTMLParagraphElement>('status');
const start = element<HTMLButtonElement>('start');
const actionButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-action]'),
);
let client: RumBrowserClient | null = null;

start.addEventListener('click', () => {
    const endpointValue = endpoint.value.trim();
    const publicKeyValue = publicKey.value.trim();
    if (!endpointValue || !publicKeyValue) {
        setStatus('请先填写 Endpoint 和 Public Key。', true);
        return;
    }
    client?.destroy();
    try {
        client = initRum({
            endpoint: endpointValue,
            publicKey: publicKeyValue,
            release: release.value.trim() || undefined,
            dedupeWindowMs: 0,
            anonymousId: 'rum-example-browser',
            performance: {
                enabled: true,
                sampleRate: 1,
                reportResources: true,
            },
            sessionReplay: false,
        });
        actionButtons.forEach((button) => (button.disabled = false));
        setStatus(`SDK 已初始化，session=${client.getSessionId()}`);
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
    }
});

document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
        '[data-action]',
    );
    const action = button?.dataset.action;
    if (!action || !client) return;
    switch (action) {
        case 'javascript':
            setTimeout(() => {
                throw new Error(
                    'RUM example JavaScript failure token=demo-secret',
                );
            });
            break;
        case 'promise':
            void Promise.reject(
                new Error('RUM example unhandled promise rejection'),
            );
            break;
        case 'resource':
            triggerResourceFailure();
            break;
        case 'http':
            void fetch(`/__rum-example__/http-failure-${Date.now()}`, {
                method: 'POST',
            });
            break;
        case 'vue':
            triggerVueFailure(client);
            break;
        case 'manual':
            void client.captureMessage(
                'RUM example manual error password=demo',
                {
                    level: 'WARNING',
                },
            );
            break;
        case 'console':
            console.warn('RUM example breadcrumb token=demo-secret', {
                page: `${location.href}?token=secret`,
            });
            break;
        case 'route':
            history.pushState(
                {},
                '',
                `/rum-example/${Date.now()}?token=secret`,
            );
            break;
        case 'event':
            void client.captureEvent('rum_example_clicked', {
                source: 'example-page',
            });
            break;
    }
});

function triggerResourceFailure(): void {
    const script = document.createElement('script');
    script.src = `/__rum-example__/missing-${Date.now()}.js?token=secret`;
    script.async = true;
    document.head.append(script);
    script.addEventListener('error', () => script.remove(), { once: true });
}

function triggerVueFailure(rum: RumBrowserClient): void {
    const mount = document.createElement('div');
    document.body.append(mount);
    const BrokenExample = defineComponent({
        name: 'BrokenRumExample',
        setup() {
            throw new Error('RUM example Vue setup failure');
        },
        render: () => h('div'),
    });
    const app = createApp(BrokenExample);
    const uninstall = rum.installVue(app);
    try {
        app.mount(mount);
    } finally {
        window.setTimeout(() => {
            uninstall();
            app.unmount();
            mount.remove();
        });
    }
}

function setStatus(message: string, failed = false): void {
    status.textContent = message;
    status.classList.toggle('status--error', failed);
}

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing #${id}`);
    return value as T;
}
