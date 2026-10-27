# Configurar el inicio de sesión con Microsoft

El launcher es un **cliente público** (no guarda ningún *client secret*). Usa Authorization Code con PKCE, y la respuesta vuelve a un servidor *loopback* en `http://localhost:<puerto aleatorio>/auth/callback`.

## 1. Registrar la aplicación en Azure

1. En <https://portal.azure.com> abre **Microsoft Entra ID → Registros de aplicaciones → Nuevo registro**.
2. Nombre: el de tu launcher.
3. Tipos de cuenta admitidos: **Solo cuentas personales de Microsoft** (el launcher usa el inquilino `consumers`).
4. URI de redirección: plataforma **Cliente público/nativo (móvil y escritorio)**, valor `http://localhost`. Microsoft acepta cualquier puerto para `localhost` en clientes públicos.
5. En **Autenticación → Configuración avanzada**, activa **Permitir flujos de cliente público**.
6. No crees secretos ni certificados: no hacen falta y no deben ir en un cliente distribuido.
7. Copia el **Id. de aplicación (cliente)** a `brand.config.json → microsoft.clientId`.

Los ámbitos que se piden son `XboxLive.signin offline_access`.

## 2. Pedir permiso a Mojang para usar la API de Minecraft

Las aplicaciones de Azure nuevas **deben solicitar permiso** para usar `api.minecraftservices.com`. El formulario es <https://aka.ms/mce-reviewappid>. Mientras no esté aprobada, el paso `login_with_xbox` responde 403 y el launcher muestra: *«Esta aplicación aún no está aprobada por Mojang para usar Minecraft Services»* (`AUTH_APP_NOT_APPROVED`).

## 3. Cadena de autenticación implementada

| Paso | Endpoint | Errores tratados |
|---|---|---|
| Autorización | `login.microsoftonline.com/consumers/oauth2/v2.0/authorize` (PKCE S256, `state`) | cancelación, `access_denied`, `state` manipulado, tiempo de espera (5 min) |
| Token | `…/oauth2/v2.0/token` | `invalid_grant` → sesión caducada; `invalid_client` → no configurado |
| Xbox Live | `user.auth.xboxlive.com/user/authenticate` | — |
| XSTS | `xsts.auth.xboxlive.com/xsts/authorize` (`rp://api.minecraftservices.com/`) | 2148916233 sin cuenta Xbox; 2148916235 región; 2148916236–8 cuenta infantil |
| Minecraft | `api.minecraftservices.com/authentication/login_with_xbox` | 403 → app no aprobada |
| Licencia | `/entitlements/mcstore` + `/minecraft/profile` | sin licencia; licencia sin perfil creado |

Las cuentas de Game Pass pueden no mostrar el entitlement, pero tienen perfil de Java. El launcher acepta la cuenta si existe el entitlement **o** el perfil, y rechaza las cuentas que no tienen ni lo uno ni lo otro. No se acepta nunca un UUID o perfil proporcionado por el usuario.

## Cierre de sesión

Se borran del equipo el refresh token cifrado, el token de Minecraft y la sesión con la autoridad. Las cuentas personales de Microsoft no ofrecen un endpoint para revocar el refresh token de un cliente público, así que desde la configuración se enlaza a <https://account.live.com/consent/Manage> para retirar el permiso a la aplicación.

Referencias: [Microsoft Authentication Scheme (wiki)](https://minecraft.wiki/w/Minecraft_Wiki:Projects/wiki.vg_merge/Microsoft_Authentication_Scheme), [minecraft-launcher-lib: Microsoft login](https://minecraft-launcher-lib.readthedocs.io/en/7.0/_sources/tutorial/microsoft_login.rst.txt).
