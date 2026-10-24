import type * as Three from 'three';
import { siteConfig } from '../config/site';

const configuration = siteConfig.projectTerrain;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const revealNormalization = 1 - 2 ** -configuration.transitionEasingPower;

// 固定种子的模拟地形；不读取或代表实际 Token 记录。
export function createTerrainCells(columns: number, rows: number) {
  const cells = Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const noise = Math.sin(column * 127.1 + row * 311.7 + configuration.seed) * 43758.5453;
    const random = noise - Math.floor(noise);
    const ridge = (Math.sin(column * 0.63 + row * 0.38) + Math.cos(row * 0.71 - column * 0.21) + 2) / 4;
    const level = Math.round(clamp(ridge * 0.7 + random * 0.3) * 4) / 4;
    return {
      column, row, level,
      baseHeight: 0.08 + level ** 1.5 * configuration.maximumHeight,
      tint: random,
      transitionSpan: 0,
      delay: (1 - Math.abs(column / Math.max(1, columns - 1) * 2 - 1)) * 0.8 + random * 0.02 + row / Math.max(1, rows - 1) * 0.18,
    };
  });
  [...cells].sort((left, right) => left.delay - right.delay).forEach((cell, index) => {
    const order = index / Math.max(1, cells.length - 1);
    cell.transitionSpan = configuration.columnTransitionSpan + (configuration.centerTransitionSpan - configuration.columnTransitionSpan) * order;
    cell.delay = (1 - (1 - order) ** configuration.staggerEasingPower) * (1 - cell.transitionSpan);
  });
  return cells;
}

export function terrainPresenceTarget(layerTop: number, layerHeight: number, viewportHeight: number) {
  if (viewportHeight <= 0 || layerHeight <= 0) return 0;
  const travel = clamp((viewportHeight - layerTop) / (layerHeight + viewportHeight));
  const transition = (1 - configuration.fullVisibilityRatio) / 2;
  return clamp(Math.min(travel, 1 - travel) / transition);
}

// 靠近项目区才加载 WebGL；页面离开前释放显存与观察器。
export function setupProjectTerrain(section: HTMLElement, motionDisabled: () => boolean) {
  const container = section.querySelector<HTMLElement>('[data-project-terrain]');
  const canvas = container?.querySelector('canvas');
  if (!container || !canvas) return;
  let disposed = false;
  let release: (() => void) | undefined;
  const dispose = () => {
    disposed = true;
    loader.disconnect();
    release?.();
    window.removeEventListener('pagehide', leave);
  };
  const leave = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  const loader = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    loader.disconnect();
    void import('three').then((engine) => {
      if (!disposed) release = mountTerrain(engine, container, canvas, motionDisabled);
    }).catch((error: unknown) => {
      container.dataset.unavailable = '';
      console.warn('Project terrain unavailable', error);
    });
  }, { rootMargin: `${configuration.preloadMarginPixels}px` });
  loader.observe(container);
  window.addEventListener('pagehide', leave);
  import.meta.hot?.dispose(dispose);
}

function mountTerrain(engine: typeof Three, container: HTMLElement, canvas: HTMLCanvasElement, motionDisabled: () => boolean) {
  const renderer = new engine.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  const scene = new engine.Scene();
  const cameraDistance = configuration.maximumHeight * 2.4;
  const camera = new engine.PerspectiveCamera(20, 1, 0.1, cameraDistance * 2);
  const elevation = configuration.cameraElevationDegrees * Math.PI / 180;
  camera.position.set(0, Math.sin(elevation) * cameraDistance, Math.cos(elevation) * cameraDistance);
  camera.lookAt(0, 0, 0);

  // 单批实例柱体；过渡扫描与错落边缘由着色器绘制。
  const geometry = new engine.BoxGeometry(1, 1, 1);
  const states = new engine.InstancedBufferAttribute(new Float32Array(configuration.maximumColumns * configuration.rows * 2), 2);
  states.setUsage(engine.DynamicDrawUsage);
  geometry.setAttribute('columnState', states);
  const material = new engine.ShaderMaterial({
    transparent: true,
    uniforms: {
      sideColor: { value: new engine.Color() }, markColor: { value: new engine.Color() },
      scanStrength: { value: 0 },
      viewportHeight: { value: 1 }, edgeFadeRange: { value: 1 },
    },
    vertexShader: `
      attribute vec2 columnState;
      uniform float edgeFadeRange;
      uniform float scanStrength;
      varying float reveal;
      varying float top;
      varying vec2 sweep;
      varying vec2 edgeFade;
      varying float faceHeight;
      varying vec3 columnColor;
      void main() {
        reveal = columnState.x;
        float transition = columnState.y;
        float columnPosition = instanceMatrix[3].x;
        sweep = vec2(mix(-0.15, 1.15, transition), sin(transition * 3.14159265) * scanStrength);
        edgeFade = vec2(
          edgeFadeRange + 0.06 * sin(columnPosition * 1.73) + 0.04 * sin(columnPosition * 0.61 + 1.9),
          edgeFadeRange + 0.06 * sin(columnPosition * 1.31 + 2.4) + 0.04 * cos(columnPosition * 0.79)
        );
        faceHeight = uv.y;
        top = step(0.5, normal.y);
        columnColor = instanceColor;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float reveal;
      varying float top;
      varying vec2 sweep;
      varying vec2 edgeFade;
      uniform vec3 sideColor;
      uniform vec3 markColor;
      uniform float viewportHeight;
      varying float faceHeight;
      varying vec3 columnColor;
      void main() {
        if (reveal < 0.001) discard;
        vec3 side = mix(sideColor, columnColor, 0.45 + 0.35 * faceHeight);
        vec3 color = mix(side, columnColor, top);
        float scan = 1.0 - smoothstep(0.025, 0.1, abs(faceHeight - sweep.x));
        color = mix(color, markColor, scan * sweep.y);
        float vertical = gl_FragCoord.y / viewportHeight;
        float fade = smoothstep(0.0, edgeFade.x, 1.0 - vertical) * smoothstep(0.0, edgeFade.y, vertical);
        gl_FragColor = vec4(color, reveal * fade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new engine.InstancedMesh(geometry, material, configuration.maximumColumns * configuration.rows);
  mesh.instanceMatrix.setUsage(engine.DynamicDrawUsage);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const transform = new engine.Object3D();
  const color = new engine.Color();
  const palette = { column: new engine.Color(), blue: new engine.Color(), pink: new engine.Color() };
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let cells = createTerrainCells(1, configuration.rows);
  let columns = 1;
  let worldWidth = 1;
  let worldDepth = 1;
  let progress = 0;
  let targetProgress = 0;
  let scrollPosition = 0;
  let targetScrollPosition = 0;
  let frame = 0;
  let lastFrame = 0;
  let elapsed = 0;
  let visible = false;
  let pageActive = true;
  let contextLost = false;
  let paused = motionDisabled();
  let theme = root.dataset.theme;

  function requestFrame() {
    if (!frame && visible && !document.hidden && pageActive && !contextLost) frame = requestAnimationFrame(draw);
  }
  function stop() { cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
  function paintPalette() {
    const styles = getComputedStyle(root);
    for (const name of ['column', 'blue', 'pink'] as const) palette[name].set(styles.getPropertyValue(`--terrain-${name}`).trim());
    material.uniforms.sideColor.value.set(styles.getPropertyValue('--terrain-side').trim());
    material.uniforms.markColor.value.set(styles.getPropertyValue('--terrain-mark').trim());
    material.uniforms.scanStrength.value = Number(styles.getPropertyValue('--terrain-scan-strength'));
    material.uniforms.edgeFadeRange.value = Number(styles.getPropertyValue('--terrain-edge-fade'));
    cells.forEach((cell, index) => {
      color.copy(palette.column).lerp(cell.tint > 0.974 ? palette.pink : palette.blue, cell.level * 0.75 + 0.1);
      mesh.setColorAt(index, color);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  function updateScroll() {
    const bounds = container.getBoundingClientRect();
    targetProgress = terrainPresenceTarget(bounds.top, bounds.height, window.innerHeight);
    targetScrollPosition = -bounds.top / Math.max(1, window.innerHeight);
    requestFrame();
  }
  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    const cellPixels = width <= configuration.mobileBreakpointPixels ? configuration.mobileCellPixels : configuration.cellPixels;
    columns = Math.min(configuration.maximumColumns, Math.max(2, Math.ceil(width / cellPixels)));
    worldWidth = columns;
    const worldHeight = worldWidth * height / width;
    worldDepth = worldHeight / Math.sin(elevation);
    camera.aspect = width / height;
    camera.fov = 2 * Math.atan(worldHeight / (2 * cameraDistance)) * 180 / Math.PI;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, configuration.pixelRatioLimit));
    renderer.setSize(width, height, false);
    material.uniforms.viewportHeight.value = canvas.height;
    cells = createTerrainCells(columns, configuration.rows);
    mesh.count = cells.length;
    paintPalette();
    updateScroll();
  }
  function draw(now: number) {
    frame = 0;
    if (!visible || document.hidden || !pageActive || contextLost) return;
    const transitioning = Math.abs(targetProgress - progress) > configuration.motionSettledThreshold
      || Math.abs(targetScrollPosition - scrollPosition) > configuration.motionSettledThreshold;
    const frameInterval = 1000 / (transitioning ? configuration.framesPerSecond : configuration.idleFramesPerSecond);
    const delta = lastFrame ? now - lastFrame : frameInterval;
    if (!paused && delta < frameInterval) { requestFrame(); return; }
    lastFrame = now;
    if (!paused) elapsed += Math.min(delta, 80);
    const response = 1 - Math.exp(-delta / configuration.responseMilliseconds);
    progress = paused ? targetProgress : progress + (targetProgress - progress) * response;
    const scrollImpulse = Math.min(1, Math.abs(targetScrollPosition - scrollPosition) * 3);
    if (!paused) scrollPosition += (targetScrollPosition - scrollPosition) * response;
    const waveTime = (elapsed / configuration.wavePeriodMilliseconds + scrollPosition * configuration.scrollWaveTurns) * Math.PI * 2;
    const amplitude = configuration.idleWaveAmplitude + (paused ? 0 : scrollImpulse * configuration.scrollWaveAmplitude);
    cells.forEach((cell, index) => {
      const phase = paused ? 1 : clamp((progress - cell.delay) / cell.transitionSpan);
      const reveal = (1 - 2 ** (-configuration.transitionEasingPower * phase)) / revealNormalization;
      const distanceFromEdge = Math.min(cell.column, columns - 1 - cell.column);
      const wave = (Math.sin(waveTime - distanceFromEdge * 0.55 - cell.row * 0.6) * 0.8
        + Math.sin(waveTime * 0.61 - cell.row * 0.32) * 0.2) * amplitude;
      const crest = paused ? 0 : Math.sin(phase * Math.PI) * configuration.scrollWaveAmplitude;
      const height = Math.max(0.035, cell.baseHeight * (0.08 + reveal * 0.92)
        + (wave + crest) * cell.level * reveal);
      const x = cell.column - (columns - 1) / 2;
      transform.position.set(x + Math.sign(x) * (1 - reveal) * configuration.slideDistanceCells, height / 2, ((cell.row + 0.5) / configuration.rows - 0.5) * worldDepth);
      const footprint = configuration.footprintRatio * (0.85 + reveal * 0.15);
      transform.scale.set(footprint, height, footprint * worldDepth / configuration.rows);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      states.setXY(index, reveal, phase);
    });
    mesh.instanceMatrix.needsUpdate = true;
    states.needsUpdate = true;
    renderer.render(scene, camera);
    if (!paused) requestFrame();
  }
  function syncState() {
    const nextPaused = motionDisabled();
    const nextTheme = root.dataset.theme;
    if (nextTheme !== theme) { theme = nextTheme; paintPalette(); }
    paused = nextPaused;
    if (paused || document.hidden || !pageActive) stop();
    requestFrame();
  }

  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    root.classList.toggle('project-terrain-active', visible);
    if (!visible) { stop(); progress = 0; }
    else updateScroll();
  });
  const size = new ResizeObserver(resize);
  const preference = new MutationObserver(() => {
    if (theme !== root.dataset.theme || paused !== motionDisabled()) syncState();
  });
  visibility.observe(container);
  size.observe(container);
  preference.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  reducedMotion.addEventListener('change', syncState, options);
  window.addEventListener('scroll', updateScroll, { ...options, passive: true });
  window.addEventListener('resize', resize, options);
  document.addEventListener('visibilitychange', syncState, options);
  window.addEventListener('pagehide', () => { pageActive = false; stop(); }, options);
  window.addEventListener('pageshow', () => { pageActive = true; syncState(); }, options);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    stop();
    container.dataset.unavailable = '';
    root.classList.remove('project-terrain-active');
    console.warn('Project terrain WebGL context lost');
  }, options);
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    delete container.dataset.unavailable;
    root.classList.toggle('project-terrain-active', visible);
    resize();
  }, options);
  resize();

  return () => {
    stop();
    listeners.abort();
    visibility.disconnect();
    size.disconnect();
    preference.disconnect();
    root.classList.remove('project-terrain-active');
    mesh.dispose();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  };
}
