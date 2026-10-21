const PIXELS_PER_METER = 8;
const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const SUBSTEPS = 6;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export class Car {
  x: number;
  y: number;
  angle = -Math.PI / 2;
  width: number;
  length: number;

  throttle = 0;
  steer = 0;
  surfaceGrip = 1;

  private vx = 0;
  private vy = 0;
  private yawRate = 0;
  private loadAccel = 0;
  private appliedThrottle = 0;
  private appliedSteer = 0;

  readonly mass = 800;
  readonly inertia = 1100;
  readonly cgToFront = 1.8;
  readonly cgToRear = 1.8;
  readonly cgHeight = 0.3;

  // Rear-wheel drive
  readonly enginePower = 220_000;
  readonly maxEngineForce = 9000;
  readonly reverseForce = 3000;
  readonly maxReverseSpeed = 8;
  readonly brakeForce = 30_000;
  readonly brakeAssist = 0.95;
  readonly tractionAssist = 0.92;

  // Arcade-friendly combined tire forces
  readonly frictionCoupling = 0.18;

  // Aerodynamics
  readonly dragArea = 1.1;
  readonly downforceArea = 4.2;
  readonly aeroBalanceFront = 0.45;
  readonly rollingCoeff = 0.015;

  // Tires
  readonly tireGrip = 1.9;
  readonly tireB = 9; 
  readonly tireC = 1.5;

  // Keyboard steering: no speed-sensitive steering lock
  readonly maxSteerAngle = 0.42;
  readonly steerSpeedRef = 45;
  readonly steerRampRate = 18;
  readonly steerReturnRate = 16;

  // Light arcade stabilization
  readonly yawDamping = 900;

  // Responsive pedals
  readonly throttleRampRate = 6;
  readonly brakeRampRate = 12;
  readonly releaseRampRate = 7;

  readonly topSpeed: number;

  constructor(
    x: number,
    y: number,
    width = 2 * PIXELS_PER_METER,
    length = 4 * PIXELS_PER_METER,
  ) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.length = length;
    this.topSpeed = this.solveTopSpeed();
  }

  reset(x: number, y: number, angle = -Math.PI / 2): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.stop();
    this.throttle = 0;
    this.steer = 0;
    this.appliedThrottle = 0;
    this.appliedSteer = 0;
  }

  stop(): void {
    this.vx = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.loadAccel = 0;
  }

  get speed(): number {
    return this.vx;
  }

  get speedKmh(): number {
    return this.vx * 3.6;
  }

  get slipAngle(): number {
    return Math.atan2(this.vy, Math.max(Math.abs(this.vx), 0.5));
  }

  update(deltaSeconds: number): void {
    const dt = clamp(deltaSeconds, 0, 0.1);
    if (dt === 0) return;

    // Smooth pedal response
    const requested = clamp(this.throttle, -1, 1);
    const braking =
      (requested < 0 && this.vx > 0) || (requested > 0 && this.vx < 0);

    const pedalRate =
      requested === 0
        ? this.releaseRampRate
        : braking
          ? this.brakeRampRate
          : this.throttleRampRate;

    this.appliedThrottle = this.moveTowards(
      this.appliedThrottle,
      requested,
      pedalRate * dt,
    );

    // Fast, responsive keyboard steering
    const steerTarget = clamp(this.steer, -1, 1);
    const steerRate =
      steerTarget === 0 ? this.steerReturnRate : this.steerRampRate;

    this.appliedSteer = this.moveTowards(
      this.appliedSteer,
      steerTarget,
      steerRate * dt,
    );

    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      this.step(h);
    }
  }

  private step(h: number): void {
    const a = this.cgToFront;
    const b = this.cgToRear;
    const wheelbase = a + b;
    const weight = this.mass * GRAVITY;

    const u = this.vx;
    const v = this.vy;
    const r = this.yawRate;
    const input = this.appliedThrottle;
    const motion = clamp(u / 0.5, -1, 1);

    // Constant steering angle at every speed
    const delta = this.appliedSteer * this.maxSteerAngle;

    // Engine and brakes
    let drive = 0;
    let brake = 0;

    if (input > 0) {
      if (u < -0.5) {
        brake = input * this.brakeForce;
      } else {
        const engine = Math.min(
          this.maxEngineForce,
          this.enginePower / Math.max(u, 1),
        );
        drive = input * engine;
      }
    } else if (input < 0) {
      if (u > 0.5) {
        brake = -input * this.brakeForce;
      } else if (u > -this.maxReverseSpeed) {
        drive = input * this.reverseForce;
      }
    }

    // Weight transfer and aerodynamic downforce
    const transfer = (this.mass * this.loadAccel * this.cgHeight) / wheelbase;

    const downforce = 0.5 * AIR_DENSITY * this.downforceArea * u * u;

    const fzF = Math.max(
      0.05 * weight,
      (weight * b) / wheelbase - transfer + downforce * this.aeroBalanceFront,
    );

    const fzR = Math.max(
      0.05 * weight,
      (weight * a) / wheelbase +
        transfer +
        downforce * (1 - this.aeroBalanceFront),
    );

    const mu = Math.max(0.1, this.tireGrip * this.surfaceGrip);
    const loadTotal = fzF + fzR;

    // Forgiving ABS-style braking and traction control
    const brakeApplied = Math.min(brake, this.brakeAssist * mu * loadTotal);

    const frontShare = fzF / loadTotal;
    const driveCap = this.tractionAssist * mu * fzR;
    const driveApplied = clamp(drive, -driveCap, driveCap);

    const fxF = clamp(-motion * brakeApplied * frontShare, -mu * fzF, mu * fzF);

    const fxR = clamp(
      driveApplied - motion * brakeApplied * (1 - frontShare),
      -mu * fzR,
      mu * fzR,
    );

    // Tire slip angles
    const dir = u >= 0 ? 1 : -1;
    const ref = Math.max(Math.abs(u), 0.5);

    const alphaF = Math.atan2(v + a * r, ref) - delta * dir;

    const alphaR = Math.atan2(v - b * r, ref);

    const fyF = this.lateralForce(alphaF, fzF, fxF, mu);
    const fyR = this.lateralForce(alphaR, fzR, fxR, mu);

    // Body forces
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);

    const aero = 0.5 * AIR_DENSITY * this.dragArea * u * Math.abs(u);

    const rolling = this.rollingCoeff * weight * motion;

    const fxBody = fxR + fxF * cd - fyF * sd - aero - rolling;

    const fyBody = fyR + fyF * cd + fxF * sd;

    const moment = a * (fyF * cd + fxF * sd) - b * fyR - this.yawDamping * r;

    const ax = fxBody / this.mass;

    this.vx += (ax + v * r) * h;
    this.vy += (fyBody / this.mass - u * r) * h;
    this.yawRate += (moment / this.inertia) * h;

    this.loadAccel += (ax - this.loadAccel) * Math.min(1, h * 8);

    // Smooth low-speed behavior
    const blend = clamp((Math.abs(this.vx) - 1.0) / 2.0, 0, 1);

    const kinematicYaw = (this.vx / wheelbase) * Math.tan(delta);

    this.yawRate = blend * this.yawRate + (1 - blend) * kinematicYaw;

    this.vy *= blend;

    // Integrate world position
    const cosine = Math.cos(this.angle);
    const sine = Math.sin(this.angle);

    const worldVx = this.vx * cosine - this.vy * sine;
    const worldVy = this.vx * sine + this.vy * cosine;

    this.x += worldVx * PIXELS_PER_METER * h;
    this.y += worldVy * PIXELS_PER_METER * h;
    this.angle += this.yawRate * h;
  }

  private lateralForce(
    alpha: number,
    fz: number,
    fx: number,
    mu: number,
  ): number {
    const peak = Math.max(mu * fz, 1);

    // Arcade tuning: braking only moderately reduces cornering grip
    const circle = Math.sqrt(
      Math.max(0.12, 1 - this.frictionCoupling * (fx / peak) ** 2),
    );

    return (
      -peak * circle * Math.sin(this.tireC * Math.atan(this.tireB * alpha))
    );
  }

  private solveTopSpeed(): number {
    let lo = 1;
    let hi = 200;

    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;

      const thrust = Math.min(this.maxEngineForce, this.enginePower / mid);

      const resist =
        0.5 * AIR_DENSITY * this.dragArea * mid * mid +
        this.rollingCoeff * this.mass * GRAVITY;

      if (thrust > resist) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    return lo;
  }

  private moveTowards(
    current: number,
    target: number,
    maximumChange: number,
  ): number {
    if (Math.abs(target - current) <= maximumChange) {
      return target;
    }

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
