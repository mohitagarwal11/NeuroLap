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
    this.roadWidth = carWidth * 7;
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
    return this.complete();
  }

  /**
   * Builds a track from an already-closed stroke. This lets callers validate a
   * candidate without changing the track currently in use.
   */
  load(points: readonly Point[]): boolean {
    this.state = TrackState.DRAWING;
    this.points = points.map(({ x, y }) => ({ x, y }));
    this.centerline = [];
    this.leftWalls = [];
    this.rightWalls = [];
    this.startFinish = undefined;
    this.resetLapData();
    this.message = "Draw a loop, then release close to its start.";
    return this.complete();
  }

  private complete(): boolean {
    if (this.points.length < 3 || Math.abs(this.signedArea(this.points)) < 1) {
      this.message =
        "Track must enclose an area. Draw a closed loop, not a line.";
      return false;
    }
    if (this.hasSelfIntersection(this.points)) {
      this.message = "Track crosses itself. Draw a loop without intersections.";
      return false;
    }

    const centerline = this.resampleClosed(this.points, 12);
    if (this.hasSelfIntersection(centerline)) {
      this.message =
        "Track crosses itself. Figure-eight tracks are not supported.";
      return false;
    }

    this.centerline = centerline;
    if (!this.buildWalls()) {
      this.centerline = [];
      this.message =
        "Road is too narrow here for walls to form a usable corridor.";
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

  /** The AI reads the same wall geometry used for collision detection. */
  raycast(origin: Point, angle: number, maxDistance: number): number {
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    let nearest = maxDistance;
    for (const wall of [...this.leftWalls, ...this.rightWalls]) {
      const distance = this.raySegmentDistance(origin, direction, wall);
      if (distance !== undefined) nearest = Math.min(nearest, distance);
    }
    return nearest;
  }

  /** Distance around the centreline at the closest point to a world position. */
  progressAt(point: Point): number {
    if (this.centerline.length < 2) return 0;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestProgress = 0;
    let traveled = 0;
    for (let index = 0; index < this.centerline.length; index += 1) {
      const from = this.centerline[index];
      const to = this.centerline[(index + 1) % this.centerline.length];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const projection = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (length * length)));
      const closestX = from.x + dx * projection;
      const closestY = from.y + dy * projection;
      const distanceSquared = (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestProgress = traveled + projection * length;
      }
      traveled += length;
    }
    return bestProgress;
  }

  get length(): number {
    return this.centerline.length < 2 ? 0 : this.loopLength(this.centerline);
  }

  get startPoint(): Point | undefined {
    return this.centerline[0];
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
      if (
        this.distanceToSegment(currentPosition, this.startFinish) >
        this.roadWidth / 4
      ) {
        this.hasLeftStartLine = true;
      }
      return;
    }

    if (
      this.segmentsIntersect(
        previousPosition,
        currentPosition,
        this.startFinish.from,
        this.startFinish.to,
      )
    ) {
      const lapTime = timeMs - this.lapStartTime;
      this.lapHistoryMs.push(lapTime);
      this.bestLapMs = Math.min(
        this.bestLapMs ?? Number.POSITIVE_INFINITY,
        lapTime,
      );
      this.lapStartTime = timeMs;
      this.hasLeftStartLine = false;
    }
  }

  getLapStats(timeMs: number): LapStats {
    const endTime = this.lapStoppedTime ?? timeMs;
    return {
      currentLapMs:
        this.lapStartTime === undefined
          ? 0
          : Math.max(0, endTime - this.lapStartTime),
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
    this.drawRoadSurface(context);
    if (line.length > 1) {
      context.beginPath();
      context.moveTo(line[0].x, line[0].y);
      for (let index = 1; index < line.length; index += 1)
        context.lineTo(line[index].x, line[index].y);
      if (this.centerline.length > 0) context.closePath();
      // The broken white line makes the center of the dark asphalt readable
      // without changing any of the driving or collision rules.
      context.strokeStyle = "#f8fafc";
      context.lineWidth = 2;
      context.setLineDash([14, 12]);
      context.stroke();
      context.setLineDash([]);
    }

    this.drawWalls(context, this.leftWalls);
    this.drawWalls(context, this.rightWalls);
    this.drawStartFinishLine(context);
    const start = this.points[0] ?? this.centerline[0];
    if (start) {
      context.fillStyle = "#facc15";
      context.beginPath();
      context.arc(start.x, start.y, 7, 0, Math.PI * 2);
      context.fill();
    }
  }

  /** Paint the playable corridor before drawing its road markings. */
  private drawRoadSurface(context: CanvasRenderingContext2D): void {
    if (this.centerline.length < 2) return;

    context.beginPath();
    context.moveTo(this.centerline[0].x, this.centerline[0].y);
    for (let index = 1; index < this.centerline.length; index += 1)
      context.lineTo(this.centerline[index].x, this.centerline[index].y);
    context.closePath();

    // The centreline is continuous, unlike the collision walls which may be
    // repaired separately around a sharp turn. Drawing the surface from it
    // prevents gaps or wedges where those repaired boundaries meet.
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#4b5563";
    context.lineWidth = this.roadWidth + 10;
    context.stroke();
    context.strokeStyle = "#1b1f24";
    context.lineWidth = this.roadWidth;
    context.stroke();
    context.lineCap = "butt";
    context.lineJoin = "miter";
  }

  private drawWalls(
    context: CanvasRenderingContext2D,
    walls: WallSegment[],
  ): void {
    context.strokeStyle = "#f8fafc";
    context.lineWidth = 3;
    for (const wall of walls) {
      context.beginPath();
      context.moveTo(wall.from.x, wall.from.y);
      context.lineTo(wall.to.x, wall.to.y);
      context.stroke();
    }
  }

  private drawStartFinishLine(context: CanvasRenderingContext2D): void {
    if (!this.startFinish || this.centerline.length < 2) return;

    const { from, to } = this.startFinish;
    const width = Math.hypot(to.x - from.x, to.y - from.y);
    const tangent = Math.atan2(
      this.centerline[1].y - this.centerline[0].y,
      this.centerline[1].x - this.centerline[0].x,
    );
    const columns = 8;
    const tileWidth = width / columns;
    const tileLength = 6;
    const centerX = (from.x + to.x) / 2;
    const centerY = (from.y + to.y) / 2;

    context.save();
    context.translate(centerX, centerY);
    context.rotate(tangent);
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        context.fillStyle = (row + column) % 2 === 0 ? "#f8fafc" : "#050505";
        context.fillRect(
          -tileLength + row * tileLength,
          -width / 2 + column * tileWidth,
          tileLength,
          tileWidth,
        );
      }
    }
    context.restore();
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
    if (lengthSquared === 0)
      return Math.hypot(point.x - segment.from.x, point.y - segment.from.y);
    const projection = Math.max(
      0,
      Math.min(
        1,
        ((point.x - segment.from.x) * dx + (point.y - segment.from.y) * dy) /
          lengthSquared,
      ),
    );
    return Math.hypot(
      point.x - (segment.from.x + dx * projection),
      point.y - (segment.from.y + dy * projection),
    );
  }

  private raySegmentDistance(
    origin: Point,
    direction: Point,
    segment: WallSegment,
  ): number | undefined {
    const edgeX = segment.to.x - segment.from.x;
    const edgeY = segment.to.y - segment.from.y;
    const offsetX = segment.from.x - origin.x;
    const offsetY = segment.from.y - origin.y;
    const cross = direction.x * edgeY - direction.y * edgeX;
    if (Math.abs(cross) < 0.000_001) return undefined;
    const rayDistance = (offsetX * edgeY - offsetY * edgeX) / cross;
    const segmentPosition = (offsetX * direction.y - offsetY * direction.x) / cross;
    return rayDistance >= 0 && segmentPosition >= 0 && segmentPosition <= 1
      ? rayDistance
      : undefined;
  }

  private buildWalls(): boolean {
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
    const repairedLeft = this.repairWall(left);
    const repairedRight = this.repairWall(right);
    const leftWalls = this.toSegments(repairedLeft);
    const rightWalls = this.toSegments(repairedRight);
    if (
      leftWalls.length < 3 ||
      rightWalls.length < 3 ||
      this.wallsIntersect(leftWalls, rightWalls)
    ) {
      return false;
    }
    this.leftWalls = leftWalls;
    this.rightWalls = rightWalls;
    return true;
  }

  private buildStartFinishLine(): void {
    this.startFinish = {
      from: this.leftWalls[0].from,
      to: this.rightWalls[0].from,
    };
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

  /**
   * Offset polylines can fold back on themselves at a tight turn. At a
   * crossing there are two possible closed boundaries; retain the one with
   * the larger enclosed area. This removes the small inward spur while
   * preserving the full outside/inside wall around the circuit.
   */
  private repairWall(points: Point[]): Point[] {
    let repaired = points.map((point) => ({ ...point }));
    const trimmed = new Set<Point>();
    for (
      let pass = 0;
      pass < points.length && repaired.length >= 3;
      pass += 1
    ) {
      const crossing = this.firstWallIntersection(repaired);
      if (!crossing) break;
      const { first, second, point } = crossing;
      const wrappingBoundary = [
        ...repaired.slice(0, first + 1),
        point,
        ...repaired.slice(second + 1),
      ];
      const enclosedBoundary = [
        point,
        ...repaired.slice(first + 1, second + 1),
      ];
      repaired =
        Math.abs(this.signedArea(wrappingBoundary)) >=
        Math.abs(this.signedArea(enclosedBoundary))
          ? wrappingBoundary
          : enclosedBoundary;
      trimmed.add(point);
    }
    return this.bevelTrimmedCorners(repaired, trimmed);
  }

  private firstWallIntersection(
    points: readonly Point[],
  ): { first: number; second: number; point: Point } | undefined {
    for (let first = 0; first < points.length; first += 1) {
      const firstEnd = (first + 1) % points.length;
      for (let second = first + 1; second < points.length; second += 1) {
        const secondEnd = (second + 1) % points.length;
        if (first === second || firstEnd === second || secondEnd === first)
          continue;
        const point = this.properSegmentIntersection(
          points[first],
          points[firstEnd],
          points[second],
          points[secondEnd],
        );
        if (point) return { first, second, point };
      }
    }
    return undefined;
  }

  private bevelTrimmedCorners(
    points: readonly Point[],
    trimmed: ReadonlySet<Point>,
  ): Point[] {
    const result: Point[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      if (!trimmed.has(current)) {
        result.push(current);
        continue;
      }
      const previous = points[(index - 1 + points.length) % points.length];
      const next = points[(index + 1) % points.length];
      const beforeLength = Math.hypot(
        current.x - previous.x,
        current.y - previous.y,
      );
      const afterLength = Math.hypot(next.x - current.x, next.y - current.y);
      const inset = Math.min(
        this.roadWidth * 0.12,
        beforeLength / 3,
        afterLength / 3,
      );
      if (inset <= 0.000_001) {
        result.push(current);
        continue;
      }
      result.push({
        x: current.x + ((previous.x - current.x) / beforeLength) * inset,
        y: current.y + ((previous.y - current.y) / beforeLength) * inset,
      });
      result.push({
        x: current.x + ((next.x - current.x) / afterLength) * inset,
        y: current.y + ((next.y - current.y) / afterLength) * inset,
      });
    }
    return result;
  }

  private wallsIntersect(
    left: readonly WallSegment[],
    right: readonly WallSegment[],
  ): boolean {
    return left.some((leftSegment) =>
      right.some((rightSegment) =>
        this.segmentsIntersect(
          leftSegment.from,
          leftSegment.to,
          rightSegment.from,
          rightSegment.to,
        ),
      ),
    );
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

  private loopLength(points: Point[]): number {
    return points.reduce((total, point, index) => {
      const next = points[(index + 1) % points.length];
      return total + Math.hypot(next.x - point.x, next.y - point.y);
    }, 0);
  }

  private signedArea(points: readonly Point[]): number {
    return (
      points.reduce((area, point, index) => {
        const next = points[(index + 1) % points.length];
        return area + point.x * next.y - next.x * point.y;
      }, 0) / 2
    );
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

  private properSegmentIntersection(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
  ): Point | undefined {
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const cdX = d.x - c.x;
    const cdY = d.y - c.y;
    const denominator = abX * cdY - abY * cdX;
    if (Math.abs(denominator) < 0.000_001) return undefined;
    const acX = c.x - a.x;
    const acY = c.y - a.y;
    const t = (acX * cdY - acY * cdX) / denominator;
    const u = (acX * abY - acY * abX) / denominator;
    const epsilon = 0.000_001;
    if (t <= epsilon || t >= 1 - epsilon || u <= epsilon || u >= 1 - epsilon)
      return undefined;
    return { x: a.x + abX * t, y: a.y + abY * t };
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
