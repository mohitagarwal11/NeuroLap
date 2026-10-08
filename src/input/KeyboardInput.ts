import type { Car } from "../sim/Car";

/** Maps keyboard state to a car's public controls; it never advances the simulation. */
export class KeyboardInput {
  private readonly pressed = new Set<string>();
  private readonly car: Car;
  private readonly onAccelerate: () => void;
  private readonly onRestart: () => void;
  private readonly onCycleController: () => void;
  private readonly onControlsChanged: (throttle: number, steer: number) => void;

  constructor(
    car: Car,
    onAccelerate: () => void = () => {},
    onRestart: () => void = () => {},
    onCycleController: () => void = () => {},
    onControlsChanged: (throttle: number, steer: number) => void = () => {},
  ) {
    this.car = car;
    this.onAccelerate = onAccelerate;
    this.onRestart = onRestart;
    this.onCycleController = onCycleController;
    this.onControlsChanged = onControlsChanged;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.isControlKey(event.code)) return;
    event.preventDefault();
    if (event.code === "KeyR") {
      if (!event.repeat) this.onRestart();
      return;
    }
    if (event.code === "KeyG") {
      if (!event.repeat) this.onCycleController();
      return;
    }
    if (event.code === "KeyW") this.onAccelerate();
    this.pressed.add(event.code);
    this.applyControls();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    if (!this.isControlKey(event.code)) return;
    event.preventDefault();
    if (event.code === "KeyR" || event.code === "KeyG") return;
    this.pressed.delete(event.code);
    this.applyControls();
  };

  private readonly onBlur = () => {
    this.pressed.clear();
    this.applyControls();
  };

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.onBlur();
  }

  private isControlKey(code: string): boolean {
    return code === "KeyW" || code === "KeyS" || code === "KeyA" || code === "KeyD" || code === "KeyR" || code === "KeyG";
  }

  private applyControls(): void {
    this.car.throttle = Number(this.pressed.has("KeyW")) - Number(this.pressed.has("KeyS"));
    this.car.steer = Number(this.pressed.has("KeyD")) - Number(this.pressed.has("KeyA"));
    this.onControlsChanged(this.car.throttle, this.car.steer);
  }
}
