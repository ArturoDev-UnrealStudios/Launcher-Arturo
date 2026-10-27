import { AppError } from '../../shared/errors';
import type { SkinVariant } from '../../shared/types';
import { Http, httpError } from '../core/http';
import { dashUuid } from '../security/crypto';

/**
 * Cadena oficial: token Microsoft → Xbox Live (XBL) → XSTS (relying party de Minecraft)
 * → Minecraft Services (login_with_xbox) → entitlements → perfil.
 */
export interface McEndpoints {
  xbl: string;
  xsts: string;
  mcLogin: string;
  entitlements: string;
  profile: string;
  skins: string;
}

export const MC_ENDPOINTS: McEndpoints = {
  xbl: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  entitlements: 'https://api.minecraftservices.com/entitlements/mcstore',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
  skins: 'https://api.minecraftservices.com/minecraft/profile/skins',
};

export interface McProfile {
  uuid: string;
  name: string;
  skin?: { url: string; variant: SkinVariant };
}

export interface McSession {
  accessToken: string;
  expiresAt: number;
  profile: McProfile;
  licensed: true;
}

interface XboxAuthResponse {
  Token: string;
  DisplayClaims: { xui: Array<{ uhs: string }> };
}

const XSTS_ERRORS: Record<string, ConstructorParameters<typeof AppError>[0]> = {
  '2148916233': 'AUTH_NO_XBOX_ACCOUNT',
  '2148916235': 'AUTH_XBOX_REGION',
  '2148916236': 'AUTH_XBOX_CHILD', // verificación de edad (Corea)
  '2148916237': 'AUTH_XBOX_CHILD',
  '2148916238': 'AUTH_XBOX_CHILD',
};

export class MinecraftServices {
  constructor(private readonly http: Http, private readonly ep: McEndpoints = MC_ENDPOINTS) {}

  private async xboxPost(url: string, body: unknown): Promise<XboxAuthResponse> {
    const res = await this.http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-xbl-contract-version': '1' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      const j = (await res.json().catch(() => ({}))) as { XErr?: number | string };
      const code = XSTS_ERRORS[String(j.XErr ?? '')];
      throw new AppError(code ?? 'AUTH_DENIED', `xbox ${j.XErr ?? 401}`);
    }
    if (!res.ok) throw httpError(url, res.status);
    const json = (await res.json()) as XboxAuthResponse;
    if (!json?.Token || !json.DisplayClaims?.xui?.[0]?.uhs) throw new AppError('AUTH_DENIED', 'xbox: respuesta incompleta');
    return json;
  }

  async authenticate(msAccessToken: string): Promise<McSession> {
    const xbl = await this.xboxPost(this.ep.xbl, {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    });
    const xsts = await this.xboxPost(this.ep.xsts, {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
    const uhs = xsts.DisplayClaims.xui[0]!.uhs;

    const loginRes = await this.http.request(this.ep.mcLogin, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }),
    });
    if (loginRes.status === 403) {
      // Las aplicaciones Azure nuevas deben ser aprobadas por Mojang para usar esta API.
      throw new AppError('AUTH_APP_NOT_APPROVED', 'login_with_xbox 403');
    }
    if (!loginRes.ok) throw httpError(this.ep.mcLogin, loginRes.status);
    const login = (await loginRes.json()) as { access_token: string; expires_in: number };
    if (!login.access_token) throw new AppError('AUTH_DENIED', 'mc login sin token');

    const mcToken = login.access_token;
    const expiresAt = Date.now() + (login.expires_in ?? 86400) * 1000;
    const [ownsGame, profile] = await Promise.all([this.ownsGame(mcToken), this.profile(mcToken)]);

    if (!profile) {
      // Con licencia pero sin perfil creado: el usuario debe elegir nombre en minecraft.net.
      throw new AppError(ownsGame ? 'AUTH_NO_PROFILE' : 'AUTH_NO_LICENSE');
    }
    // Licencia válida = entitlement de Minecraft presente, o perfil de Java existente (las cuentas
    // de Game Pass no siempre listan el entitlement pero sí tienen perfil). Ver docs/LIMITATIONS.md.
    if (!ownsGame && !profile) throw new AppError('AUTH_NO_LICENSE');
    return { accessToken: mcToken, expiresAt, profile, licensed: true };
  }

  async ownsGame(mcToken: string): Promise<boolean> {
    const json = await this.http.json<{ items?: Array<{ name: string }> }>(this.ep.entitlements, {
      headers: { authorization: `Bearer ${mcToken}`, accept: 'application/json' },
    });
    const names = new Set((json.items ?? []).map((i) => i.name));
    return names.has('product_minecraft') || names.has('game_minecraft');
  }

  async profile(mcToken: string): Promise<McProfile | null> {
    const res = await this.http.request(this.ep.profile, {
      headers: { authorization: `Bearer ${mcToken}`, accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new AppError('AUTH_EXPIRED', 'profile 401');
    if (!res.ok) throw httpError(this.ep.profile, res.status);
    return parseProfile(await res.json());
  }

  /** Publica una skin en la cuenta autenticada (endpoint oficial de Minecraft Services). */
  async uploadSkin(mcToken: string, png: Buffer, variant: SkinVariant): Promise<McProfile> {
    const form = new FormData();
    form.set('variant', variant);
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'skin.png');
    const res = await this.http.request(this.ep.skins, {
      method: 'POST',
      headers: { authorization: `Bearer ${mcToken}`, accept: 'application/json' },
      body: form,
    }, { retries: 0 });
    if (res.status === 401) throw new AppError('AUTH_EXPIRED', 'skins 401');
    if (res.status === 400) throw new AppError('SKIN_INVALID', 'rechazada por Minecraft Services');
    if (res.status === 429) throw new AppError('RATE_LIMITED', 'skins 429');
    if (!res.ok) throw httpError(this.ep.skins, res.status);
    const p = parseProfile(await res.json());
    if (!p.skin) throw new AppError('UNKNOWN', 'el servicio no devolvió la skin activa');
    return p;
  }
}

function parseProfile(raw: unknown): McProfile {
  const j = raw as { id?: string; name?: string; skins?: Array<{ state: string; url: string; variant: string }> };
  if (!j?.id || !j.name) throw new AppError('AUTH_NO_PROFILE', 'perfil incompleto');
  const active = j.skins?.find((s) => s.state === 'ACTIVE');
  return {
    uuid: dashUuid(j.id),
    name: j.name,
    skin: active ? { url: active.url, variant: active.variant?.toLowerCase() === 'slim' ? 'slim' : 'classic' } : undefined,
  };
}
