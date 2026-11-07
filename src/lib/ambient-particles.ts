import { siteConfig } from '../config/site';

// 沿用旧版粒子的分布和稀疏星图，绘制与全站动效偏好分离。
export const ambientMotePositions = [
  [7, 9], [44, 32], [81, 55], [18, 78], [55, 1], [92, 24], [29, 47], [66, 70], [3, 93], [40, 16],
  [77, 39], [14, 62], [51, 85], [88, 8], [25, 31], [62, 54], [99, 77], [36, 0], [73, 23], [10, 46],
  [47, 69], [84, 92], [21, 15], [58, 38], [95, 61], [32, 84], [69, 7], [6, 30],
  [16, 40], [53, 63], [90, 86], [27, 9], [64, 32], [1, 55], [38, 78], [75, 1],
  [12, 24], [49, 47], [86, 70], [23, 93],
  [87, 29], [24, 52], [61, 75], [98, 98], [35, 21], [72, 44], [9, 67], [46, 90], [83, 13], [20, 36],
  [57, 59], [94, 82], [31, 5], [68, 28], [5, 51], [42, 74], [79, 97], [16, 20], [53, 43], [90, 66],
] as const;

interface MotePoint { index: number; x: number; y: number; desktopOnly: boolean }
const configuration = siteConfig.effects.constellation;

export function createConstellationConnections(points: readonly MotePoint[], width: number, height: number, compact: boolean, random: () => number = Math.random) {
  const connections: { first: MotePoint; second: MotePoint }[] = [];
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return connections;
  const visiblePoints = compact ? points.filter((point) => !point.desktopOnly) : points;
  const maximumLineCount = compact ? configuration.mobileLineCount : configuration.desktopLineCount;
  const lineCount = Array.from({ length: maximumLineCount }, () => random() < configuration.connectionProbability).filter(Boolean).length;
  if (!lineCount) return connections;
  const pointCount = compact ? configuration.mobilePointCount : configuration.desktopPointCount;
  const maximumDistance = Math.hypot(width, height) * configuration.maximumDistanceRatio;
  const candidates: typeof connections = [];
  visiblePoints.forEach((first, index) => visiblePoints.slice(index + 1).forEach((second) => {
    const distance = Math.hypot((first.x - second.x) * width / 100, (first.y - second.y) * height / 100);
    if (distance <= maximumDistance) candidates.push({ first, second });
  }));
  for (let index = candidates.length - 1; index > 0; index--) {
    const shuffledIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[shuffledIndex]] = [candidates[shuffledIndex], candidates[index]];
  }
  const degrees = new Map<number, number>();
  const selectedPoints = new Set<number>();
  for (const { first, second } of candidates) {
    if (connections.length >= lineCount) break;
    if ((degrees.get(first.index) || 0) >= configuration.maximumDegree || (degrees.get(second.index) || 0) >= configuration.maximumDegree) continue;
    const addedPoints = Number(!selectedPoints.has(first.index)) + Number(!selectedPoints.has(second.index));
    if (selectedPoints.size + addedPoints > pointCount) continue;
    connections.push({ first, second });
    [first.index, second.index].forEach((index) => {
      selectedPoints.add(index);
      degrees.set(index, (degrees.get(index) || 0) + 1);
    });
  }
  return connections;
}

export function initializeAmbientParticles(scene: HTMLElement) {
  const layers = [...scene.querySelectorAll<SVGSVGElement>('[data-constellation]')];
  if (layers.length !== 2) return () => {};
  const particles = [...scene.querySelectorAll<HTMLElement>('.ambient-mote')];
  const points = particles.map((particle, index) => ({ index, x: Number(particle.dataset.moteLeft), y: Number(particle.dataset.moteTop), desktopOnly: particle.classList.contains('ambient-mote--desktop') }));
  const twinkle = siteConfig.effects.twinkle;
  particles.forEach((particle, index) => {
    particle.style.setProperty('--mote-left', `${points[index].x}%`);
    particle.style.setProperty('--mote-top', `${points[index].y}%`);
    particle.style.setProperty('--mote-delay', `-${index % twinkle.delayCycleSeconds}s`);
    particle.style.setProperty('--mote-duration', `${twinkle.minimumSeconds + index % twinkle.rangeSeconds}s`);
  });
  scene.dataset.particlesReady = '';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const compactViewport = matchMedia('(max-width: 720px)');
  const listeners = new AbortController();
  const animations = new Map<SVGSVGElement, Animation>();
  const viewport = { width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY };
  let timer = 0;
  let scrollFrame = 0;
  let activeLayer = -1;
  let suspended = false;
  let disposed = false;
  const motionDisabled = () => reducedMotion.matches || document.documentElement.classList.contains('motion-paused');
  let lastMotionDisabled = motionDisabled();
  const canAnimate = () => !disposed && !suspended && !document.hidden && !motionDisabled();
  const readViewport = () => Object.assign(viewport, { width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY });
  const draw = (layer: SVGSVGElement) => {
    const connections = createConstellationConnections(points, viewport.width, viewport.height, compactViewport.matches);
    layer.querySelectorAll('path').forEach((path, index) => {
      const connection = connections[index];
      if (connection) path.setAttribute('d', `M${connection.first.x} ${connection.first.y}L${connection.second.x} ${connection.second.y}`);
      else path.removeAttribute('d');
    });
  };
  const stop = () => {
    window.clearTimeout(timer); timer = 0;
    cancelAnimationFrame(scrollFrame); scrollFrame = 0;
    animations.forEach((animation) => animation.cancel()); animations.clear();
    layers.forEach((layer, index) => { layer.style.opacity = index === activeLayer ? '1' : '0'; });
  };
  // 星图仅数秒重选一次；滚动只合并一次透明度更新，不保持帧循环。
  const updateScroll = () => {
    scrollFrame = 0;
    if (disposed || suspended || document.hidden) return;
    const progress = viewport.scrollY / (Math.max(1, viewport.height) * configuration.scrollPeriodScreens);
    const visibility = motionDisabled() ? .3 : .55 + .45 * Math.sin(progress * Math.PI) ** 2;
    scene.style.setProperty('--constellation-scroll-opacity', String(visibility));
  };
  const refresh = () => {
    timer = 0;
    if (!canAnimate()) return;
    const previousLayer = activeLayer;
    activeLayer = (activeLayer + 1) % layers.length;
    draw(layers[activeLayer]);
    layers.forEach((layer, index) => {
      animations.get(layer)?.cancel();
      layer.style.opacity = index === activeLayer ? '1' : '0';
      if (typeof layer.animate !== 'function') return;
      animations.set(layer, layer.animate([{ opacity: index === previousLayer ? 1 : 0 }, { opacity: index === activeLayer ? 1 : 0 }], {
        duration: configuration.fadeMilliseconds, easing: 'ease-in-out',
      }));
    });
    timer = window.setTimeout(refresh, configuration.refreshMilliseconds);
  };
  const synchronize = () => {
    stop();
    if (disposed || suspended || document.hidden) return;
    readViewport();
    if (activeLayer < 0) { activeLayer = 0; draw(layers[activeLayer]); }
    layers.forEach((layer, index) => { layer.style.opacity = index === activeLayer ? '1' : '0'; });
    updateScroll();
    if (canAnimate()) timer = window.setTimeout(refresh, configuration.refreshMilliseconds);
  };
  const preferenceObserver = new MutationObserver(() => {
    const disabled = motionDisabled();
    if (disabled !== lastMotionDisabled) { lastMotionDisabled = disabled; synchronize(); }
  });
  preferenceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  reducedMotion.addEventListener('change', synchronize, { signal: listeners.signal });
  compactViewport.addEventListener('change', () => { activeLayer = -1; synchronize(); }, { signal: listeners.signal });
  document.addEventListener('visibilitychange', synchronize, { signal: listeners.signal });
  window.addEventListener('scroll', () => {
    if (!canAnimate()) return;
    viewport.scrollY = window.scrollY;
    if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll);
  }, { passive: true, signal: listeners.signal });
  window.addEventListener('resize', () => {
    readViewport();
    if (!canAnimate()) return;
    if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll);
  }, { passive: true, signal: listeners.signal });
  const dispose = () => {
    if (disposed) return;
    disposed = true; stop(); listeners.abort(); preferenceObserver.disconnect();
  };
  window.addEventListener('pagehide', (event) => {
    suspended = true;
    if (event.persisted) stop(); else dispose();
  }, { signal: listeners.signal });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !disposed) { suspended = false; synchronize(); }
  }, { signal: listeners.signal });
  synchronize();
  return dispose;
}
