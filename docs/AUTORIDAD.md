# Autoridad: claves privadas y social

Dos funciones del launcher **no pueden** ser seguras solo con datos locales:

- **Validar y revocar claves de forma global.** Un cliente modificable podría saltarse cualquier lista local.
- **Amigos y chat entre equipos.** Necesitan un punto de coordinación.

`server/` es la pieza mínima que las resuelve. Es un proceso Node 22 con SQLite (WAL) y WebSocket, sin dependencias aparte de `ws` y sin endpoints de administración por HTTP.

## Despliegue

```bash
cd server
npm install && npm run build
npm run admin -- gen-secrets        # KEY_PEPPER, SIGNING_KEY (secretos) y AUTHORITY_PUBLIC_KEY (pública)
cp .env.example .env                # pega los secretos; o usa KEY_PEPPER_FILE / SIGNING_KEY_FILE
node --env-file=.env dist/src/index.js
```

O con Docker: `docker build -t unreal-authority server && docker run -v authority:/data --env-file server/.env -p 8787:8787 unreal-authority`.

Ponlo detrás de un proxy con TLS (Caddy, Nginx, Cloudflare Tunnel) y usa `TRUST_PROXY=1`. Después, en `brand.config.json`:

```json
"authority": { "url": "https://auth.tudominio.com", "publicKeys": ["<AUTHORITY_PUBLIC_KEY>"] }
```

Haz copias de seguridad del archivo SQLite (`/data/authority.db`).

## Identidad sin recibir tokens

- **Premium:** la autoridad emite un desafío (`serverId`). El launcher llama a `sessionserver.mojang.com/session/minecraft/join` con **su** token, y la autoridad comprueba `hasJoined(username, serverId)`, igual que un servidor de Minecraft en modo online. La autoridad nunca ve ningún token.
- **Offline:** una clave Ed25519 generada en el equipo y guardada en el almacén seguro firma el desafío. Es una identidad seudónima por dispositivo y sirve **solo** para canjear claves. El social exige premium.

Las sesiones son tokens aleatorios de 256 bits y la base de datos solo guarda su SHA-256. Duran 12 h (premium) o 30 días (dispositivo).

## Instancias privadas y claves

```bash
npm run admin -- add-instance examples/instancia-vip.json        # define la instancia y su manifiesto
npm run admin -- create-keys evento-vip 50 --expires-days 30     # las claves se muestran UNA sola vez
npm run admin -- create-keys evento-vip 1 --uses 25 --note "streamer"
npm run admin -- revoke-key UNRL-XXXXX-…
npm run admin -- revoke-grant <id>
npm run admin -- events --limit 100                              # registro de seguridad
```

- Las claves son `UNRL-` + 25 símbolos base32 (125 bits) y se almacenan como `HMAC-SHA256(KEY_PEPPER, clave)`.
- El canje es una transacción `BEGIN IMMEDIATE` con incremento condicional. Una prueba lanza 8 hilos con conexiones independientes contra la misma clave y verifica que solo uno gana.
- Límites: 5 fallos por identidad y 25 por IP cada 15 minutos.
- Respuesta: una **concesión firmada** con Ed25519 (instancia, identidad, caducidad de 7 días y SHA-256 del manifiesto). El launcher la verifica con la clave pública fijada.
- El manifiesto solo se entrega a identidades con concesión activa. Los archivos que enumera pueden estar alojados en cualquier sitio (CDN, bucket, release), porque el control de acceso es independiente del alojamiento. **Limitación:** si las URLs de los archivos son públicas, quien las conozca puede descargarlos. Para material sensible, usa URLs firmadas de corta duración en tu CDN.

## Social

| Endpoint | Comprobaciones en servidor |
|---|---|
| `GET /v1/users/search?q=` | premium, 3–16 caracteres, excluye bloqueos en ambos sentidos, 30/min |
| `POST /v1/friends/requests` | no a uno mismo, no bloqueados, el destinatario acepta solicitudes, 20/h, máx. 50 pendientes. Una solicitud cruzada se acepta automáticamente |
| `…/accept`, `…/decline` | solo el destinatario (a cualquier otro se le responde 404) |
| `DELETE /v1/friends/requests/:id` | solo el remitente |
| `POST /v1/blocks` | elimina amistad y solicitudes. Bloquea mensajes, solicitudes y búsqueda |
| `GET /v1/messages/:peer` | solo participantes que sigan siendo amigos. Paginación por `before` |
| WS `send` | amistad + sin bloqueo + 1–2000 caracteres, sin caracteres de control ni de dirección bidi, 8 cada 5 s y 60/min |

El WebSocket se autentica con el **primer mensaje** (el token no va en la URL, para que no quede en logs de proxies). Usa latido cada 30 s, confirmación (`ack`), entrega (`delivered`) e indicador de escritura limitado. La presencia solo se muestra a amigos y respeta «Nadie».

## Registro

Cada petición se registra con método, ruta (con los UUID anonimizados), estado, duración y un hash truncado de la IP. Nunca se registran cuerpos, tokens ni claves.
