import { join } from "node:path";
import {
  createCloakBrowserRuntime,
  createCrawlBrowserHost,
} from "./browser.js";
import { createCredentialStore } from "./credential-store.js";
import { createEnv } from "./env.js";
import { createLoginService } from "./login-runner.js";
import { createNoVncProxy } from "./novnc-proxy.js";
import { createLiveXProvider } from "./provider/live-x-provider.js";
import { createRequestGate } from "./request-gate.js";
import { createTwiteeServer } from "./server.js";

const env = createEnv(process.env);
const browserEnv = {
  CLOAKBROWSER_CACHE_DIR: env.CLOAKBROWSER_CACHE_DIR,
  CLOAKBROWSER_AUTO_UPDATE: env.CLOAKBROWSER_AUTO_UPDATE,
  TWITEE_PROFILE_ROOT: env.TWITEE_PROFILE_ROOT,
  TWITEE_HEADLESS: env.TWITEE_HEADLESS,
  TWITEE_HUMANIZE: env.TWITEE_HUMANIZE,
};
const browserRuntime = createCloakBrowserRuntime(browserEnv);
const browserHost = createCrawlBrowserHost(browserEnv);
const loginService = createLoginService({
  browserRuntime,
  credentialStore: createCredentialStore({
    path: join(env.TWITEE_DATA_DIR, "credential.json.enc"),
    encryptionKey: env.TWITEE_ENCRYPTION_KEY,
  }),
});

await browserRuntime.verifyBinary();
await browserHost.start();
await loginService.initialize();

const server = createTwiteeServer({
  apiKey: env.TWITEE_API_KEY,
  noVncBaseUrl: env.TWITEE_NOVNC_URL,
  loginService,
  provider: createLiveXProvider(),
  browserHost,
  browserReady: async () => browserHost.isConnected(),
  requestGate: createRequestGate({ maxQueued: 10, timeoutMs: 60_000 }),
});
const noVncServer = createNoVncProxy({
  loginService,
  assetRoot: "/usr/share/novnc",
  targetPort: 6081,
});

server.listen(env.PORT, "0.0.0.0");
noVncServer.listen(env.NOVNC_PORT, "0.0.0.0");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  browserHost.beginDraining();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => noVncServer.close(() => resolve())),
  ]);
  await Promise.allSettled([browserHost.close(), browserRuntime.close()]);
}

process.once("SIGINT", () => void stop().then(() => process.exit(0)));
process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
