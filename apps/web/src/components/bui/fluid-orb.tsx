"use client";

/*
 * Fluid Orb — a WebGL sphere of drifting fbm noise.
 * Shader from Rare UI (rareui.com/components/fluidorb).
 *
 * Browsers allow only a handful of live WebGL contexts, so instead of one per
 * orb, every orb on the page shares a single offscreen renderer: each frame it
 * draws each orb at that orb's size, time and colour, then blits the result
 * into the orb's own 2D canvas. `speed` can change live; time accumulates, so
 * the motion never jumps.
 */

import React, { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type FluidOrbProps = React.ComponentProps<"div"> & {
  size?: number;
  color?: string;
  /** animation rate multiplier; 0 freezes it */
  speed?: number;
};

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_color;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.22;

  vec2 drift = vec2(
    sin(t) + 0.6 * sin(t * 1.7 + 1.3),
    cos(t * 0.8) + 0.6 * cos(t * 1.3 + 2.1)
  );

  vec2 p = vec2(uv.x * 1.8, uv.y * 1.0) + drift * 0.7;

  vec2 q = vec2(fbm(p + drift), fbm(p + vec2(3.2, 1.5) - drift));
  float f = fbm(p + 1.2 * q);

  float g = clamp(1.0 - uv.y, 0.0, 1.0);
  float anchor = smoothstep(0.0, 0.3, uv.y);
  float shade = clamp(g + (f - 0.5) * 0.8 * anchor, 0.0, 1.0);

  vec3 white = vec3(0.99, 1.0, 1.0);
  vec3 light = mix(white, u_color, 0.5);
  vec3 dark = u_color;

  vec3 col = white;
  col = mix(col, light, smoothstep(0.28, 0.52, shade));
  col = mix(col, dark, smoothstep(0.58, 0.88, shade));

  float edge = smoothstep(0.5, 0.49, distance(uv, vec2(0.5)));

  gl_FragColor = vec4(col * edge, edge);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [0.1, 0.45, 0.95];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ── Shared renderer ─────────────────────────────────────────────────── */

type Orb = { ctx: CanvasRenderingContext2D; px: number; rgb: [number, number, number]; speed: number; t: number; drawn: boolean; visible: boolean };

type Renderer = {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
};

const orbs = new Set<Orb>();
let renderer: Renderer | null | undefined;
let raf = 0;
let last = 0;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createRenderer(): Renderer | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const program = gl.createProgram();
  const vert = compile(gl, gl.VERTEX_SHADER, VERT);
  const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!program || !vert || !frag) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    renderer = undefined; // rebuilt on the next frame
    for (const o of orbs) o.drawn = false;
    kick();
  });
  return {
    gl,
    canvas,
    uRes: gl.getUniformLocation(program, "u_resolution"),
    uTime: gl.getUniformLocation(program, "u_time"),
    uColor: gl.getUniformLocation(program, "u_color"),
  };
}

function draw(orb: Orb, r: Renderer) {
  const { gl, canvas } = r;
  if (canvas.width < orb.px || canvas.height < orb.px) {
    canvas.width = Math.max(canvas.width, orb.px);
    canvas.height = Math.max(canvas.height, orb.px);
  }
  gl.viewport(0, 0, orb.px, orb.px);
  gl.uniform2f(r.uRes, orb.px, orb.px);
  gl.uniform1f(r.uTime, orb.t);
  gl.uniform3f(r.uColor, ...orb.rgb);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  // The viewport sits at the bottom-left of the shared canvas.
  orb.ctx.clearRect(0, 0, orb.px, orb.px);
  orb.ctx.drawImage(canvas, 0, canvas.height - orb.px, orb.px, orb.px, 0, 0, orb.px, orb.px);
}

/** An orb needs a frame when it's on screen and either animating or not yet drawn. */
const needsFrame = (orb: Orb) => orb.visible && (orb.speed !== 0 || !orb.drawn);

function frame(now: number) {
  raf = 0;
  if (renderer === undefined) renderer = createRenderer();
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  let more = false;
  // No WebGL (renderer null): nothing can ever draw, so let the loop stop.
  if (renderer && document.visibilityState === "visible") {
    for (const orb of orbs) {
      if (!needsFrame(orb)) continue; // off screen, or frozen and already drawn
      orb.t += dt * orb.speed;
      draw(orb, renderer);
      orb.drawn = true;
      if (orb.speed !== 0) more = true;
    }
  }
  if (more) raf = requestAnimationFrame(frame);
  else last = 0;
}

/** (Re)start the loop when something may need drawing; it idles otherwise. */
function kick() {
  if (raf || typeof document === "undefined" || document.visibilityState !== "visible") return;
  for (const orb of orbs) {
    if (needsFrame(orb)) {
      raf = requestAnimationFrame(frame);
      return;
    }
  }
}

let listening = false;
function register(orb: Orb) {
  orbs.add(orb);
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", kick);
  }
  kick();
  return () => {
    orbs.delete(orb);
  };
}

/* ── Component ───────────────────────────────────────────────────────── */

export function FluidOrb({ size = 240, color = "#1A73F2", speed = 1, className, style, ...props }: FluidOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<Orb | null>(null);

  useEffect(() => {
    if (orbRef.current) orbRef.current.drawn = false;
    if (orbRef.current) orbRef.current.speed = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : speed;
    kick();
  }, [speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const px = Math.round(size * Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = px;
    canvas.height = px;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A random phase so several orbs on screen don't move in lockstep.
    const orb: Orb = { ctx, px, rgb: hexToRgb(color), speed: reduce ? 0 : speed, t: 1 + Math.random() * 40, drawn: false, visible: true };
    orbRef.current = orb;
    const unregister = register(orb);
    // Off-screen orbs (scrolled away, hidden panels) don't animate.
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            orb.visible = entry?.isIntersecting ?? true;
            kick();
          });
    io?.observe(canvas);
    return () => {
      io?.disconnect();
      unregister();
      orbRef.current = null;
    };
    // `speed` is applied live by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, color]);

  return (
    <div data-slot="fluid-orb" className={cn("relative shrink-0 overflow-hidden rounded-full", className)} style={{ width: size, height: size, ...style }} {...props}>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
