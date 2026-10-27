// Genera el par de claves Ed25519 para firmar manifiestos de actualización.
//   node scripts/update-keys.mjs
// - La clave PRIVADA va como secreto de GitHub Actions (UPDATE_SIGNING_KEY). Nunca al repositorio.
// - La clave PÚBLICA se añade a brand.config.json → updatePublicKeys.
import crypto from 'node:crypto';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
console.log('UPDATE_SIGNING_KEY (secreto de GitHub Actions):');
console.log(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
console.log('\nClave pública para brand.config.json → updatePublicKeys:');
console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
