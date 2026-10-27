import { useEffect, useRef } from 'react';

/**
 * Portadas procedurales de bloques (arte original, sin recursos de Mojang).
 * Se genera un paisaje de vóxeles en 2D con ruido determinista por bioma.
 */
type Palette = {
  sky: [string, string];
  far: string;
  top: string[];
  body: string[];
  deep: string[];
  accent?: string[];
  stars?: boolean;
  water?: string[];
  glow?: string;
};

const PALETTES: Record<string, Palette> = {
  grass: { sky: ['#5f8fd6', '#a9d4ef'], far: '#6f9fbe', top: ['#5fa83b', '#6cb944', '#559a34'], body: ['#7a5536', '#6d4b2f', '#835c3b'], deep: ['#6e6e74', '#7b7b82', '#626268'], accent: ['#3f7d29', '#4b8a31'] },
  nether: { sky: ['#2a0707', '#5b1212'], far: '#4a0d0d', top: ['#7a2424', '#8a2b2b', '#6d1f1f'], body: ['#5c1717', '#6a1c1c', '#521414'], deep: ['#3a0e0e', '#2e0b0b', '#431111'], accent: ['#ff8a1d', '#ffb347'], glow: '#ff6a00' },
  end: { sky: ['#07060e', '#1c1430'], far: '#2a1f44', top: ['#e8e6b0', '#d9d79f', '#f0eebd'], body: ['#cfcc92', '#c2bf85', '#d6d39a'], deep: ['#b5b277', '#a9a66d', '#bdba80'], accent: ['#2b1b47', '#3a2560'], stars: true },
  ocean: { sky: ['#2f6db5', '#86c5e8'], far: '#4d8fc2', top: ['#e2d39b', '#d8c88d', '#eadca6'], body: ['#cdbd84', '#c2b277', '#d5c58c'], deep: ['#8a8a90', '#7b7b82', '#94949a'], water: ['#2a6fb0', '#2563a3', '#3279bb'] },
  cherry: { sky: ['#e9a3c2', '#fbe1ea'], far: '#d79ab8', top: ['#6cb944', '#78c24e', '#5fa83b'], body: ['#7a5536', '#6d4b2f', '#835c3b'], deep: ['#6e6e74', '#7b7b82', '#626268'], accent: ['#f4b6d0', '#f7c7dc', '#ec9fc1'] },
  deepdark: { sky: ['#03080b', '#0b1a20'], far: '#0e2229', top: ['#0f3a43', '#124650', '#0c2f37'], body: ['#1b2226', '#20282d', '#171d21'], deep: ['#111618', '#0d1113', '#151b1e'], accent: ['#29dfe6', '#1bb5c0'], glow: '#18c8d2' },
};

export const COVER_KEYS = Object.keys(PALETTES);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Dibuja el paisaje en un lienzo de baja resolución; se escala con image-rendering: pixelated. */
export function drawCover(ctx: CanvasRenderingContext2D, w: number, h: number, key: string, seedStr: string): void {
  const p = PALETTES[key] ?? PALETTES.grass!;
  const r = rng(hash(seedStr + key));
  const pick = (arr: string[]) => arr[Math.floor(r() * arr.length)]!;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(1, p.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  if (p.stars) {
    for (let i = 0; i < (w * h) / 60; i++) {
      ctx.fillStyle = r() > 0.8 ? '#d7c9ff' : '#ffffff';
      ctx.globalAlpha = 0.3 + r() * 0.7;
      ctx.fillRect(Math.floor(r() * w), Math.floor(r() * h * 0.6), 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  // Sierra lejana
  const farBase = h * 0.52;
  let fy = farBase;
  ctx.fillStyle = p.far;
  for (let x = 0; x < w; x += 2) {
    fy += (r() - 0.5) * 3;
    fy = Math.max(h * 0.3, Math.min(h * 0.62, fy));
    ctx.fillRect(x, Math.round(fy), 2, h);
  }
  // Terreno principal en columnas de 1 px (cada "bloque" = 1 px del lienzo)
  const base = h * 0.66;
  let y = base;
  let slope = 0;
  const heights: number[] = [];
  for (let x = 0; x < w; x++) {
    if (x % 3 === 0) {
      slope += (r() - 0.5) * 0.9;
      slope = Math.max(-1.2, Math.min(1.2, slope));
      y += Math.round(slope);
      y = Math.max(h * 0.5, Math.min(h * 0.82, y));
    }
    heights.push(Math.round(y));
  }
  const waterLevel = Math.round(h * 0.72);
  for (let x = 0; x < w; x++) {
    const top = heights[x]!;
    for (let yy = top; yy < h; yy++) {
      const depth = yy - top;
      ctx.fillStyle = depth === 0 ? pick(p.top) : depth < 4 ? pick(p.body) : pick(p.deep);
      ctx.fillRect(x, yy, 1, 1);
    }
    if (p.water && top > waterLevel) {
      for (let yy = waterLevel; yy < top; yy++) {
        ctx.fillStyle = pick(p.water);
        ctx.fillRect(x, yy, 1, 1);
      }
    }
  }
  // Detalles por bioma: árboles, lava, cristales de sculk, islas
  if (key === 'grass' || key === 'cherry') {
    for (let i = 0; i < w / 14; i++) {
      const tx = Math.floor(r() * (w - 6)) + 3;
      const ty = heights[tx]!;
      const th = 3 + Math.floor(r() * 3);
      ctx.fillStyle = '#6d4b2f';
      ctx.fillRect(tx, ty - th, 1, th);
      for (let dx = -2; dx <= 2; dx++)
        for (let dy = -2; dy <= 1; dy++) {
          if (Math.abs(dx) + Math.abs(dy) > 3) continue;
          ctx.fillStyle = pick(p.accent ?? p.top);
          ctx.fillRect(tx + dx, ty - th + dy, 1, 1);
        }
    }
  }
  if (p.glow && p.accent) {
    for (let i = 0; i < w / 8; i++) {
      const gx = Math.floor(r() * w);
      const gy = heights[gx]! + 2 + Math.floor(r() * (h - heights[gx]! - 2));
      ctx.fillStyle = pick(p.accent);
      ctx.fillRect(gx, gy, 1, 1);
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = p.glow;
      ctx.fillRect(gx - 1, gy - 1, 3, 3);
      ctx.globalAlpha = 1;
    }
  }
  if (key === 'end' && p.accent) {
    // Pilares de obsidiana
    for (let i = 0; i < 4; i++) {
      const px = Math.floor(((i + 0.5) / 4) * w + (r() - 0.5) * 10);
      const ph = 10 + Math.floor(r() * (h * 0.3));
      ctx.fillStyle = pick(p.accent);
      ctx.fillRect(px, heights[Math.min(w - 1, Math.max(0, px))]! - ph, 3, ph);
    }
  }
}

export function Cover({ cover, seed, width = 160, height = 90, className, alt = '' }: { cover: string; seed: string; width?: number; height?: number; className?: string; alt?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const isImage = cover.startsWith('data:image/');
  useEffect(() => {
    if (isImage || !ref.current) return;
    const ctx = ref.current.getContext('2d');
    if (ctx) drawCover(ctx, width, height, cover, seed);
  }, [cover, seed, width, height, isImage]);
  if (isImage) return <img className={`cover-img ${className ?? ''}`} src={cover} alt={alt} />;
  return <canvas ref={ref} width={width} height={height} className={className} role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} />;
}
