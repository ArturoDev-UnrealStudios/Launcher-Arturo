# Repositorio de GitHub y actualizaciones automáticas

No hace falta una API propia: el launcher lee `https://api.github.com/repos/<owner>/<repo>/releases` y descarga los recursos públicos de cada release.

## Preparación (una vez)

1. Crea el repositorio y sube este proyecto.
2. Ejecuta `node scripts/update-keys.mjs`:
   - la **clave pública** va a `brand.config.json → updatePublicKeys` (puede haber varias para rotarlas);
   - la **clave privada** va a *Settings → Secrets and variables → Actions → New repository secret* con el nombre `UPDATE_SIGNING_KEY`.
3. En `brand.config.json → github` indica `owner` y `repo`.
4. *Settings → Environments → New environment* `release`: añade revisores obligatorios para que ninguna publicación ocurra sin aprobación.
5. (Opcional, recomendado) Firma de código de Windows: certificado `.pfx` en base64 como `WIN_CSC_LINK` y su contraseña como `WIN_CSC_KEY_PASSWORD`. Sin él, Windows SmartScreen avisará al instalar.
6. Tras el primer `npm install`, confirma `package-lock.json` y cambia `npm install` por `npm ci` en los flujos para tener builds reproducibles.

## Publicar una versión

```bash
npm version 1.1.0            # actualiza package.json y crea la etiqueta v1.1.0
# edita CHANGELOG.md
git push --follow-tags
```

`release.yml` entonces:

1. Comprueba que la etiqueta coincide con `package.json`.
2. Ejecuta las pruebas.
3. Compila el instalador NSIS de Windows y el AppImage de Linux.
4. En el entorno `release` (con aprobación) genera `update-manifest.json` con SHA-256 y tamaño de cada instalador, y lo firma con Ed25519 (`update-manifest.json.sig`).
5. Publica la release con todos los archivos y `SHA256SUMS.txt`.

Una etiqueta con guion (`v1.2.0-beta.1`) se publica como **prerelease** y solo la reciben quienes elijan el canal beta. Un commit en `main` o `develop` **no** llega nunca a los usuarios: solo se ejecuta CI.

## Qué comprueba el launcher antes de instalar

1. La release no es borrador y su versión es mayor que la instalada (semver).
2. Existen `update-manifest.json` y `.sig`, con tamaños razonables y descargados de dominios de GitHub.
3. La firma Ed25519 es válida con una clave pública fijada en la app.
4. `manifest.version` coincide con la etiqueta (impide reutilizar un manifiesto antiguo).
5. El instalador de la plataforma coincide en tamaño y SHA-256. Se vuelve a calcular el hash justo antes de ejecutarlo.
6. En Windows ejecuta `Setup.exe /S --updated --force-run` y se cierra. El instalador NSIS sustituye los binarios **sin tocar `%APPDATA%\Unreal Launcher`** (configuración, cuentas e instancias). En Linux reemplaza el AppImage de forma atómica y conserva el anterior como `.old`. En macOS abre el `.dmg` verificado.
7. Al reiniciar, registra el resultado. Si la versión no cambió, notifica que la actualización falló: la versión anterior sigue funcionando.

Errores HTTP, límite de peticiones (60/h sin autenticar), releases sin manifiesto, descargas interrumpidas (se reanudan) y GitHub caído se muestran como estado. El launcher sigue funcionando con la versión instalada.
