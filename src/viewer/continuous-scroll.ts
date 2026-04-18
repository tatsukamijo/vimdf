/**
 * Continuous scroll with gentle acceleration, driven by requestAnimationFrame.
 *
 * Used when the user holds j/k/h/l. A single tap still goes through the
 * normal scrollBy path for snappy feel; only repeated keydowns activate this.
 */

const INITIAL_SPEED = 0.6; // px per ms (~600 px/sec)
const MAX_SPEED = 3.0; // px per ms (~3000 px/sec)
const ACCELERATION = 0.004; // speed gain per ms held

export type Axis = "x" | "y";

export class ContinuousScroll {
  private rafId: number | null = null;
  private axis: Axis = "y";
  private direction: 1 | -1 = 1;
  private speed = 0;
  private lastTs = 0;

  constructor(private container: HTMLElement) {}

  start(axis: Axis, direction: 1 | -1): void {
    if (this.rafId !== null && this.axis === axis && this.direction === direction) {
      return; // already scrolling same way
    }
    this.stop();
    this.axis = axis;
    this.direction = direction;
    this.speed = INITIAL_SPEED;
    this.lastTs = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  isActive(): boolean {
    return this.rafId !== null;
  }

  private tick = (now: number): void => {
    const dt = Math.max(1, now - this.lastTs);
    this.lastTs = now;
    this.speed = Math.min(MAX_SPEED, this.speed + ACCELERATION * dt);
    const delta = this.direction * this.speed * dt;
    if (this.axis === "y") {
      this.container.scrollTop += delta;
    } else {
      this.container.scrollLeft += delta;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
}
