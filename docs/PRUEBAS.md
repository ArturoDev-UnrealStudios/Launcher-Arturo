# Informe de pruebas

Ejecutado el 26/10/2026 en Linux x64 (Node 22.23, Electron 44.9.3, Xvfb). Los servicios externos (Microsoft, Xbox Live, Minecraft Services, piston-meta, recursos, Fabric Meta, Adoptium, GitHub y sessionserver) se sustituyen por **servidores HTTP locales que reproducen sus APIs**. La autoridad es el código real de `server/`.

| Suite | Comando | Resultado |
|---|---|---|
| Launcher: unitarias + integración | `npm test` | **34/34** |
| Autoridad | `npm run test:server` | **8/8** |
| E2E sobre la app Electron real | `npm run test:e2e` | **17/17 pasos** (con capturas) |
| Tipos (main, preload, renderer, server) | `npm run typecheck` | sin errores |
| Smoke test del build empaquetado (`app.isPackaged = true`) | manual | arranca, carga la interfaz y escribe logs |

## Autoridad (server/test)

- ✅ Formato y normalización de claves (125 bits)
- ✅ Canje válido, concesión firmada, manifiesto con hash, reutilización por otra cuenta, idempotencia
- ✅ Clave incorrecta, expirada, revocada, agotada y bloqueo por intentos repetidos
- ✅ Revocación de concesión: manifiesto denegado y concesión listada como revocada
- ✅ **Canjes simultáneos desde 8 hilos con conexiones SQLite independientes: solo uno gana**
- ✅ Autenticación premium con `hasJoined`: desafío de un solo uso y nombre verificado; las sesiones offline no acceden al social
- ✅ Amistad, chat en tiempo real, entrega, persistencia, reconexión, paginación, no leídos, acceso no autorizado a conversaciones, bloqueo, denuncia y privacidad de presencia
- ✅ WebSocket: autenticación obligatoria (cierre 4401) y límite de frecuencia

## Launcher (test/unit)

**Autenticación**
- ✅ Login completo con PKCE, licencia verificada y perfil real. Los tokens no aparecen en archivos JSON
- ✅ Cuenta sin licencia: no se crea ni obtiene privilegios. Licencia sin perfil → `AUTH_NO_PROFILE`
- ✅ Errores XSTS (sin Xbox, cuenta infantil), cancelación y `state` manipulado
- ✅ Sesión expirada → renovación con refresh token. Refresh revocado → se exige login y se pierden los privilegios
- ✅ Offline: separado, sin privilegios premium en la lógica (skins y social rechazados), sin suplantar nombres premium, cierre de sesión que borra credenciales

**Instancias y descargas**
- ✅ Descarga verificada, omisión de archivos válidos sin peticiones y deduplicación
- ✅ Hash incorrecto: el archivo no llega a su destino
- ✅ Descarga interrumpida a mitad → reanudación con `Range`
- ✅ Falta de espacio detectada antes de descargar
- ✅ Protocolos inseguros rechazados. Límite de ancho de banda respetado. Cancelación
- ✅ Reglas de SO, arquitectura y *features*, coordenadas Maven (y su rechazo de rutas inseguras), herencia de loaders, detección de versión de Java
- ✅ Línea de comandos moderna y legada, **rutas de Windows con espacios**, separador `;`, pantalla completa
- ✅ Nativas legadas solo de la plataforma actual, extraídas y fuera del classpath
- ✅ **Instalación limpia real** (vanilla), aislamiento entre instancias, verificación que detecta corrupción, reparación, lanzamiento real de un proceso Java con argumentos correctos y token redactado del registro, eliminación sin afectar a otras instancias ni a los archivos compartidos
- ✅ Cancelación → «Reanudar», **Java incompatible**, Java automático descargado de Adoptium con SHA-256, Fabric con su perfil oficial, Forge sin consentimiento rechazado
- ✅ Exportar/importar `.unrealpack` y `.mrpack` con host no permitido (sin dejar instancias a medias)

**Claves y social (integración real con server/)**
- ✅ Canje premium (la autoridad nunca recibe el token) y offline (identidad de dispositivo), concesión firmada, instancia privada creada, instalación con manifiesto privado verificado, clave reutilizada rechazada, revocación → instancia bloqueada y lanzamiento denegado, concesión con firma ajena rechazada
- ✅ Dos launchers: búsqueda, solicitud, aceptación, presencia, mensaje en tiempo real con *ack* y entrega, historial, desconexión y reconexión con envío posterior, cuenta offline sin acceso

**Actualizador**
- ✅ Sin actualización. Nueva release firmada. Descarga verificada. Canal beta separado
- ✅ Firma inválida, manifiesto reutilizado (versión ≠ etiqueta), instalador manipulado (hash) y GitHub caído o con límite de peticiones
- ✅ Instalación (AppImage) con copia de la versión anterior y detección de fallo al reiniciar
- ✅ El script de firma de CI genera manifiestos que el launcher acepta

**Otros**
- ✅ Logger: redacción de tokens, JWT, códigos OAuth y claves. Archivo sin secretos
- ✅ JSON atómico con recuperación desde `.bak`
- ✅ Almacén seguro: cifrado con el SO; sin backend seguro no escribe nada en disco
- ✅ Configuración: memoria frente a la RAM real, argumentos JVM prohibidos, persistencia y restablecimiento
- ✅ UUID offline estándar, PKCE, Ed25519, hash `serverId` con los vectores conocidos de Minecraft
- ✅ Path traversal y zip-slip
- ✅ Contrato IPC completo
- ✅ Almacenamiento: tamaños reales por categoría; la limpieza no toca instancias ni descargas recientes; espacio liberado confirmado
- ✅ Skins: validación de PNG (dimensiones, formato y color), biblioteca, publicación solo con premium y respuesta oficial

## E2E (test/e2e/ui.e2e.ts, app Electron real)

- ✅ Inicio vacío con acción útil
- ✅ Navegación por las 8 secciones
- ✅ Perfil offline: validación de formulario y creación
- ✅ Funciones premium bloqueadas en offline (skins y social)
- ✅ Crear instancia: formulario validado y descarga con progreso real
- ✅ Jugar: lanza el proceso de Java y muestra su salida
- ✅ Validación de argumentos JVM prohibidos y guardado
- ✅ Inicio con instancia: escena, estado y disco
- ✅ Login Microsoft (PKCE) y licencia verificada
- ✅ Agregar clave: inválida, válida y desbloqueo de instancia privada
- ✅ Skins: visor 3D (WebGL), carga arrastrando un PNG y publicación premium
- ✅ Social premium conectado con la autoridad
- ✅ Almacenamiento con datos reales y revisión de limpieza
- ✅ La configuración persiste en disco: tema claro, cambio de idioma
- ✅ Modal de confirmación accesible (el foco entra, se cierra con Escape)
- ✅ Ventana pequeña (980×640) sin desbordes
- ✅ Sin errores de renderizado en consola

## Pendiente por falta de credenciales o entorno

| Prueba | Motivo | Cómo ejecutarla |
|---|---|---|
| Login con una cuenta Microsoft **real** | Requiere el `clientId` aprobado por Mojang y una cuenta | Configura `microsoft.clientId` y entra desde *Perfil* |
| Descarga y arranque de Minecraft **real** | El entorno de construcción no tenía acceso a los servidores de Mojang. La lógica se probó contra réplicas de sus APIs | Crea una instancia vanilla y pulsa Jugar |
| Instalador oficial de Forge/NeoForge real | Mismo motivo. Además el instalador necesita la red | Crea una instancia Forge ≥ 1.13 o NeoForge ≥ 1.20.2 |
| Publicación de skin real | Requiere una cuenta premium | Skins → Aplicar a mi cuenta |
| DPAPI real de Windows | El entorno era Linux sin llavero (se probó el comportamiento seguro sin backend) | Ejecuta en Windows: aparecerán `secrets/*.bin` cifrados |
| Instalador NSIS y actualización NSIS en Windows | `electron-builder` no estaba disponible sin acceso a npm | El job `build-windows` de CI lo genera |
