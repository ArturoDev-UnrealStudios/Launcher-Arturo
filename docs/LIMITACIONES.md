# Requisitos externos y limitaciones

## Qué funciona sin conexión

| Función | Sin conexión |
|---|---|
| Lanzar instancias ya instaladas (offline o premium con token en caché) | Sí. Con premium y el token caducado solo funciona el modo un jugador |
| Crear perfiles offline, configuración, almacenamiento, biblioteca de skins local, exportar | Sí |
| Instancias privadas ya descargadas | Sí, hasta que caduque su concesión (7 días por defecto) |
| Instalar o reparar, Java automático, login Microsoft, publicar skins | No |
| Canjear claves, amigos y chat | No (requieren la autoridad) |
| Comprobar actualizaciones | No. El launcher sigue funcionando con la versión instalada |

## Configuración pendiente (fuera del código)

1. **`microsoft.clientId`** y la **aprobación de Mojang** para la aplicación de Azure: ver [MICROSOFT_OAUTH.md](MICROSOFT_OAUTH.md).
2. **Repositorio GitHub**, clave `UPDATE_SIGNING_KEY` y `updatePublicKeys`: ver [GITHUB_RELEASES.md](GITHUB_RELEASES.md).
3. **Autoridad** desplegada con TLS, URL y clave pública en `brand.config.json`: ver [AUTORIDAD.md](AUTORIDAD.md).
4. **Certificado de firma de código** de Windows (opcional pero recomendable): sin él, SmartScreen avisa en las primeras descargas.
5. **`package-lock.json`**: ejecuta `npm install` con acceso al registro y confírmalo, para que los builds sean reproducibles.

## Limitaciones conocidas

- **Control sobre instancias privadas ya descargadas.** El bloqueo de lanzamiento tras una revocación lo aplica el cliente. Un usuario que modifique el launcher puede seguir usando los archivos que ya descargó. La autoridad sí impide nuevas descargas del manifiesto. Si los archivos están en URLs públicas, cualquiera que conozca la URL puede descargarlos: usa URLs firmadas para contenido sensible.
- **Token visible en argumentos del proceso.** Minecraft exige `--accessToken`. Ver [SEGURIDAD.md](SEGURIDAD.md).
- **Forge anterior a 1.13** (instaladores sin modo desatendido) **y Quilt** no están soportados. NeoForge se admite desde 1.20.2.
- **Game Pass:** una cuenta con perfil de Java se considera con licencia aunque no liste el entitlement. Una suscripción caducada puede conservar el perfil, y en ese caso Minecraft rechazará el juego en línea.
- **macOS:** la actualización abre el `.dmg` verificado para instalarlo manualmente. No hay paquete macOS probado.
- **Linux sin llavero** (`basic_text`): las sesiones no se recuerdan entre reinicios. Es intencionado: no se guardan secretos en texto plano.
- **Revocación de tokens de Microsoft:** las cuentas personales no ofrecen un endpoint de revocación para clientes públicos. Se borran localmente y se enlaza a la gestión de consentimientos de Microsoft.
- **Build portable entregado:** el `.exe` conserva el icono y los metadatos de Electron (no hay `rcedit` sin Wine). El instalador de CI (`electron-builder`) sí aplica icono y nombre.
- **WebGL:** si el equipo no tiene aceleración WebGL, el visor de skins muestra una vista frontal 2D en lugar del modelo 3D.
