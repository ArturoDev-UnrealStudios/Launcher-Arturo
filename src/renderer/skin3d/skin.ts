import type { SkinVariant } from '../../shared/types';

/** Carga una data URL como imagen decodificada. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagen inválida'));
    img.src = src;
  });
}

/**
 * Skin de maniquí original (no reproduce a Steve/Alex): tonos neutros y la camiseta
 * con el color de acento del launcher.
 */
export function placeholderSkin(accent = '#8b5cf6'): string {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const fill = (x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  const skin = '#c9a58a';
  const skinShade = '#b48f74';
  const hair = '#3b3640';
  const pants = '#2f3340';
  const shoes = '#1f2129';
  // Cabeza (0,0) 8x8x8
  fill(0, 8, 32, 8, skin);
  fill(8, 0, 16, 8, hair);
  fill(0, 8, 32, 2, hair);
  fill(24, 8, 8, 8, hair);
  fill(10, 12, 1, 1, '#2a2a33');
  fill(13, 12, 1, 1, '#2a2a33');
  fill(10, 14, 4, 1, skinShade);
  // Cuerpo (16,16) 8x12x4
  fill(16, 20, 24, 12, accent);
  fill(20, 16, 16, 4, accent);
  fill(20, 20, 8, 1, 'rgba(255,255,255,0.25)');
  // Brazos (40,16) y (32,48)
  for (const [u, v] of [[40, 16], [32, 48]] as const) {
    fill(u, v + 4, 16, 12, skin);
    fill(u, v + 4, 16, 4, accent);
    fill(u + 4, v, 8, 4, accent);
  }
  // Piernas (0,16) y (16,48)
  for (const [u, v] of [[0, 16], [16, 48]] as const) {
    fill(u, v + 4, 16, 12, pants);
    fill(u, v + 13, 16, 3, shoes);
    fill(u + 4, v, 8, 4, pants);
  }
  return c.toDataURL('image/png');
}

/** Cara (capa base + sombrero) a resolución nativa para avatares. */
export async function faceDataUrl(skinUrl: string, size = 64): Promise<string> {
  const img = await loadImage(skinUrl);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 8, 8, 8, 8, 0, 0, size, size);
  g.drawImage(img, 40, 8, 8, 8, -size * 0.0625, -size * 0.0625, size * 1.125, size * 1.125);
  return c.toDataURL('image/png');
}

/** Vista frontal 2D (para miniaturas de la biblioteca). */
export async function drawFront(canvas: HTMLCanvasElement, skinUrl: string, variant: SkinVariant): Promise<void> {
  const img = await loadImage(skinUrl);
  const legacy = img.height === 32;
  const s = 4;
  canvas.width = 16 * s;
  canvas.height = 32 * s;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const aw = variant === 'slim' ? 3 : 4;
  const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number, flip = false) => {
    if (flip) {
      g.save();
      g.scale(-1, 1);
      g.drawImage(img, sx, sy, w, h, -(dx + w) * s, dy * s, w * s, h * s);
      g.restore();
    } else g.drawImage(img, sx, sy, w, h, dx * s, dy * s, w * s, h * s);
  };
  part(8, 8, 8, 8, 4, 0); // cabeza
  part(20, 20, 8, 12, 4, 8); // torso
  part(44, 20, aw, 12, 4 - aw, 8); // brazo derecho
  if (legacy) part(44, 20, aw, 12, 12, 8, true);
  else part(36, 52, aw, 12, 12, 8); // brazo izquierdo
  part(4, 20, 4, 12, 4, 20); // pierna derecha
  if (legacy) part(4, 20, 4, 12, 8, 20, true);
  else part(20, 52, 4, 12, 8, 20);
  // Capas externas
  part(40, 8, 8, 8, 4, 0);
  if (!legacy) {
    part(20, 36, 8, 12, 4, 8);
    part(44, 36, aw, 12, 4 - aw, 8);
    part(52, 52, aw, 12, 12, 8);
    part(4, 36, 4, 12, 4, 20);
    part(4, 52, 4, 12, 8, 20);
  }
}
