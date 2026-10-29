// WebGL2 compositor. The world is painted into small 2D canvases at "art
// resolution" (one texel = one art pixel); this pass lights it, blooms the
// emissive layer, then upscales with sharp-bilinear filtering so pixels stay
// crisp at any zoom while the glow stays soft — the Songs-of-Conquest look.

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uBg, uCol, uEmit, uLight;
uniform vec3 uAmbient;
uniform float uEmitGain;
void main() {
  vec3 bg = texture(uBg, vUv).rgb;
  vec4 c = texture(uCol, vUv);
  vec3 L = texture(uLight, vUv).rgb;
  vec3 lit = c.rgb * (uAmbient + L * 1.35);
  vec3 e = texture(uEmit, vUv).rgb * uEmitGain;
  o = vec4(mix(bg, lit, c.a) + e, 1.0);
}`;

const BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc;
uniform float uThr, uKnee;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThr + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  o = vec4(c * max(soft, br - uThr) / max(br, 1e-4), 1.0);
}`;

const DOWN = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv - h).rgb + texture(uSrc, vUv + h).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb + texture(uSrc, vUv - vec2(h.x, -h.y)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

const UP = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}`;

const FINAL = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uScene, uBloom;
uniform vec2 uTexSize, uScreen, uFrac;
uniform float uScale, uTime, uBloomStr;

vec3 sharp(vec2 texel) {
  vec2 f = fract(texel) - 0.5;
  float r = 0.5 - 0.5 / uScale;
  vec2 g = (f - clamp(f, -r, r)) * uScale + 0.5;
  return texture(uScene, (floor(texel) + g) / uTexSize).rgb;
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y);
  vec2 texel = frag / uScale + uFrac;
  vec2 sc = frag / uScreen - 0.5;
  float ca = dot(sc, sc) * 1.4;
  vec3 col = vec3(sharp(texel + sc * ca).r, sharp(texel).g, sharp(texel - sc * ca).b);
  col += texture(uBloom, texel / uTexSize).rgb * uBloomStr;
  col = aces(col * 1.12);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col *= mix(vec3(0.86, 1.0, 1.14), vec3(1.0), smoothstep(0.0, 0.5, l));
  col *= mix(vec3(1.0), vec3(1.07, 1.0, 0.92), smoothstep(0.45, 1.0, l));
  float v = smoothstep(0.95, 0.2, length(sc * vec2(1.05, 1.0)) * 1.15);
  col *= mix(0.5, 1.0, v);
  col += (hash(frag + fract(uTime) * 91.0) - 0.5) * 0.022;
  o = vec4(col, 1.0);
}`;

interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }
type Prog = { p: WebGLProgram; u: (n: string) => WebGLUniformLocation | null };

export interface PostFrame {
  bg: HTMLCanvasElement;
  col: HTMLCanvasElement;
  emit: HTMLCanvasElement;
  light: HTMLCanvasElement;
  pw: number;
  ph: number;
  scale: number;
  fx: number;
  fy: number;
  time: number;
}

export class Post {
  private gl: WebGL2RenderingContext;
  private hdr: boolean;
  private inputs: WebGLTexture[];
  private scene: Target | null = null;
  private bloom: Target[] = [];
  private P: Record<'compose' | 'bright' | 'down' | 'up' | 'final', Prog>;
  private vao: WebGLVertexArrayObject;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.vao = gl.createVertexArray()!;
    this.P = {
      compose: this.prog(COMPOSE), bright: this.prog(BRIGHT), down: this.prog(DOWN), up: this.prog(UP), final: this.prog(FINAL),
    };
    this.inputs = [0, 1, 2, 3].map(() => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      this.params(gl.NEAREST);
      return t;
    });
  }

  private prog(fs: string): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    const cache = new Map<string, WebGLUniformLocation | null>();
    return { p, u: (n) => (cache.has(n) ? cache.get(n)! : (cache.set(n, gl.getUniformLocation(p, n)), cache.get(n)!)) };
  }

  private params(filter: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private target(w: number, h: number, old?: Target | null): Target {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    if (old) { gl.deleteTexture(old.tex); gl.deleteFramebuffer(old.fb); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.params(gl.LINEAR);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  private pass(prog: Prog, out: Target | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
  }

  private bind(unit: number, tex: WebGLTexture, prog: Prog, name: string) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u(name), unit);
  }

  private draw() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  render(f: PostFrame) {
    const gl = this.gl;
    const lw = f.col.width, lh = f.col.height;

    [f.bg, f.col, f.emit, f.light].forEach((cv, i) => {
      gl.bindTexture(gl.TEXTURE_2D, this.inputs[i]);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, i === 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    });

    this.scene = this.target(lw, lh, this.scene);
    let w = lw, h = lh;
    for (let i = 0; i < 5; i++) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      this.bloom[i] = this.target(w, h, this.bloom[i]);
    }

    const { compose, bright, down, up, final } = this.P;
    this.pass(compose, this.scene, lw, lh);
    ['uBg', 'uCol', 'uEmit', 'uLight'].forEach((n, i) => this.bind(i, this.inputs[i], compose, n));
    gl.uniform3f(compose.u('uAmbient'), 0.36, 0.4, 0.55);
    gl.uniform1f(compose.u('uEmitGain'), 1.8);
    this.draw();

    const b0 = this.bloom[0];
    this.pass(bright, b0, b0.w, b0.h);
    this.bind(0, this.scene.tex, bright, 'uSrc');
    gl.uniform1f(bright.u('uThr'), 0.78);
    gl.uniform1f(bright.u('uKnee'), 0.3);
    this.draw();

    for (let i = 1; i < this.bloom.length; i++) {
      const src = this.bloom[i - 1], dst = this.bloom[i];
      this.pass(down, dst, dst.w, dst.h);
      this.bind(0, src.tex, down, 'uSrc');
      gl.uniform2f(down.u('uTexel'), 1 / src.w, 1 / src.h);
      this.draw();
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 2; i >= 0; i--) {
      const src = this.bloom[i + 1], dst = this.bloom[i];
      this.pass(up, dst, dst.w, dst.h);
      this.bind(0, src.tex, up, 'uSrc');
      gl.uniform2f(up.u('uTexel'), 1 / src.w, 1 / src.h);
      this.draw();
    }
    gl.disable(gl.BLEND);

    this.pass(final, null, f.pw, f.ph);
    this.bind(0, this.scene.tex, final, 'uScene');
    this.bind(1, b0.tex, final, 'uBloom');
    gl.uniform2f(final.u('uTexSize'), lw, lh);
    gl.uniform2f(final.u('uScreen'), f.pw, f.ph);
    gl.uniform2f(final.u('uFrac'), f.fx, f.fy);
    gl.uniform1f(final.u('uScale'), f.scale);
    gl.uniform1f(final.u('uTime'), f.time);
    gl.uniform1f(final.u('uBloomStr'), 1.05);
    this.draw();
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
