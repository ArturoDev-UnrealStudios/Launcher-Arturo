# Seguridad y modelo de amenazas

## Qué se protege

| Activo | Dónde vive | Protección |
|---|---|---|
| Refresh token de Microsoft y token de Minecraft | `userData/secrets/ms-*.bin` | Cifrado con el almacén del SO (`safeStorage`: DPAPI, Keychain, libsecret). Si no hay backend seguro (por ejemplo `basic_text` en Linux) **no se escribe nada en disco** y la interfaz lo advierte |
| Sesión con la autoridad y clave Ed25519 del dispositivo | `secrets/authority-*.bin`, `secrets/device-key.bin` | Igual que lo anterior |
| Contraseña de Microsoft | Nunca la ve el launcher | Login en el navegador del sistema (RFC 8252) con PKCE S256, `state` comparado en tiempo constante y servidor *loopback* efímero en 127.0.0.1 |
| Claves de canje | Solo en la autoridad, como `HMAC-SHA256(pepper, clave)` | 125 bits de entropía, límite de intentos, canje transaccional con incremento condicional y registro de eventos que guarda solo el prefijo |
| Integridad de archivos del juego | Disco | SHA-1/SHA-256/SHA-512 verificados antes de colocar cada archivo. Solo se descarga por HTTPS y se protege contra *zip-slip*, enlaces simbólicos y *zip bombs* |
| Actualizaciones del launcher | GitHub Releases | Manifiesto firmado con Ed25519 (clave pública fijada en la app), versión del manifiesto igual a la etiqueta (anti-reutilización), SHA-256 y tamaño del instalador, verificados de nuevo justo antes de ejecutarlo |
| Privilegios premium (skins, social) | Proceso principal y autoridad | Se derivan de un token válido de Minecraft Services y, en la autoridad, de `hasJoined`. No existe un booleano editable que los conceda |

## Atacantes considerados

1. **Red hostil (MITM, DNS).** TLS en todas las descargas, firmas Ed25519 en concesiones y actualizaciones, y hashes oficiales. Un servidor falso no puede fabricar concesiones ni actualizaciones.
2. **Servidor de descargas comprometido** (mirror, CDN). Los hashes vienen de manifiestos oficiales o firmados, así que un archivo alterado se descarta.
3. **Otro usuario del equipo sin privilegios.** Los secretos están cifrados por el SO y ligados a la cuenta del usuario. Los archivos de secretos se crean con permisos 0600 donde el SO los aplica.
4. **Contenido web malicioso en la interfaz.** No hay `nodeIntegration`, el sandbox está activo, la CSP es estricta, la interfaz no tiene red y React escapa todo el texto de los mensajes. Cada IPC comprueba el remitente y valida los argumentos.
5. **Abuso del servicio social o de claves.** Límites de frecuencia por usuario e IP, tamaño máximo de mensajes, permisos comprobados en cada operación y bloqueos bidireccionales.

## Qué ocurre si…

- **…se modifica el ejecutable.** El atacante controla el cliente: puede saltarse cualquier comprobación *local*, como el bloqueo de una instancia privada ya descargada. Lo que **no** puede hacer es obtener tokens de terceros, fabricar concesiones válidas, falsificar `hasJoined` ante la autoridad ni publicar una actualización firmada. Por eso los permisos reales (social y manifiestos privados) los decide la autoridad.
- **…el usuario es administrador.** Puede leer la memoria del proceso y los secretos descifrados de *su* cuenta. Cifrar no protege frente al propietario del equipo cuando el launcher necesita descifrar para funcionar, y no se afirma lo contrario.
- **…se filtra la clave de firma de actualizaciones.** Se rota publicando una versión con la nueva clave pública en `updatePublicKeys` (se admiten varias) y retirando la antigua en la siguiente.
- **…se filtra `KEY_PEPPER` de la autoridad.** Hay que regenerar las claves pendientes: los verificadores dejan de ser seguros ante ataques de diccionario. Las concesiones ya emitidas siguen siendo válidas porque están firmadas con `SIGNING_KEY`.

## Revocación de claves

`npm run admin -- revoke-key UNRL-…` o `revoke-grant <id>`. Los launchers renuevan sus concesiones al iniciar y cada 6 horas: una revocación bloquea la instancia (`INSTANCE_LOCKED`) y la autoridad deja de servir su manifiesto. Sin conexión, la concesión sigue siendo válida hasta su `expiresAt` (7 días por defecto). Este es el periodo de gracia máximo.

## Qué se envía por la red

- **Microsoft, Xbox y Minecraft Services:** el flujo oficial. La skin solo se envía al publicarla.
- **sessionserver.mojang.com:** `join` con el token propio y un `serverId` aleatorio (igual que al entrar en un servidor).
- **Autoridad:** nombre de usuario de Minecraft, UUID (obtenido por `hasJoined`), clave pública del dispositivo en modo offline, claves canjeadas, amigos y mensajes. **Nunca** el token de Minecraft ni el de Microsoft.
- **Adoptium, Fabric, Forge, NeoForge y piston-meta:** solo peticiones de metadatos y archivos.
- **GitHub API:** lista de releases (sin token).
- **Telemetría:** ninguna.

## Qué se guarda localmente

Configuración, cuentas (datos públicos), secretos cifrados, instancias, la caché de metadatos, la biblioteca de skins, las concesiones firmadas, notificaciones y logs (10 días de rotación).

## Política de logs

`core/logger.ts` redacta antes de escribir: JWT, `Bearer`/`XBL3.0`, parámetros OAuth (`code`, `state`, `*_token`), claves JSON sensibles (`accessToken`, `refresh_token`…), `--accessToken` en líneas de comandos, tokens `M.C…` de Microsoft y claves `UNRL-…` (de las que solo se conserva el prefijo). La salida del juego se redacta con el token exacto de la sesión. La exportación de logs aplica una segunda pasada de redacción. Hay pruebas que verifican todo esto.

## Limitación inherente de Minecraft

El juego **exige** recibir el token de acceso como argumento (`--accessToken`), así que es visible en la lista de procesos para el propio usuario y para administradores mientras el juego está abierto. No se puede evitar sin modificar el juego. Se mitiga redactándolo de todos los logs y usando tokens de Minecraft, que caducan en 24 h y no permiten cambiar la cuenta Microsoft.

## Argumentos JVM

Están prohibidos `-javaagent`, `-agentlib`/`-agentpath`, `-Xbootclasspath`, `-XX:OnError`/`OnOutOfMemoryError`, `-cp`/`-jar`, `@argfiles`, `java.library.path` y `-Xmx`/`-Xms` (la memoria tiene sus propios controles validados frente a la RAM del equipo). Además se eliminan `JAVA_TOOL_OPTIONS` y `_JAVA_OPTIONS` del entorno del juego.

## Gestión de vulnerabilidades

Las correcciones se publican como release firmada. El canal estable solo instala releases no marcadas como prerelease. Para reportes, se recomienda activar *Private vulnerability reporting* en el repositorio de GitHub.
