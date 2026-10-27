# Arquitectura

## Decisión tecnológica: Electron en lugar de Tauri

El encargo prefería Tauri «si resulta adecuado». Se eligió Electron 44 por estos criterios:

- **Compatibilidad y verificabilidad.** El proyecto partía de cero. Electron permite compilar, empaquetar y **probar la app real** (Playwright `_electron`) en CI Linux y Windows con una sola pila (TypeScript). Con Tauri, la lógica de descargas, OAuth, JSON de versiones y procesos se habría tenido que escribir y probar en Rust, y WebView2 / WebKitGTK introducen diferencias de renderizado entre plataformas.
- **Seguridad.** La configuración de Electron aplicada: `contextIsolation`, `sandbox`, sin `nodeIntegration`, protocolo propio `app://` con CSP estricta (`connect-src 'none'`: la interfaz no tiene red), navegación y ventanas bloqueadas, permisos web denegados y un IPC con lista blanca y validación zod en cada canal. Las credenciales usan `safeStorage`, es decir, el almacén del sistema operativo (DPAPI en Windows).
- **Coste.** El instalador ocupa más (unos 100 MB frente a unos 10 MB) y la memoria en reposo es mayor. Se mitiga cargando las pantallas bajo demanda y sin dependencias pesadas en la interfaz: visor 3D en WebGL propio, iconos vectoriales y sin frameworks de animación.

## Capas

```
Renderer (React, sin Node) ──IPC validado──► Proceso principal ──► Sistema / red
        ▲                                         │
        └────────── eventos (progreso, social…) ◄──┘
```

- **Interfaz** (`src/renderer`): solo presentación y estado local. No tiene red, sistema de archivos ni tokens. Cada acción es una llamada `window.launcher.<ns>.<método>` que devuelve `Result<T>`.
- **Contrato** (`src/shared/api.ts`): interfaz `LauncherApi` y lista explícita de canales. Una prueba unitaria comprueba que cada canal tiene su handler.
- **Proceso principal** (`src/main`): servicios con dependencias inyectadas (`services.ts`), lo que permite instanciarlos en las pruebas sin Electron, con `fetch` y endpoints simulados.
- **Errores tipados** (`AppError` + `ErrorCode`): la interfaz traduce cada código a un mensaje que explica qué pasó y cómo recuperarse.

## Modelos de datos

- `settings.json`: esquema zod único (`src/shared/settings.ts`). Se valida al leer, al escribir y en IPC, con copia `.bak` y escritura atómica.
- `accounts.json`: solo datos públicos (nombre, UUID, tipo, skin). Los tokens están cifrados en `secrets/*.bin`.
- `instances.json`: configuración por instancia. El juego vive en `data/instances/<id>/minecraft`.
- `data/shared/{libraries,assets,versions}`: archivos direccionados por hash (SHA-1/SHA-256) y compartidos en solo lectura. Eliminar una instancia nunca toca esta carpeta. Reparar solo vuelve a descargar archivos cuyo hash no coincide.
- `grants.json`: concesiones firmadas por la autoridad (payload + firma).

## Flujo de instalación

1. Manifiesto oficial (piston-meta) → JSON de versión verificado por SHA-1.
2. Loader: perfil de Fabric (meta.fabricmc.net) o instalador oficial de Forge/NeoForge. Este último solo se ejecuta con el consentimiento explícito del usuario, desde un Maven oficial y verificado con el checksum publicado.
3. Librerías (reglas de SO, arquitectura y nativas), cliente, índice de assets y objetos: descargas concurrentes, reanudables (Range), con límite de ancho de banda, comprobación de espacio previa y verificación de hash **antes** de mover cada archivo a su destino.
4. Java: el ejecutable forzado, uno instalado compatible o Temurin descargado de Adoptium y verificado por SHA-256.
5. Instancias privadas: manifiesto pedido a la autoridad, cuyo SHA-256 debe coincidir con la concesión firmada. Los archivos se verifican por SHA-256 y solo pueden escribirse en carpetas permitidas.

Una instalación interrumpida queda marcada y el botón pasa a **Reanudar**. Los archivos ya verificados no se vuelven a descargar.

## Lanzamiento

`buildLaunchCommand` reproduce el formato oficial (`arguments` moderno y `minecraftArguments` legado, con reglas y *features*). Antes de cada lanzamiento las nativas legadas se extraen a una carpeta limpia. El proceso se lanza con `javaw` en Windows. Su salida se guarda en un búfer circular con el token redactado, y la salida del proceso se detecta aunque ocurra al instante. Si el usuario cierra el launcher con el juego abierto, se le pregunta si cerrar también Minecraft, para no dejar procesos huérfanos sin que lo sepa.

## Autoridad (`server/`)

Es un único proceso Node 22 con `node:sqlite` (WAL) y `ws`, sin endpoints de administración HTTP: la administración se hace con una CLI local. Ver [AUTORIDAD.md](AUTORIDAD.md).
