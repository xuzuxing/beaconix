// Test-only driver double for real worker cancellation and teardown behavior.
class MongoClient {
    constructor(url, options) {
        this.options = options;
        this.keepAlive = setInterval(() => {}, 1000);
        if (options.directConnection !== true || options.maxPoolSize !== 1 ||
            options.retryReads !== false || options.retryWrites !== false ||
            url.includes('private-password')) {
            throw new Error('Unsafe MongoDB options');
        }
    }
    async connect() {
        await new Promise((resolve, reject) => this.options.lookup(
            'unexpected.internal', { all: true }, (error, addresses) => {
                if (error || addresses[0].address !== '127.0.0.1') reject(new Error('Unpinned lookup'));
                else resolve();
            },
        ));
        if (this.options.auth?.username === 'hang-connect') {
            await new Promise(() => {});
        }
    }
    db() {
        return { command: async (command) => {
            if (command.ping !== 1) throw new Error('Unexpected command');
            if (this.options.auth?.username === 'fail') throw new Error('private-password');
            return { ok: this.options.auth?.username === 'assertion' ? 0 : 1 };
        } };
    }
    async close() {
        if (this.options.auth?.username === 'hang-close') {
            await new Promise(() => {});
        }
        clearInterval(this.keepAlive);
    }
}
module.exports = { MongoClient };
