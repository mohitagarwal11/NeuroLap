/** A canvas-independent car model. Time values are expressed in seconds. */
export class Car {
  x: number;
  y: number;
  angle = -Math.PI / 2;
  speed = 0;
  width: number;
  length: number;
  throttle = 0;
  steer = 0;
  private appliedThrottle = 0;
  private appliedSteer = 0;

  // more downforce tuning right now for btr control in corners
  readonly acceleration = 250;
  readonly reverseAcceleration = 120;
  readonly braking = 500;
  readonly rollingResistance = 30;
  readonly aerodynamicDrag = 0.55;
  readonly maxSpeed = 300;
  readonly maxReverseSpeed = 75;
  readonly wheelbase = 28;
  readonly maxSteerAngle = 0.5;
  readonly maxLateralAccel = 500;
  readonly throttleRampRate = 3.5;
  readonly brakeRampRate = 8;
  readonly releaseRampRate = 5;
  readonly steerRampRate = 6;
  readonly steerReturnRate = 9;

  constructor(x: number, y: number, width = 15, length = 30) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.length = length;
  }

  update(deltaSeconds: number): void {
    const dt = Math.max(0, deltaSeconds);
    const requestedInput = Math.max(-1, Math.min(1, this.throttle));
    const isBrakingDirection =
      (requestedInput < 0 && this.speed > 0) ||
      (requestedInput > 0 && this.speed < 0);
    const rampRate =
      requestedInput === 0
        ? this.releaseRampRate
        : isBrakingDirection
          ? this.brakeRampRate
          : this.throttleRampRate;
    this.appliedThrottle = this.moveTowards(
      this.appliedThrottle,
      requestedInput,
      rampRate * dt,
    );
    const input = this.appliedThrottle;

    if (input > 0) {
      // Forward input brakes before it drives out of reverse.
      this.speed +=
        (this.speed < 0 ? this.braking : this.acceleration) * input * dt;
    } else if (input < 0) {
      // Brake while moving forward; once stopped, S engages the lower reverse gear.
      const force = this.speed > 0 ? this.braking : this.reverseAcceleration;
      this.speed += force * input * dt;
    }

    // Rolling resistance makes lift-off useful; aerodynamic drag reins in top speed.
    const drag =
      (this.rollingResistance + Math.abs(this.speed) * this.aerodynamicDrag) *
      dt;
    if (this.speed > 0) this.speed = Math.max(0, this.speed - drag);
    else if (this.speed < 0) this.speed = Math.min(0, this.speed + drag);
    this.speed = Math.max(
      -this.maxReverseSpeed,
      Math.min(this.maxSpeed, this.speed),
    );

    // Smooth the steering wheel so keyboard taps don't snap to full lock.
    const steerTarget = Math.max(-1, Math.min(1, this.steer));
    const steerRate =
      steerTarget === 0 ? this.steerReturnRate : this.steerRampRate;
    this.appliedSteer = this.moveTowards(
      this.appliedSteer,
      steerTarget,
      steerRate * dt,
    );

    // Bicycle model with a grip-limited steering angle: at speed the maximum
    // lock is whatever keeps lateral acceleration under maxLateralAccel.
    const v2 = this.speed * this.speed;
    const gripLimit =
      v2 > 1
        ? Math.atan((this.wheelbase * this.maxLateralAccel) / v2)
        : this.maxSteerAngle;
    const steerLimit = Math.min(this.maxSteerAngle, gripLimit);
    const steeringAngle = this.appliedSteer * steerLimit;
    const yawRate = (this.speed / this.wheelbase) * Math.tan(steeringAngle);
    this.angle += yawRate * dt;
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
  }

  private moveTowards(
    current: number,
    target: number,
    maximumChange: number,
  ): number {
    if (Math.abs(target - current) <= maximumChange) return target;
    return current + Math.sign(target - current) * maximumChange;
  }

  getBodyCorners(): readonly { x: number; y: number }[] {
    const cosine = Math.cos(this.angle);
    const sine = Math.sin(this.angle);
    const halfLength = this.length / 2;
    const halfWidth = this.width / 2;
    const localCorners = [
      { x: -halfLength, y: -halfWidth },
      { x: halfLength, y: -halfWidth },
      { x: halfLength, y: halfWidth },
      { x: -halfLength, y: halfWidth },
    ];

    return localCorners.map((corner) => ({
      x: this.x + corner.x * cosine - corner.y * sine,
      y: this.y + corner.x * sine + corner.y * cosine,
    }));
  }

  draw(context: CanvasRenderingContext2D): void {
    context.save();
    context.translate(this.x, this.y);
    context.rotate(this.angle);
    context.fillStyle = "#38bdf8";
    context.fillRect(
      -this.length / 2,
      -this.width / 2,
      this.length,
      this.width,
    );
    context.fillStyle = "#e0f2fe";
    context.fillRect(
      this.length / 8,
      -this.width / 2 + 4,
      this.length / 4,
      this.width - 8,
    );
    context.restore();
  }
}
