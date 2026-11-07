/*!
 * Silk shader adapted from https://reactbits.dev/r/Silk-TS-CSS.json
 * MIT + Commons Clause License Condition v1.0
 * Copyright (c) 2026 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software as part of an
 * application, website, or product, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Commons Clause Restriction
 * You may use this Software, including for any commercial purpose, so long as
 * you do not sell, sublicense, or redistribute the components themselves-whether
 * alone, in a bundle, or as a ported version.
 * The same restriction covers the React Bits tools (Background Studio, Texture
 * Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the
 * sounds in the sound library. You may not sell, sublicense, or redistribute the
 * tools or the sounds themselves, or offer the tools or a substantially similar
 * copy of them as a hosted service-whether alone, in a bundle, or as a ported version.
 * What you make with the tools is yours to use. You can use exported code, images,
 * videos, and audio files in any personal or commercial application, website, or
 * product, including paid ones. You may not sell or redistribute the exports on
 * their own, either individually or as the product itself, such as a sound,
 * texture, background, or template pack.
 *
 * No Warranty
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { siteConfig } from '../config/site';

const settings = siteConfig.ambientSilk;
const vertexSource = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;
const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 uView;
uniform float uTime, uFold, uScale, uRotation, uWave, uDepth, uSheen, uFade, uLight;
uniform vec3 uColor, uSheenColor;
out vec4 outColor;
float silk(vec2 coordinate) {
  float cosine = cos(uRotation), sine = sin(uRotation);
  vec2 texturePoint = mat2(cosine, -sine, sine, cosine) * coordinate * uScale * uScale;
  texturePoint.y += 0.03 * uWave * sin(8.0 * texturePoint.x - uTime);
  return 0.6 + 0.4 * uFold * sin(5.0 * (texturePoint.x + texturePoint.y
    + cos(3.0 * texturePoint.x + 5.0 * texturePoint.y) + 0.02 * uTime));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uView;
  vec2 coordinate = (uv - 0.5) * vec2(uView.x / uView.y, 1.0) + 0.5;
  float pattern = silk(coordinate);
  float level = clamp((pattern - 0.2) / 0.8, 0.0, 1.0);
  vec2 stepSize = vec2(1.0 / uView.y);
  vec3 normal = normalize(vec3(-(silk(coordinate + vec2(stepSize.x, 0.0)) - pattern) * 26.0,
    -(silk(coordinate + vec2(0.0, stepSize.y)) - pattern) * 26.0, 1.0));
  vec3 toLight = normalize(vec3(-0.55, 0.7, 0.85));
  float relief = 1.0 + (dot(normal, toLight) - toLight.z) * 1.8 * uDepth;
  vec3 halfway = normalize(toLight + vec3(0.0, 0.0, 1.0));
  float gloss = pow(max(dot(normal, halfway), 0.0), 48.0) * smoothstep(0.25, 0.85, level);
  float shine = (gloss * 0.85 + pow(level, 5.0) * 0.4) * uSheen;
  vec3 result;
  if (uLight > 0.5) {
    vec3 shadow = uColor * (0.72 - 0.12 * uDepth);
    vec3 body = min(uColor * 1.18, vec3(1.0));
    result = mix(shadow, body, smoothstep(0.28, 0.9, pattern)) * mix(1.0, relief, 0.6);
    result = mix(result, vec3(1.0), clamp(smoothstep(0.72, 0.98, pattern) * 0.92 + shine * 0.22, 0.0, 1.0));
  } else {
    float floorValue = mix(0.2, 0.03, uDepth);
    float shade = mix(floorValue, 1.0, pow(level, 1.0 + 1.4 * uDepth));
    vec3 tone = mix(uColor, pow(uColor, vec3(1.45)), (1.0 - level) * uDepth);
    result = tone * shade * relief + mix(uColor, uSheenColor, 0.8) * shine;
  }
  vec2 edge = smoothstep(vec2(0.0), vec2(uFade * 0.5), uv)
    * smoothstep(vec2(0.0), vec2(uFade * 0.5), 1.0 - uv);
  float alpha = edge.x * edge.y;
  outColor = vec4(clamp(result, 0.0, 1.0) * alpha, alpha);
}`;

export function ambientSilkDimensions(width: number, height: number, pixelRatio: number) {
  if (![width, height, pixelRatio].every((value) => Number.isFinite(value) && value > 0)) return { width: 1, height: 1 };
  const scale = Math.min(Math.min(pixelRatio, settings.pixelRatioLimit) * settings.resolutionScale, Math.sqrt(settings.maximumPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

// 背景只绘制低分辨率缎面；生命周期与全站动效偏好共用，失败时保留原有光晕。
export function initializeAmbientSilk(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) return () => {};
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let animationFrame = 0;
  let previousTime = 0;
  let elapsed = 0;
  let pageActive = true;
  let contextLost = false;
  let disposed = false;
  const canAnimate = () => !disposed && !contextLost && pageActive && !document.hidden && !reducedMotion.matches && !root.classList.contains('motion-paused');
  const stop = () => {
    clearTimeout(timer); timer = undefined;
    cancelAnimationFrame(animationFrame); animationFrame = 0;
    previousTime = 0;
  };
  const release = () => {
    gl.deleteBuffer(buffer); gl.deleteVertexArray(vertexArray); gl.deleteProgram(program);
    buffer = null; vertexArray = null; program = null;
  };
  const createShader = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Silk shader allocation failed');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const detail = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
      throw new Error(`Silk shader compilation failed: ${detail}`);
    }
    return shader;
  };
  const prepare = () => {
    const shaders: WebGLShader[] = [];
    try {
      shaders.push(createShader(gl.VERTEX_SHADER, vertexSource));
      shaders.push(createShader(gl.FRAGMENT_SHADER, fragmentSource));
      program = gl.createProgram(); buffer = gl.createBuffer(); vertexArray = gl.createVertexArray();
      if (!program || !buffer || !vertexArray) throw new Error('Silk resource allocation failed');
      shaders.forEach((shader) => gl.attachShader(program!, shader)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Silk program linking failed: ${gl.getProgramInfoLog(program)}`);
      gl.useProgram(program); gl.bindVertexArray(vertexArray); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      uniforms = Object.fromEntries(['uView', 'uTime', 'uFold', 'uScale', 'uRotation', 'uWave', 'uDepth', 'uSheen', 'uFade', 'uLight', 'uColor', 'uSheenColor'].map((name) => [name, gl.getUniformLocation(program!, name)]));
      for (const [name, value] of Object.entries({ uScale: settings.scale, uRotation: settings.rotation, uWave: settings.wave, uDepth: settings.depth, uSheen: settings.sheen, uFade: settings.edgeFade })) gl.uniform1f(uniforms[name], value);
      return true;
    } catch (error) {
      console.warn('Ambient silk unavailable', error); release(); return false;
    } finally { shaders.forEach((shader) => gl.deleteShader(shader)); }
  };
  const draw = () => {
    if (!program || disposed || contextLost || !pageActive || document.hidden) return;
    gl.uniform1f(uniforms.uTime, elapsed * .1 * settings.speed);
    gl.uniform1f(uniforms.uFold, 1 - settings.breathingStrength * (.5 + .5 * Math.sin(elapsed * Math.PI * 2 / settings.breathingSeconds)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.dataset.silkReady = '';
  };
  const schedule = () => {
    if (!canAnimate() || timer !== undefined || animationFrame) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!canAnimate()) return;
      animationFrame = requestAnimationFrame((now) => {
        animationFrame = 0;
        if (!canAnimate()) return;
        if (previousTime) elapsed += Math.min(now - previousTime, settings.maximumFrameMilliseconds) / 1000;
        previousTime = now;
        draw(); schedule();
      });
    }, 1000 / settings.framesPerSecond);
  };
  const resize = () => {
    if (!program || contextLost || disposed) return;
    const bounds = canvas.getBoundingClientRect();
    const dimensions = ambientSilkDimensions(bounds.width, bounds.height, window.devicePixelRatio || 1);
    if (canvas.width !== dimensions.width || canvas.height !== dimensions.height) {
      canvas.width = dimensions.width; canvas.height = dimensions.height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height); gl.uniform2f(uniforms.uView, canvas.width, canvas.height); draw();
  };
  const sync = () => {
    if (!program || contextLost || disposed) return;
    const style = getComputedStyle(root);
    for (const [name, token] of [['uColor', '--ambient-silk-color'], ['uSheenColor', '--ambient-silk-sheen']]) {
      const value = style.getPropertyValue(token).trim();
      if (!/^#[\da-f]{6}$/i.test(value)) { stop(); delete canvas.dataset.silkReady; return; }
      gl.uniform3f(uniforms[name], ...[1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16) / 255) as [number, number, number]);
    }
    gl.uniform1f(uniforms.uLight, root.dataset.theme === 'light' ? 1 : 0);
    if (!canAnimate()) stop();
    draw(); schedule();
  };
  const onContextLost = (event: Event) => { event.preventDefault(); contextLost = true; stop(); delete canvas.dataset.silkReady; };
  const onContextRestored = () => {
    contextLost = false;
    if (disposed) return;
    if (!prepare()) { dispose(); return; }
    resize(); sync();
  };
  const onPageHide = (event: PageTransitionEvent) => { pageActive = false; stop(); if (!event.persisted) dispose(); };
  const onPageShow = () => { pageActive = true; resize(); sync(); };
  const resizeObserver = new ResizeObserver(resize);
  const preferenceObserver = new MutationObserver(sync);
  const dispose = () => {
    if (disposed) return;
    disposed = true; stop(); resizeObserver.disconnect(); preferenceObserver.disconnect();
    reducedMotion.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync);
    window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow);
    canvas.removeEventListener('webglcontextlost', onContextLost); canvas.removeEventListener('webglcontextrestored', onContextRestored);
    release(); delete canvas.dataset.silkReady;
  };
  if (!prepare()) { dispose(); return dispose; }
  resize(); sync();
  resizeObserver.observe(canvas);
  preferenceObserver.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  reducedMotion.addEventListener('change', sync); document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', onPageHide); window.addEventListener('pageshow', onPageShow);
  canvas.addEventListener('webglcontextlost', onContextLost); canvas.addEventListener('webglcontextrestored', onContextRestored);
  return dispose;
}
