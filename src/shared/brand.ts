import raw from '../../brand.config.json';

export interface BrandConfig {
  productName: string;
  shortName: string;
  appId: string;
  tagline: string;
  colors: { accent: string; accentAlt: string };
  logo: string;
  github: { owner: string; repo: string; updateManifestAsset: string; updateSignatureAsset: string };
  updatePublicKeys: string[];
  authority: { url: string; publicKeys: string[] };
  microsoft: { clientId: string; redirectPath: string };
  support: { website: string; issues: string };
}

export const brand: BrandConfig = raw as BrandConfig;

export function isAuthorityConfigured(b: BrandConfig = brand): boolean {
  // HTTPS obligatorio; http solo para una autoridad local de desarrollo (127.0.0.1 / localhost).
  return /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(b.authority.url) && b.authority.publicKeys.length > 0;
}

export function isGithubConfigured(b: BrandConfig = brand): boolean {
  return !!b.github.owner && b.github.owner !== 'CHANGE_ME' && !!b.github.repo;
}
