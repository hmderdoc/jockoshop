// Stand-in for the one thing app/server.js uses from discord.js: `new WebhookClient({url})`,
// for the optional --discord relay. Vendoring discord.js (and its ~30 transitive deps) just to
// leave it switched off is not worth it, so the copied server requires this instead.
//
// The real server only ever constructs a WebhookClient when a --discord webhook URL is given,
// and only ever calls `.send(payload).catch(...)`. This stub keeps that contract: it never
// throws at require time, and a send resolves without doing anything (it cannot post to Discord).
class WebhookClient {
    constructor({url} = {}) {
        this.url = url;
    }

    async send(payload) {
        // no-op: the joint rig has no Discord relay. Returned promise so `.catch()` is safe.
        return {stub: true, payload};
    }

    destroy() {}
}

module.exports = {WebhookClient};
