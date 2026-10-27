import { useEffect, useRef, useState } from 'react';
import type { SkinVariant } from '../../shared/types';
import { drawFront, loadImage } from './skin';

/**
 * Visor 3D de skins en WebGL puro (sin dependencias). Modelo de jugador estándar 64×64
 * (y 64×32 heredado) con capa externa, giro de 360° arrastrando y teclado.
 */
type Mat = Float32Array;
const ident = (): Mat => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a: Mat, b: Mat): Mat {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}
const trans = (x: number, y: number, z: number): Mat => {
  const m = ident();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};
const rotX = (a: number): Mat => {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
};
const rotY = (a: number): Mat => {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
};
const rotZ = (a: number): Mat => {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
};
function persp(fovy: number, aspect: number, near: number, far: number): Mat {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

interface Part {
  start: number;
  count: number;
  pivot: [number, number, number];
}

/** Genera vértices (x,y,z,u,v,shade) de una caja con el mapeo UV estándar de Minecraft. */
function box(out: number[], x0: number, y0: number, z0: number, w: number, h: number, d: number, u: number, v: number, tw: number, th: number, td: number, inflate: number, mirror: boolean, texH: number) {
  const X0 = x0 - inflate, X1 = x0 + w + inflate, Y0 = y0 - inflate, Y1 = y0 + h + inflate, Z0 = z0 - inflate, Z1 = z0 + d + inflate;
  const U = (px: number) => px / 64;
  const V = (py: number) => py / texH;
  const quad = (p: number[][], uv: [number, number, number, number], shade: number) => {
    const [u0, v0, u1, v1] = uv;
    const t: Array<[number, number]> = [[U(u0), V(v0)], [U(u1), V(v0)], [U(u1), V(v1)], [U(u0), V(v1)]];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      let px = p[i]![0]!;
      if (mirror) px = x0 + w - (px - x0); // espejo sobre el centro de la caja (brazos/piernas heredados)
      out.push(px, p[i]![1]!, p[i]![2]!, t[i]![0], t[i]![1], shade);
    }
  };
  // Frente (+z), espalda (−z), derecha del jugador (−x), izquierda (+x), arriba, abajo.
  quad([[X0, Y1, Z1], [X1, Y1, Z1], [X1, Y0, Z1], [X0, Y0, Z1]], [u + td, v + td, u + td + tw, v + td + th], 1.0);
  quad([[X1, Y1, Z0], [X0, Y1, Z0], [X0, Y0, Z0], [X1, Y0, Z0]], [u + 2 * td + tw, v + td, u + 2 * td + 2 * tw, v + td + th], 0.7);
  quad([[X0, Y1, Z0], [X0, Y1, Z1], [X0, Y0, Z1], [X0, Y0, Z0]], [u, v + td, u + td, v + td + th], 0.8);
  quad([[X1, Y1, Z1], [X1, Y1, Z0], [X1, Y0, Z0], [X1, Y0, Z1]], [u + td + tw, v + td, u + 2 * td + tw, v + td + th], 0.8);
  quad([[X0, Y1, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X0, Y1, Z1]], [u + td, v, u + td + tw, v + td], 1.1);
  quad([[X0, Y0, Z1], [X1, Y0, Z1], [X1, Y0, Z0], [X0, Y0, Z0]], [u + td + tw, v, u + td + 2 * tw, v + td], 0.6);
}

function buildModel(variant: SkinVariant, legacy: boolean): { data: Float32Array; parts: Record<string, Part> } {
  const texH = legacy ? 32 : 64;
  const out: number[] = [];
  const parts: Record<string, Part> = {};
  const aw = variant === 'slim' ? 3 : 4;
  const begin = () => out.length / 6;
  const end = (name: string, start: number, pivot: [number, number, number]) => (parts[name] = { start, count: out.length / 6 - start, pivot });

  let s = begin();
  box(out, -4, 24, -4, 8, 8, 8, 0, 0, 8, 8, 8, 0, false, texH);
  box(out, -4, 24, -4, 8, 8, 8, 32, 0, 8, 8, 8, 0.5, false, texH);
  end('head', s, [0, 24, 0]);

  s = begin();
  box(out, -4, 12, -2, 8, 12, 4, 16, 16, 8, 12, 4, 0, false, texH);
  if (!legacy) box(out, -4, 12, -2, 8, 12, 4, 16, 32, 8, 12, 4, 0.25, false, texH);
  end('body', s, [0, 12, 0]);

  s = begin();
  box(out, -4 - aw, 12, -2, aw, 12, 4, 40, 16, aw, 12, 4, 0, false, texH);
  if (!legacy) box(out, -4 - aw, 12, -2, aw, 12, 4, 40, 32, aw, 12, 4, 0.25, false, texH);
  end('rArm', s, [-4 - aw / 2, 22, 0]);

  s = begin();
  if (legacy) box(out, 4, 12, -2, aw, 12, 4, 40, 16, aw, 12, 4, 0, true, texH);
  else {
    box(out, 4, 12, -2, aw, 12, 4, 32, 48, aw, 12, 4, 0, false, texH);
    box(out, 4, 12, -2, aw, 12, 4, 48, 48, aw, 12, 4, 0.25, false, texH);
  }
  end('lArm', s, [4 + aw / 2, 22, 0]);

  s = begin();
  box(out, -4, 0, -2, 4, 12, 4, 0, 16, 4, 12, 4, 0, false, texH);
  if (!legacy) box(out, -4, 0, -2, 4, 12, 4, 0, 32, 4, 12, 4, 0.25, false, texH);
  end('rLeg', s, [-2, 12, 0]);

  s = begin();
  if (legacy) box(out, 0, 0, -2, 4, 12, 4, 0, 16, 4, 12, 4, 0, true, texH);
  else {
    box(out, 0, 0, -2, 4, 12, 4, 16, 48, 4, 12, 4, 0, false, texH);
    box(out, 0, 0, -2, 4, 12, 4, 0, 48, 4, 12, 4, 0.25, false, texH);
  }
  end('lLeg', s, [2, 12, 0]);
  return { data: new Float32Array(out), parts };
}

const VS = `attribute vec3 p; attribute vec2 uv; attribute float sh;
uniform mat4 mvp; varying vec2 vUv; varying float vSh;
void main(){ vUv = uv; vSh = sh; gl_Position = mvp * vec4(p, 1.0); }`;
const FS = `precision mediump float; uniform sampler2D tex; varying vec2 vUv; varying float vSh;
void main(){ vec4 c = texture2D(tex, vUv); if (c.a < 0.1) discard; gl_FragColor = vec4(c.rgb * min(vSh, 1.0) + (vSh > 1.0 ? 0.04 : 0.0), 1.0); }`;

export function SkinViewer({ skin, variant, label, animate = true }: { skin: string; variant: SkinVariant; label: string; animate?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const yaw = useRef(-0.45);
  const pitch = useRef(0.08);
  const [noGl, setNoGl] = useState(false);
  const flatRef = useRef<HTMLCanvasElement>(null);

  // Sin WebGL (GPU bloqueada o drivers antiguos): vista frontal 2D en lugar de un lienzo vacío.
  useEffect(() => {
    if (noGl && flatRef.current) void drawFront(flatRef.current, skin, variant);
  }, [noGl, skin, variant]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false, alpha: true });
    if (!gl) {
      setNoGl(true);
      return;
    }
    let disposed = false;
    let raf = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced';

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    const tex = gl.createTexture();
    const locP = gl.getAttribLocation(prog, 'p');
    const locUv = gl.getAttribLocation(prog, 'uv');
    const locSh = gl.getAttribLocation(prog, 'sh');
    const locMvp = gl.getUniformLocation(prog, 'mvp');
    let model: ReturnType<typeof buildModel> | null = null;

    loadImage(skin)
      .then((img) => {
        if (disposed) return;
        model = buildModel(variant, img.height === 32);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, model.data, gl.STATIC_DRAW);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      })
      .catch(() => undefined);

    const t0 = performance.now();
    const frame = () => {
      if (disposed) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (model) {
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(locP);
        gl.vertexAttribPointer(locP, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(locUv);
        gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 24, 12);
        gl.enableVertexAttribArray(locSh);
        gl.vertexAttribPointer(locSh, 1, gl.FLOAT, false, 24, 20);
        const tm = (performance.now() - t0) / 1000;
        const swing = animate && !reduced ? Math.sin(tm * 2.2) * 0.12 : 0;
        const breathe = animate && !reduced ? Math.sin(tm * 1.4) * 0.03 : 0;
        const proj = persp((32 * Math.PI) / 180, w / Math.max(h, 1), 1, 300);
        const view = mul(trans(0, 0, -84), mul(rotX(pitch.current), rotY(yaw.current)));
        const base = mul(proj, mul(view, trans(0, -16, 0)));
        const rot: Record<string, Mat> = {
          head: rotX(breathe),
          body: ident(),
          rArm: mul(rotX(swing), rotZ(-0.04)),
          lArm: mul(rotX(-swing), rotZ(0.04)),
          rLeg: rotX(-swing),
          lLeg: rotX(swing),
        };
        for (const [name, part] of Object.entries(model.parts)) {
          const [px, py, pz] = part.pivot;
          const m = mul(base, mul(trans(px, py, pz), mul(rot[name]!, trans(-px, -py, -pz))));
          gl.uniformMatrix4fv(locMvp, false, m);
          gl.drawArrays(gl.TRIANGLES, part.start, part.count);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      gl.deleteBuffer(buf);
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
    };
  }, [skin, variant, animate]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw.current += (e.clientX - lx) * 0.012;
      pitch.current = Math.max(-0.6, Math.min(0.6, pitch.current + (e.clientY - ly) * 0.008));
      lx = e.clientX;
      ly = e.clientY;
    };
    const up = () => (dragging = false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') yaw.current -= 0.25;
      else if (e.key === 'ArrowRight') yaw.current += 0.25;
      else if (e.key === 'ArrowUp') pitch.current = Math.max(-0.6, pitch.current - 0.1);
      else if (e.key === 'ArrowDown') pitch.current = Math.min(0.6, pitch.current + 0.1);
      else return;
      e.preventDefault();
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('keydown', key);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('keydown', key);
    };
  }, []);

  if (noGl) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <canvas ref={flatRef} role="img" aria-label={label} style={{ width: 'auto', height: '70%', imageRendering: 'pixelated', cursor: 'default' }} />
      </div>
    );
  }
  return <canvas ref={ref} tabIndex={0} role="img" aria-label={label} />;
}
