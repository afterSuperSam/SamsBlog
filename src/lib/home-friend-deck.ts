import { siteConfig } from '../config/site';

// 循环相位只在完全透明的背面回绕，同一张卡始终对应唯一节点。
export function friendDeckDistance(index: number, phase: number, count: number): number {
  if (count < 2) return 0;
  return ((index - phase + count / 2) % count + count) % count - count / 2;
}

export function friendDeckOpacity(distance: number, count: number): number {
  if (count < 2) return count === 1 ? 1 : 0;
  const radius = Math.min(2.5, count / 2);
  const fade = Math.max(0, Math.min(1, (radius - Math.abs(distance)) / .5));
  return Math.exp(-distance * distance) * fade * fade * (3 - 2 * fade);
}

export function advanceFriendInertia(phase: number, velocity: number, friction: number, seconds: number) {
  const decay = Math.exp(-friction * seconds);
  return {
    phase: phase + velocity * (1 - decay) / friction,
    velocity: velocity * decay,
  };
}

// 手动归位沿用释放时的速度，以临界阻尼连续收敛，避免惯性末尾重新起步。
export function settleFriendMotion(phase: number, velocity: number, destination: number, response: number, seconds: number) {
  const offset = phase - destination;
  const damping = offset * velocity < 0 ? Math.max(response, -velocity / offset) : response;
  const growth = velocity + damping * offset;
  const decay = Math.exp(-damping * seconds);
  return {
    phase: destination + (offset + growth * seconds) * decay,
    velocity: (velocity - damping * growth * seconds) * decay,
  };
}

export function interpolateFriendPhase(start: number, end: number, progress: number): number {
  const time = Math.max(0, Math.min(1, progress));
  const easing = time ** 4 * (35 + time * (-84 + time * (70 - 20 * time)));
  return start + (end - start) * easing;
}

export function preserveFriendPhase(previousIds: string[], nextIds: string[], phase: number): number {
  if (nextIds.length < 2) return 0;
  if (!previousIds.length) return 0;
  const previousIndex = ((Math.round(phase) % previousIds.length) + previousIds.length) % previousIds.length;
  const nextIndex = nextIds.indexOf(previousIds[previousIndex]);
  return (nextIndex < 0 ? Math.min(previousIndex, nextIds.length - 1) : nextIndex) + phase - Math.round(phase);
}

export function friendDeckTilt(friendId: string): number {
  let hash = 2166136261;
  for (const character of friendId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ hash >>> 16, 2246822507);
  hash = Math.imul(hash ^ hash >>> 13, 3266489909);
  return ((hash ^ hash >>> 16) >>> 0) / 4294967295 * 2 - 1;
}

// 首页卡组只管理位置与交互，不复制卡片，也不读取或修改友链数据。
export function initializeFriendDeck(root: HTMLElement) {
  const stage = root.querySelector<HTMLElement>('[data-friend-deck-stage]')!;
  const configuration = siteConfig.friendDeck;
  const counter = root.querySelector<HTMLElement>('[data-friend-deck-count]');
  counter?.setAttribute('aria-live', 'off');
  const announcement = root.querySelector<HTMLElement>('[data-friend-deck-status]');
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let cards: HTMLElement[] = [];
  let tilts: number[] = [];
  let rendered = new Set<number>();
  let phase = 0;
  let velocity = 0;
  let destination: number | null = null;
  let automaticTransition: { start: number; end: number; elapsedMilliseconds: number } | null = null;
  let automaticTimer: ReturnType<typeof setTimeout> | undefined;
  let inertia = false;
  let manualAnnouncement = false;
  let frame: number | undefined;
  let previousTime = 0;
  let step = 1;
  let depth = 0;
  let scaleStep = 0;
  let angle = 0;
  let roll = 0;
  let frontTilt = 0;
  let backTilt = 0;
  let rise = 0;
  let visible = false;
  let wheelActive = false;
  let staticWheelDistance = 0;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClickUntil = 0;
  let disposed = false;
  let initialized = false;
  let pendingRefresh = false;
  const updates: (() => void)[] = [];
  let pointer: { id: number; startX: number; startY: number; lastX: number; lastTime: number; dragging: boolean } | null = null;
  const wrapIndex = (index: number) => ((index % cards.length) + cards.length) % cards.length;
  const currentIndex = () => cards.length ? wrapIndex(Math.round(phase)) : -1;
  const motionDisabled = () => preference.matches || document.documentElement.classList.contains('motion-paused');
  const focusedCard = () => document.activeElement instanceof Element && stage.contains(document.activeElement)
    && document.activeElement.matches(':focus-visible') && Boolean(document.activeElement.closest('[data-friend-card]'));
  const interacting = () => focusedCard() || Boolean(pointer?.dragging) || wheelActive || inertia || destination !== null;
  const mayAnimate = () => !disposed && visible && !document.hidden && !motionDisabled() && cards.length > 1 && !focusedCard();
  const mayFlow = () => mayAnimate() && !interacting();

  const announce = () => {
    if (!manualAnnouncement) return;
    manualAnnouncement = false;
    const card = cards[currentIndex()];
    if (announcement && card) announcement.textContent = `第 ${currentIndex() + 1} 位，共 ${cards.length} 位：${card.querySelector('.friend-card__copy strong')?.textContent?.trim() || '友链'}`;
  };
  const render = () => {
    const current = currentIndex();
    const candidates = new Set<number>();
    if (cards.length) {
      if (motionDisabled()) candidates.add(current);
      else for (let offset = -2; offset <= 3; offset++) candidates.add(wrapIndex(Math.floor(phase) + offset));
    }
    for (const index of new Set([...rendered, ...candidates])) {
      const card = cards[index];
      if (!card) continue;
      const distance = friendDeckDistance(index, phase, cards.length);
      const opacity = candidates.has(index) ? friendDeckOpacity(distance, cards.length) : 0;
      const active = index === current;
      const shown = opacity > 0;
      const visibility = shown ? 'visible' : 'hidden';
      if (card.style.visibility !== visibility) card.style.visibility = visibility;
      const optimization = shown && visible && !document.hidden && !motionDisabled() ? 'transform, opacity' : 'auto';
      if (card.style.willChange !== optimization) card.style.willChange = optimization;
      card.style.opacity = String(opacity);
      if (shown) {
        const distanceMagnitude = Math.abs(distance);
        const stableTilt = tilts[index] * (frontTilt + (backTilt - frontTilt) * Math.min(1, distanceMagnitude));
        card.style.transform = `translate(-50%,-50%) translate3d(${distance * step}px,${distanceMagnitude * rise}px,${-distanceMagnitude * depth}px) rotateY(${-distance * angle}deg) rotateZ(${-distance * roll + stableTilt}deg) scale(${Math.max(0, 1 - distanceMagnitude * scaleStep)})`;
        const layer = String(Math.ceil((Math.min(2.5, cards.length / 2) - distanceMagnitude) * 10) + 1);
        if (card.style.zIndex !== layer) card.style.zIndex = layer;
      }
      const activeValue = String(active);
      if (card.dataset.deckCurrent !== activeValue) {
        card.dataset.deckCurrent = activeValue;
        card.dataset.deckDepth = active ? 'front' : 'back';
        card.inert = !active;
        card.setAttribute('aria-hidden', String(!active));
        card.style.pointerEvents = active ? 'auto' : 'none';
      }
    }
    rendered = candidates;
    if (counter) {
      const value = `${current < 0 ? 0 : current + 1} / ${cards.length}`;
      if (counter.textContent !== value) counter.textContent = value;
    }
    if (motionDisabled() || cards.length < 2) root.dataset.deckStatic = '';
    else delete root.dataset.deckStatic;
  };
  const measure = () => {
    const styles = getComputedStyle(root);
    depth = parseFloat(styles.getPropertyValue('--friend-deck-depth')) || 0;
    scaleStep = parseFloat(styles.getPropertyValue('--friend-deck-scale-step')) || 0;
    angle = parseFloat(styles.getPropertyValue('--friend-deck-angle')) || 0;
    roll = parseFloat(styles.getPropertyValue('--friend-deck-roll')) || 0;
    frontTilt = parseFloat(styles.getPropertyValue('--friend-deck-front-tilt')) || 0;
    backTilt = parseFloat(styles.getPropertyValue('--friend-deck-back-tilt')) || 0;
    rise = parseFloat(styles.getPropertyValue('--friend-deck-rise')) || 0;
    step = Math.max(1, Math.min(configuration.maximumStepPixels, (cards[0]?.offsetWidth || stage.clientWidth) * configuration.cardStepRatio, stage.clientWidth * configuration.viewportStepRatio));
    if (cards.length) {
      const clearance = parseFloat(styles.getPropertyValue('--friend-deck-stage-clearance')) || 0;
      const height = Math.ceil(Math.max(...cards.map((card) => card.offsetHeight)) + clearance);
      root.style.setProperty('--friend-deck-stage-height', `${height}px`);
    } else root.style.setProperty('--friend-deck-stage-height', '0px');
    render();
  };
  const stopFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    previousTime = 0;
  };
  const cancelAutomatic = () => {
    clearTimeout(automaticTimer);
    automaticTimer = undefined;
    automaticTransition = null;
  };
  const schedule = () => {
    if (!mayAnimate()) return;
    if (frame === undefined && (automaticTransition || destination !== null || inertia)) frame = requestAnimationFrame(tick);
    else if (frame === undefined && automaticTimer === undefined && mayFlow()) {
      automaticTimer = setTimeout(() => {
        automaticTimer = undefined;
        if (!mayFlow()) return;
        automaticTransition = { start: phase, end: Math.floor(phase) + 1, elapsedMilliseconds: 0 };
        schedule();
      }, configuration.autoPauseMilliseconds);
    }
  };
  function tick(now: number) {
    frame = undefined;
    if (!mayAnimate()) { previousTime = 0; return; }
    const seconds = previousTime ? Math.min(now - previousTime, configuration.maximumFrameMilliseconds) / 1000 : 0;
    previousTime = now;
    if (automaticTransition) {
      automaticTransition.elapsedMilliseconds += seconds * 1000;
      const progress = automaticTransition.elapsedMilliseconds / configuration.autoTransitionMilliseconds;
      phase = interpolateFriendPhase(automaticTransition.start, automaticTransition.end, progress);
      if (progress >= 1) { phase = automaticTransition.end; automaticTransition = null; }
    } else if (destination !== null) {
      ({ phase, velocity } = settleFriendMotion(phase, velocity, destination, wheelActive ? configuration.wheelResponse : configuration.settleResponse, seconds));
      if (Math.abs(destination - phase) <= configuration.settleEpsilon && Math.abs(velocity) <= configuration.settleEpsilon * configuration.settleResponse && !wheelActive) {
        phase = destination; destination = null; velocity = 0; announce();
      }
    } else if (inertia) {
      ({ phase, velocity } = advanceFriendInertia(phase, velocity, configuration.inertiaFriction, seconds));
      if (Math.abs(velocity) < configuration.settleEpsilon * configuration.settleResponse) {
        inertia = false; destination = Math.round(phase);
      }
    } else { velocity = 0; previousTime = 0; }
    if (destination === null && !inertia) applyRefresh();
    render();
    schedule();
    if (frame === undefined) previousTime = 0;
  }
  const applyRefresh = () => {
    if (!pendingRefresh || initialized && interacting() || disposed) return;
    pendingRefresh = false;
    cancelAutomatic();
    const previousIds = cards.map((card) => card.dataset.friendCard!);
    const previousPhase = phase;
    cards.forEach((card) => sizeObserver.unobserve(card));
    updates.splice(0).forEach((update) => update());
    const allCards = [...stage.querySelectorAll<HTMLElement>('[data-friend-card]')];
    cards = allCards.filter((card) => !card.hidden);
    tilts = cards.map((card) => friendDeckTilt(card.dataset.friendCard!));
    phase = preserveFriendPhase(previousIds, cards.map((card) => card.dataset.friendCard!), previousPhase);
    if (!initialized) {
      const focusedIndex = cards.findIndex((card) => card.contains(document.activeElement));
      if (focusedIndex >= 0) phase = focusedIndex;
      initialized = true;
    }
    destination = null; inertia = false; velocity = 0;
    rendered = new Set();
    allCards.forEach((card) => {
      if (!card.hidden) sizeObserver.observe(card);
      delete card.dataset.deckCurrent;
      card.inert = true;
      card.setAttribute('aria-hidden', 'true');
      card.style.visibility = 'hidden';
      card.style.pointerEvents = 'none';
      card.querySelectorAll('img').forEach((image) => { image.draggable = false; });
      card.querySelectorAll('[data-friend-status]').forEach((status) => status.setAttribute('aria-live', 'off'));
    });
    measure();
    schedule();
  };
  const synchronize = () => {
    applyRefresh();
    if (!mayFlow()) cancelAutomatic();
    if (!mayAnimate()) {
      stopFrame(); velocity = 0; inertia = false; destination = null;
      if (motionDisabled()) phase = Math.round(phase);
      render();
    } else if (interacting() && destination === null && !inertia) { stopFrame(); velocity = 0; }
    schedule();
  };
  const navigate = (direction: number) => {
    if (cards.length < 2 || focusedCard()) return;
    cancelAutomatic();
    destination = Math.round(destination ?? phase) + direction;
    inertia = false; manualAnnouncement = true;
    if (motionDisabled() || !visible || document.hidden) {
      phase = destination; destination = null; render(); announce();
    } else schedule();
  };
  root.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || focusedCard() || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1);
  }, options);
  root.addEventListener('focusin', synchronize, options);
  root.addEventListener('focusout', () => queueMicrotask(synchronize), options);
  stage.addEventListener('dragstart', (event) => event.preventDefault(), options);
  stage.addEventListener('selectstart', (event) => event.preventDefault(), options);
  stage.addEventListener('click', (event) => {
    if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { ...options, capture: true });
  const finishPointer = (cancelled: boolean) => {
    if (!pointer) return;
    const finished = pointer; pointer = null;
    delete root.dataset.dragging;
    if (stage.hasPointerCapture(finished.id)) stage.releasePointerCapture(finished.id);
    if (finished.dragging) {
      suppressClickUntil = performance.now() + configuration.clickSuppressionMilliseconds;
      manualAnnouncement = true;
      if (cancelled || motionDisabled()) {
        velocity = 0; destination = null; inertia = false;
        if (!cancelled && Math.abs(finished.startX - finished.lastX) >= configuration.dragThresholdPixels) navigate(Math.sign(finished.startX - finished.lastX));
      }
      else if (performance.now() - finished.lastTime > configuration.wheelIdleMilliseconds) { velocity = 0; destination = Math.round(phase); }
      else inertia = true;
    }
    synchronize();
  };
  stage.addEventListener('pointerdown', (event) => {
    if (pointer && event.pointerId !== pointer.id) { finishPointer(true); return; }
    if (!event.isPrimary || event.button !== 0 || cards.length < 2) return;
    pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastTime: performance.now(), dragging: false };
  }, options);
  stage.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const horizontal = event.clientX - pointer.startX;
    const vertical = event.clientY - pointer.startY;
    if (!pointer.dragging) {
      if (Math.max(Math.abs(horizontal), Math.abs(vertical)) < configuration.dragThresholdPixels) return;
      if (Math.abs(horizontal) <= Math.abs(vertical)) { finishPointer(true); return; }
      pointer.dragging = true;
      cancelAutomatic(); stopFrame();
      destination = null; inertia = false; velocity = 0;
      root.dataset.dragging = 'true';
      root.focus({ preventScroll: true });
      stage.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    if (motionDisabled()) { pointer.lastX = event.clientX; return; }
    const now = performance.now();
    const seconds = Math.max(1, now - pointer.lastTime) / 1000;
    const change = -(event.clientX - pointer.lastX) / step;
    const measuredVelocity = Math.max(-configuration.maximumCardsPerSecond, Math.min(configuration.maximumCardsPerSecond, change / seconds));
    velocity += (measuredVelocity - velocity) * (1 - Math.exp(-configuration.velocityResponse * seconds));
    phase += change;
    pointer.lastX = event.clientX; pointer.lastTime = now;
    render();
  }, options);
  window.addEventListener('pointerup', (event) => { if (pointer?.id === event.pointerId) finishPointer(false); }, options);
  window.addEventListener('pointercancel', (event) => { if (pointer?.id === event.pointerId) finishPointer(true); }, options);
  stage.addEventListener('lostpointercapture', (event) => { if (pointer?.id === event.pointerId) finishPointer(true); }, options);
  stage.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey || focusedCard() || cards.length < 2 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    cancelAutomatic();
    const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientWidth : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? parseFloat(getComputedStyle(stage).lineHeight) || 1 : 1;
    // 减少动效时每轮横向手势直接换一张，保留触摸与触控板访问。
    if (motionDisabled()) {
      staticWheelDistance += event.deltaX * multiplier;
      if (!wheelActive && Math.abs(staticWheelDistance) >= configuration.dragThresholdPixels) {
        wheelActive = true;
        navigate(Math.sign(staticWheelDistance));
      }
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelActive = false; staticWheelDistance = 0;
        applyRefresh(); schedule();
      }, configuration.wheelIdleMilliseconds);
      return;
    }
    wheelActive = true; inertia = false; manualAnnouncement = true;
    destination = (destination ?? phase) + event.deltaX * multiplier / step;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelActive = false;
      destination = Math.round(destination ?? phase);
      applyRefresh(); schedule();
    }, configuration.wheelIdleMilliseconds);
    schedule();
  }, { ...options, passive: false });
  const visibilityObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible) finishPointer(true); synchronize(); });
  visibilityObserver.observe(root);
  const sizeObserver = new ResizeObserver(measure);
  sizeObserver.observe(stage);
  const motionObserver = new MutationObserver(synchronize);
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  preference.addEventListener('change', synchronize, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishPointer(true); synchronize(); }, options);
  window.addEventListener('pagehide', () => { visible = false; finishPointer(true); cancelAutomatic(); stopFrame(); }, options);
  window.addEventListener('pageshow', () => {
    const bounds = root.getBoundingClientRect();
    visible = bounds.bottom > 0 && bounds.top < innerHeight;
    synchronize();
  }, options);
  root.dataset.deckReady = '';
  pendingRefresh = true;
  applyRefresh();
  return {
    refresh(update?: () => void) { if (disposed) return; if (update) updates.push(update); pendingRefresh = true; applyRefresh(); },
    destroy() {
      disposed = true; listeners.abort(); stopFrame(); cancelAutomatic(); clearTimeout(wheelTimer);
      visibilityObserver.disconnect(); sizeObserver.disconnect(); motionObserver.disconnect();
      updates.length = 0;
      delete root.dataset.deckReady; delete root.dataset.deckStatic; delete root.dataset.dragging;
      root.style.removeProperty('--friend-deck-stage-height');
      stage.querySelectorAll<HTMLElement>('[data-friend-card]').forEach((card) => {
        card.inert = false; card.removeAttribute('aria-hidden'); delete card.dataset.deckCurrent; delete card.dataset.deckDepth;
        ['transform', 'opacity', 'visibility', 'z-index', 'pointer-events', 'will-change'].forEach((property) => card.style.removeProperty(property));
      });
    },
  };
}
