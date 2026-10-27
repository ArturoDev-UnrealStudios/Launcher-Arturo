// Proceso/hilo independiente con su propia conexión SQLite: reproduce canjes realmente concurrentes.
import crypto from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../src/db.ts';
import { KeyService } from '../src/keys.ts';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const db = openDb(workerData.dbPath);
const svc = new KeyService(db, { keyPepper: Buffer.from(workerData.pepper, 'base64'), signingKey: privateKey, grantTtlMs: 1000 });
// Pequeña barrera temporal para que todos los hilos lleguen a la vez.
const start = Date.now() + 150;
while (Date.now() < start) {}
let out = 'ok';
try {
  svc.redeem(workerData.principal, workerData.key, '127.0.0.1');
} catch (e) {
  out = e.code ?? String(e.message);
}
db.close();
parentPort.postMessage(out);
