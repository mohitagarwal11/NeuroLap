export type GamepadControls = {
  throttle: number;
  steer: number;
  active: boolean;
};

/** Maps a standard browser gamepad to car controls; it does not know about tracks. */
export class GamepadInput {
  private readonly onControlsChanged: (controls: GamepadControls) => void;
  private readonly onAccelerate: () => void;
  private wasAccelerating = false;
  private selectedGamepadIndex: number | undefined;

  constructor(
    onControlsChanged: (controls: GamepadControls) => void,
    onAccelerate: () => void = () => {},
  ) {
    this.onControlsChanged = onControlsChanged;
    this.onAccelerate = onAccelerate;
  }

  update(): void {
    const gamepad = this.selectedGamepad();
    if (!gamepad) {
      this.wasAccelerating = false;
      this.onControlsChanged({ throttle: 0, steer: 0, active: false });
      return;
    }

    const steer = this.applyDeadzone(gamepad.axes[0] ?? 0);
    const brake = this.buttonValue(gamepad, 6);
    const accelerate = this.buttonValue(gamepad, 7);
    const throttle = accelerate - brake;
    const active = Math.abs(steer) > 0.01 || brake > 0.01 || accelerate > 0.01;

    if (accelerate > 0.01 && !this.wasAccelerating) this.onAccelerate();
    this.wasAccelerating = accelerate > 0.01;
    this.onControlsChanged({ throttle, steer, active });
  }

  selectNextGamepad(): boolean {
    const gamepads = this.connectedGamepads();
    if (gamepads.length === 0) return false;
    const currentIndex = gamepads.findIndex(
      (gamepad) => gamepad.index === this.selectedGamepadIndex,
    );
    const nextIndex = (currentIndex + 1) % gamepads.length;
    this.selectedGamepadIndex = gamepads[nextIndex].index;
    this.wasAccelerating = false;
    return true;
  }

  selectedGamepadLabel(): string {
    const gamepad = this.selectedGamepad();
    return gamepad ? `Controller ${gamepad.index + 1}: ${gamepad.id}` : "No controller connected";
  }

  private selectedGamepad(): Gamepad | undefined {
    const gamepads = this.connectedGamepads();
    if (gamepads.length === 0) return undefined;
    const selected = gamepads.find(
      (gamepad) => gamepad.index === this.selectedGamepadIndex,
    );
    if (selected) return selected;
    this.selectedGamepadIndex = gamepads[0].index;
    return gamepads[0];
  }

  private connectedGamepads(): Gamepad[] {
    return [...navigator.getGamepads()].filter(
      (candidate): candidate is Gamepad => candidate !== null && candidate.connected,
    );
  }

  private buttonValue(gamepad: Gamepad, index: number): number {
    const button = gamepad.buttons[index];
    return button ? button.value : 0;
  }

  private applyDeadzone(value: number): number {
    const deadzone = 0.15;
    if (Math.abs(value) <= deadzone) return 0;
    return (value - Math.sign(value) * deadzone) / (1 - deadzone);
  }
}
