# Unreal Launcher

Launcher de escritorio para Minecraft Java Edition. Está hecho con Electron, React y TypeScript, e incluye una autoridad mínima (Node.js, SQLite y WebSocket) para las funciones que requieren un servidor de confianza.

| Función | Estado | Requiere conexión |
|---|---|---|
| Cuentas Microsoft (OAuth 2.0 + PKCE → Xbox Live → XSTS → Minecraft Services), licencia verificada | Implementado y probado contra APIs simuladas | Sí (inicio de sesión y renovación) |
| Modo offline separado, sin privilegios premium | Implementado y probado | No |
| Instancias Vanilla, Fabric, Forge ≥ 1.13 y NeoForge ≥ 1.20.2: instalación, verificación, reparación, lanzamiento, importar/exportar (`.unrealpack`, `.mrpack`) | Implementado y probado (Vanilla y Fabric de extremo a extremo; Forge y NeoForge con el instalador oficial) | Para instalar; jugar no la necesita |
| Java automático (detección + Eclipse Temurin vía Adoptium, SHA-256) | Implementado y probado | Solo para descargar |
| Claves para instancias privadas (concesiones firmadas con Ed25519, canje atómico, revocación) | Implementado y probado | Sí (autoridad) |
| Skins premium (vista 3D, biblioteca, publicación vía Minecraft Services) | Implementado y probado | Para publicar |
| Social premium (amigos, chat en tiempo real, bloqueo, denuncias) | Implementado y probado | Sí (autoridad) |
| Almacenamiento (datos reales del disco y limpieza segura) | Implementado y probado | No |
| Actualizaciones desde GitHub Releases (manifiesto firmado con Ed25519 + SHA-256) | Implementado y probado | Sí (GitHub) |

Los resultados exactos de las pruebas están en [docs/PRUEBAS.md](docs/PRUEBAS.md). Lo que falta configurar fuera del código está en [docs/LIMITACIONES.md](docs/LIMITACIONES.md).

## Puesta en marcha

Requisitos: Node.js 22 o superior.

```bash
npm install
npm install --prefix server
npm start                 # compila en modo desarrollo y abre la app
npm test                  # pruebas unitarias y de integración del launcher
npm run test:server       # pruebas de la autoridad
npm run build && npm run test:e2e   # prueba E2E de la app real (en Linux: xvfb-run -a)
npm run dist:win          # instalador NSIS de Windows en release/
```

## Configuración obligatoria antes de publicar

Toda la configuración de marca y servicios está en `brand.config.json`. Ninguno de sus valores es secreto.

1. **Microsoft**: registra la aplicación en Azure y pide a Mojang que la apruebe (ver [docs/MICROSOFT_OAUTH.md](docs/MICROSOFT_OAUTH.md)). Después pon el `clientId`.
2. **Actualizaciones**: ejecuta `node scripts/update-keys.mjs`. La clave pública va en `updatePublicKeys`; la privada, en el secreto `UPDATE_SIGNING_KEY` de GitHub. Indica también `github.owner` y `github.repo` (ver [docs/GITHUB_RELEASES.md](docs/GITHUB_RELEASES.md)).
3. **Autoridad** (claves y social): despliega `server/` y pon su URL y su clave pública en `authority` (ver [docs/AUTORIDAD.md](docs/AUTORIDAD.md)).
4. **Marca**: cambia `productName`, `appId`, `colors` y los iconos de `build/` y `src/renderer/assets/`.

Si falta alguna de estas piezas, la función correspondiente aparece como «no configurada» en la interfaz. Nunca se simula.

## Estructura

```
brand.config.json        marca y servicios (centralizado)
src/shared/              tipos, contrato IPC, errores tipados, esquema de configuración
src/main/                proceso principal (toda la lógica y la seguridad)
  auth/                  Microsoft OAuth (PKCE), cadena Xbox/XSTS/Minecraft, cuentas
  authority/             cliente de la autoridad (join/hasJoined, identidad de dispositivo)
  config/                configuración validada, límites de memoria, argumentos JVM
  core/                  logger con redacción, JSON atómico, HTTP, rutas, ZIP seguro
  download/              descargas concurrentes, reanudables y verificadas
  instances/             gestor de instancias, procesos, importar/exportar
  keys/                  concesiones firmadas e instancias privadas
  minecraft/             metadatos, reglas, loaders, Java, instalación y línea de comandos
  security/              almacén seguro del SO (DPAPI/Keychain/libsecret), criptografía
  skins/ social/ storage/ updater/
src/preload/             puente mínimo (lista blanca de canales)
src/renderer/            interfaz React: sistema de diseño, pantallas, visor 3D WebGL
server/                  autoridad: claves, sesiones, amigos, chat (SQLite + WebSocket)
test/unit/               34 pruebas (node:test), incluida la integración real con server/
test/e2e/                17 pasos E2E sobre la app Electron real (Playwright)
.github/workflows/       CI (pruebas + E2E + instalador) y Release (firma + publicación)
docs/                    arquitectura, seguridad, OAuth, releases, autoridad, pruebas, límites, diseño
```
