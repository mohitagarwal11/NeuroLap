export const TrackState = {
  DRAWING: "DRAWING",
  READY: "READY",
  DRIVING: "DRIVING",
  CRASHED: "CRASHED",
} as const;

export type TrackState = (typeof TrackState)[keyof typeof TrackState];

export type Point = { x: number; y: number };
export type WallSegment = { from: Point; to: Point };
export type LapStats = {
  currentLapMs: number;
  lapHistoryMs: readonly number[];
  bestLapMs: number | undefined;
};

/** A closed road built from a user-drawn centerline. */
export class Track {
  state: TrackState = TrackState.DRAWING;
  message = "Draw a loop, then release close to its start.";
  readonly roadWidth: number;
  readonly closeDistance = 42;
  private points: Point[] = [];
  private centerline: Point[] = [];
  private leftWalls: WallSegment[] = [];
  private rightWalls: WallSegment[] = [];
  private startFinish: WallSegment | undefined;
  private hasLeftStartLine = false;
  private lapStartTime: number | undefined;
  private lapStoppedTime: number | undefined;
  private lapHistoryMs: number[] = [];
  private bestLapMs: number | undefined;

  constructor(carWidth: number) {
    this.roadWidth = carWidth * 6;
  }

  begin(x: number, y: number): void {
    if (this.state === TrackState.DRIVING) return;
    this.state = TrackState.DRAWING;
    this.points = [{ x, y }];
    this.centerline = [];
    this.leftWalls = [];
    this.rightWalls = [];
    this.startFinish = undefined;
    this.resetLapData();
    this.message = "Draw a loop, then release close to its start.";
  }

  addPoint(x: number, y: number): void {
    if (this.state !== TrackState.DRAWING || this.points.length === 0) return;
    const previous = this.points[this.points.length - 1];
    if (Math.hypot(x - previous.x, y - previous.y) >= 8)
      this.points.push({ x, y });
  }

  finish(x: number, y: number): boolean {
    if (this.state !== TrackState.DRAWING || this.points.length === 0)
      return false;
    const start = this.points[0];
    if (Math.hypot(x - start.x, y - start.y) > this.closeDistance) {
      this.message = "Release near the green start marker to close the loop.";
      return false;
    }
    if (this.points.length < 6 || this.loopLength(this.points) < 600) {
      this.message = "Track is too short. Draw a longer loop.";
      return false;
    }
    if (this.hasSelfIntersection(this.points)) {
      this.message = "Track crosses itself. Draw a loop without intersections.";
      return false;
    }

    const resampled = this.resampleClosed(this.points, 24);
    const averaged = this.smoothWithMovingAverage(resampled, 4);
    const centerline = this.smoothClosed(averaged);
    if (this.hasSelfIntersection(centerline)) {
      this.message = "Smoothing would cross this track. Try a wider loop.";
      return false;
    }

    this.centerline = centerline;
    if (!this.buildWalls()) {
      this.centerline = [];
      this.message =
        "Corner too tight or track too close to itself. Draw a wider loop.";
      return false;
    }
    this.buildStartFinishLine();
    this.resetLapData();
    this.state = TrackState.READY;
    this.message = "Track ready — press W to drive.";
    return true;
  }

  getWalls(): { left: readonly WallSegment[]; right: readonly WallSegment[] } {
    return { left: this.leftWalls, right: this.rightWalls };
  }

  restart(): boolean {
    if (this.centerline.length === 0) return false;
    this.state = TrackState.READY;
    this.message = "Track ready — press W to drive.";
    return true;
  }

  startDriving(): Point | undefined {
    if (this.state !== TrackState.READY || this.centerline.length < 2)
      return undefined;
    this.state = TrackState.DRIVING;
    this.hasLeftStartLine = false;
    this.lapStartTime = undefined;
    this.lapStoppedTime = undefined;
    this.message = "Driving — stay between the walls.";
    return this.centerline[0];
  }

  crash(timeMs: number): void {
    if (this.state !== TrackState.DRIVING) return;
    this.state = TrackState.CRASHED;
    this.lapStoppedTime = timeMs;
    this.message = "Game over! Press R to restart, or draw a new track.";
  }

  recordRaceProgress(
    previousPosition: Point,
    currentPosition: Point,
    speed: number,
    timeMs: number,
  ): void {
    if (this.state !== TrackState.DRIVING) return;
    if (this.lapStartTime === undefined && Math.abs(speed) > 1) {
      this.lapStartTime = timeMs;
    }
    if (this.lapStartTime === undefined) return;

    if (!this.startFinish) return;
    if (!this.hasLeftStartLine) {
      if (this.distanceToSegment(currentPosition, this.startFinish) > this.roadWidth / 4) {
        this.hasLeftStartLine = true;
      }
      return;
    }

    if (this.segmentsIntersect(previousPosition, currentPosition, this.startFinish.from, this.startFinish.to)) {
      const lapTime = timeMs - this.lapStartTime;
      this.lapHistoryMs.push(lapTime);
      this.bestLapMs = Math.min(this.bestLapMs ?? Number.POSITIVE_INFINITY, lapTime);
      this.lapStartTime = timeMs;
      this.hasLeftStartLine = false;
    }
  }

  getLapStats(timeMs: number): LapStats {
    const endTime = this.lapStoppedTime ?? timeMs;
    return {
      currentLapMs: this.lapStartTime === undefined ? 0 : Math.max(0, endTime - this.lapStartTime),
      lapHistoryMs: this.lapHistoryMs,
      bestLapMs: this.bestLapMs,
    };
  }

  collidesWithBody(corners: readonly Point[]): boolean {
    const walls = [...this.leftWalls, ...this.rightWalls];
    for (const wall of walls) {
      for (let index = 0; index < corners.length; index += 1) {
        const nextIndex = (index + 1) % corners.length;
        if (
          this.segmentsIntersect(
            wall.from,
            wall.to,
            corners[index],
            corners[nextIndex],
          )
        ) {
          return true;
        }
      }
      if (
        this.pointIsInsideBody(wall.from, corners) ||
        this.pointIsInsideBody(wall.to, corners)
      ) {
        return true;
      }
    }
    return false;
  }

  startingAngle(): number {
    const first = this.centerline[0];
    const second = this.centerline[1];
    return first && second
      ? Math.atan2(second.y - first.y, second.x - first.x)
      : 0;
  }

  draw(context: CanvasRenderingContext2D): void {
    const line = this.centerline.length > 0 ? this.centerline : this.points;
    if (line.length > 1) {
      context.beginPath();
      context.moveTo(line[0].x, line[0].y);
      for (let index = 1; index < line.length; index += 1)
        context.lineTo(line[index].x, line[index].y);
      if (this.centerline.length > 0) context.closePath();
      context.strokeStyle = "#64748b";
      context.lineWidth = 2;
      context.setLineDash([8, 8]);
      context.stroke();
      context.setLineDash([]);
    }

    this.drawWalls(context, this.leftWalls);
    this.drawWalls(context, this.rightWalls);
    this.drawStartFinishLine(context);
    const start = this.points[0] ?? this.centerline[0];
    if (start) {
      context.fillStyle = "#4ade80";
      context.beginPath();
      context.arc(start.x, start.y, 7, 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawWalls(
    context: CanvasRenderingContext2D,
    walls: WallSegment[],
  ): void {
    context.strokeStyle = "#f8fafc";
    context.lineWidth = 4;
    for (const wall of walls) {
      context.beginPath();
      context.moveTo(wall.from.x, wall.from.y);
      context.lineTo(wall.to.x, wall.to.y);
      context.stroke();
    }
  }

  private drawStartFinishLine(context: CanvasRenderingContext2D): void {
    if (this.startFinish) {
      context.strokeStyle = "#f8fafc";
      context.lineWidth = 6;
      context.beginPath();
      context.moveTo(this.startFinish.from.x, this.startFinish.from.y);
      context.lineTo(this.startFinish.to.x, this.startFinish.to.y);
      context.stroke();
    }
  }

  private pointIsInsideBody(point: Point, corners: readonly Point[]): boolean {
    let hasPositiveSide = false;
    let hasNegativeSide = false;
    for (let index = 0; index < corners.length; index += 1) {
      const start = corners[index];
      const end = corners[(index + 1) % corners.length];
      const side =
        (end.x - start.x) * (point.y - start.y) -
        (end.y - start.y) * (point.x - start.x);
      hasPositiveSide ||= side > 0.000_001;
      hasNegativeSide ||= side < -0.000_001;
      if (hasPositiveSide && hasNegativeSide) return false;
    }
    return true;
  }

  private distanceToSegment(point: Point, segment: WallSegment): number {
    const dx = segment.to.x - segment.from.x;
    const dy = segment.to.y - segment.from.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point.x - segment.from.x, point.y - segment.from.y);
    const projection = Math.max(
      0,
      Math.min(1, ((point.x - segment.from.x) * dx + (point.y - segment.from.y) * dy) / lengthSquared),
    );
    return Math.hypot(
      point.x - (segment.from.x + dx * projection),
      point.y - (segment.from.y + dy * projection),
    );
  }

  private buildWalls(): boolean {
    if (!this.hasAcceptableCurvature() || !this.hasAcceptableProximity()) {
      return false;
    }

    const left: Point[] = [];
    const right: Point[] = [];
    const halfWidth = this.roadWidth / 2;
    for (let index = 0; index < this.centerline.length; index += 1) {
      const previous =
        this.centerline[
          (index - 1 + this.centerline.length) % this.centerline.length
        ];
      const current = this.centerline[index];
      const next = this.centerline[(index + 1) % this.centerline.length];
      const length = Math.hypot(next.x - previous.x, next.y - previous.y) || 1;
      const normalX = -(next.y - previous.y) / length;
      const normalY = (next.x - previous.x) / length;
      left.push({
        x: current.x + normalX * halfWidth,
        y: current.y + normalY * halfWidth,
      });
      right.push({
        x: current.x - normalX * halfWidth,
        y: current.y - normalY * halfWidth,
      });
    }
    this.leftWalls = this.toSegments(left);
    this.rightWalls = this.toSegments(right);
    return true;
  }

  private buildStartFinishLine(): void {
    this.startFinish = { from: this.leftWalls[0].from, to: this.rightWalls[0].from };
  }

  private resetLapData(): void {
    this.hasLeftStartLine = false;
    this.lapStartTime = undefined;
    this.lapStoppedTime = undefined;
    this.lapHistoryMs = [];
    this.bestLapMs = undefined;
  }

  private toSegments(points: Point[]): WallSegment[] {
    return points.map((from, index) => ({
      from,
      to: points[(index + 1) % points.length],
    }));
  }

  private hasAcceptableCurvature(): boolean {
    const sampleDistance = this.roadWidth / 2;
    for (let index = 0; index < this.centerline.length; index += 1) {
      const before = this.pointAtArcOffset(index, -1, sampleDistance);
      const current = this.centerline[index];
      const after = this.pointAtArcOffset(index, 1, sampleDistance);
      if (this.circumradius(before, current, after) < sampleDistance)
        return false;
    }
    return true;
  }

  private hasAcceptableProximity(): boolean {
    const edgeLengths = this.centerline.map((point, index) => {
      const next = this.centerline[(index + 1) % this.centerline.length];
      return Math.hypot(next.x - point.x, next.y - point.y);
    });
    const totalLength = edgeLengths.reduce(
      (total, length) => total + length,
      0,
    );
    const minimumArcDistance = this.roadWidth * 2;

    for (let first = 0; first < this.centerline.length; first += 1) {
      let forwardDistance = 0;
      for (
        let second = first + 1;
        second < this.centerline.length;
        second += 1
      ) {
        forwardDistance += edgeLengths[second - 1];
        const arcDistance = Math.min(
          forwardDistance,
          totalLength - forwardDistance,
        );
        const a = this.centerline[first];
        const b = this.centerline[second];
        if (
          arcDistance > minimumArcDistance &&
          Math.hypot(a.x - b.x, a.y - b.y) < this.roadWidth
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private pointAtArcOffset(
    index: number,
    direction: -1 | 1,
    distance: number,
  ): Point {
    let remaining = distance;
    let currentIndex = index;
    for (let step = 0; step < this.centerline.length; step += 1) {
      const nextIndex =
        (currentIndex + direction + this.centerline.length) %
        this.centerline.length;
      const current = this.centerline[currentIndex];
      const next = this.centerline[nextIndex];
      const segmentLength = Math.hypot(next.x - current.x, next.y - current.y);
      if (segmentLength > 0 && remaining <= segmentLength) {
        const t = remaining / segmentLength;
        return {
          x: current.x + (next.x - current.x) * t,
          y: current.y + (next.y - current.y) * t,
        };
      }
      remaining -= segmentLength;
      currentIndex = nextIndex;
    }
    return this.centerline[currentIndex];
  }

  private circumradius(a: Point, b: Point, c: Point): number {
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const twiceArea = Math.abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
    );
    if (twiceArea < 0.000_001) return Number.POSITIVE_INFINITY;
    return (ab * bc * ca) / (2 * twiceArea);
  }

  private resampleClosed(points: Point[], spacing: number): Point[] {
    const samples = [{ ...points[0] }];
    const totalLength = this.loopLength(points);
    let nextSampleDistance = spacing;
    let traveled = 0;

    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
      while (
        nextSampleDistance < totalLength &&
        nextSampleDistance <= traveled + segmentLength
      ) {
        const t = (nextSampleDistance - traveled) / segmentLength;
        samples.push({
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
        });
        nextSampleDistance += spacing;
      }
      traveled += segmentLength;
    }
    return samples;
  }

  private smoothWithMovingAverage(points: Point[], passes: number): Point[] {
    let result = points;
    for (let pass = 0; pass < passes; pass += 1) {
      result = result.map((point, index) => {
        const previous = result[(index - 1 + result.length) % result.length];
        const next = result[(index + 1) % result.length];
        return {
          x: (previous.x + point.x + next.x) / 3,
          y: (previous.y + point.y + next.y) / 3,
        };
      });
    }
    return result;
  }

  private smoothClosed(points: Point[]): Point[] {
    const result: Point[] = [];
    const steps = 4;
    for (let index = 0; index < points.length; index += 1) {
      const p0 = points[(index - 1 + points.length) % points.length];
      const p1 = points[index];
      const p2 = points[(index + 1) % points.length];
      const p3 = points[(index + 2) % points.length];
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        result.push({
          x:
            0.5 *
            (2 * p1.x +
              (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y:
            0.5 *
            (2 * p1.y +
              (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        });
      }
    }
    return result;
  }

  private loopLength(points: Point[]): number {
    return points.reduce((total, point, index) => {
      const next = points[(index + 1) % points.length];
      return total + Math.hypot(next.x - point.x, next.y - point.y);
    }, 0);
  }

  private hasSelfIntersection(points: Point[]): boolean {
    for (let first = 0; first < points.length; first += 1) {
      const firstEnd = (first + 1) % points.length;
      for (let second = first + 1; second < points.length; second += 1) {
        const secondEnd = (second + 1) % points.length;
        if (first === second || firstEnd === second || secondEnd === first)
          continue;
        if (
          this.segmentsIntersect(
            points[first],
            points[firstEnd],
            points[second],
            points[secondEnd],
          )
        )
          return true;
      }
    }
    return false;
  }

  private segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
    const side = (first: Point, second: Point, third: Point) =>
      (second.x - first.x) * (third.y - first.y) -
      (second.y - first.y) * (third.x - first.x);
    const abC = side(a, b, c);
    const abD = side(a, b, d);
    const cdA = side(c, d, a);
    const cdB = side(c, d, b);
    const epsilon = 0.000_001;
    const crosses = (first: number, second: number) =>
      (first > epsilon && second < -epsilon) ||
      (first < -epsilon && second > epsilon);
    const onSegment = (start: Point, point: Point, end: Point) =>
      point.x >= Math.min(start.x, end.x) - epsilon &&
      point.x <= Math.max(start.x, end.x) + epsilon &&
      point.y >= Math.min(start.y, end.y) - epsilon &&
      point.y <= Math.max(start.y, end.y) + epsilon;

    if (crosses(abC, abD) && crosses(cdA, cdB)) return true;

    // Collinear segments only intersect when their finite ranges overlap.
    return (
      (Math.abs(abC) <= epsilon && onSegment(a, c, b)) ||
      (Math.abs(abD) <= epsilon && onSegment(a, d, b)) ||
      (Math.abs(cdA) <= epsilon && onSegment(c, a, d)) ||
      (Math.abs(cdB) <= epsilon && onSegment(c, b, d))
    );
  }
}
