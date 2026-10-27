import { createApp } from './app';
import { loadConfig } from './config';

const cfg = loadConfig();
const app = createApp(cfg);
app.server.listen(cfg.port, cfg.host, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), m: 'authority listening', d: { host: cfg.host, port: cfg.port } }));
});

const shutdown = () => {
  app.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
