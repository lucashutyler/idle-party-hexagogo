const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

let reduced: boolean | null = null;

function initReduced(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  const mql = window.matchMedia(REDUCED_QUERY);
  const update = (): void => { reduced = mql.matches; };
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', update);
  else if (typeof mql.addListener === 'function') mql.addListener(update);
  return mql.matches;
}

/** True when the player asked the OS for reduced motion (tracks changes live). */
export function reducedMotion(): boolean {
  if (reduced === null) reduced = initReduced();
  return reduced;
}

/** Test hook: force the reduced-motion answer (`null` re-reads the media query). */
export function setReducedMotionOverride(value: boolean | null): void {
  reduced = value === null ? initReduced() : value;
}

/** `el.animate` that degrades to a no-op where the Web Animations API is missing. */
export function fx(el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, opts: number | KeyframeAnimationOptions): Animation | null {
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  try {
    const animation = (el as HTMLElement).animate(keyframes, opts);
    // cancel() rejects `finished`; browsers mark that handled, happy-dom doesn't.
    animation.finished.catch(() => {});
    return animation;
  } catch {
    return null;
  }
}
