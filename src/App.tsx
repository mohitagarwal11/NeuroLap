import { useEffect, useRef, useState, type PointerEvent } from "react";
import { GamepadInput } from "./input/GamepadInput";
import { KeyboardInput } from "./input/KeyboardInput";
import { Car } from "./sim/Car";
import { type Point, Track, TrackState } from "./sim/Track";
import "./App.css";

const editorCloseDistance = 36;
const editorPrompt = "Draw a loop, then release near the green start marker.";

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorOpenRef = useRef(true);
  const editorPointsRef = useRef<Point[]>([]);
  const carRef = useRef<Car | null>(null);
  const acceptTrackRef = useRef<(points: readonly Point[]) => void>(() => {});
  const [isEditorOpen, setIsEditorOpen] = useState(true);
  const [editorPoints, setEditorPoints] = useState<Point[]>([]);
  const [editorMessage, setEditorMessage] = useState(editorPrompt);

  const clearEditor = () => {
    editorPointsRef.current = [];
    setEditorPoints([]);
    setEditorMessage(editorPrompt);
  };

  const openEditor = () => {
    editorOpenRef.current = true;
    if (carRef.current) {
      carRef.current.throttle = 0;
      carRef.current.steer = 0;
    }
    clearEditor();
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    editorOpenRef.current = false;
    setIsEditorOpen(false);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const car = new Car(canvas.clientWidth / 2, canvas.clientHeight / 2);
    carRef.current = car;
    let track = new Track(car.width);
    let frameId = 0;
    let previousTime: number | undefined;
    let lastHudUpdate = Number.NEGATIVE_INFINITY;
    let lapStats = track.getLapStats(0);
    let controlSource: "keyboard" | "gamepad" = "keyboard";

    const startDriving = () => {
      if (editorOpenRef.current) return;
      const start = track.startDriving();
      if (!start) return;
      car.reset(start.x, start.y, track.startingAngle());
    };
    const restart = () => {
      if (!editorOpenRef.current && track.restart()) startDriving();
    };
    const gamepad = new GamepadInput((controls) => {
      if (editorOpenRef.current) return;
      if (controls.active) {
        controlSource = "gamepad";
        car.throttle = controls.throttle;
        car.steer = controls.steer;
      } else if (controlSource === "gamepad") {
        car.throttle = 0;
        car.steer = 0;
      }
    }, startDriving);
    const input = new KeyboardInput(
      car,
      startDriving,
      restart,
      () => {
        if (!editorOpenRef.current) gamepad.selectNextGamepad();
      },
      () => {
        if (editorOpenRef.current) {
          car.throttle = 0;
          car.steer = 0;
          return;
        }
        controlSource = "keyboard";
      },
    );

    const formatLapTime = (milliseconds: number | undefined) => {
      if (milliseconds === undefined) return "--:--.---";
      const minutes = Math.floor(milliseconds / 60_000);
      const seconds = Math.floor((milliseconds % 60_000) / 1_000);
      const millis = Math.floor(milliseconds % 1_000);
      return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
    };
    const resizeCanvas = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const render = () => {
      const { width, height } = canvas.getBoundingClientRect();
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#111827";
      context.fillRect(0, 0, width, height);
      track.draw(context);
      context.fillStyle = "#e2e8f0";
      context.font = "16px system-ui";
      context.fillText(track.message, 18, 30);
      context.fillText(`${gamepad.selectedGamepadLabel()} — press G to switch`, 18, 54);
      context.fillText(`Lap ${formatLapTime(lapStats.currentLapMs)}`, 18, 78);
      context.fillText(`Best ${formatLapTime(lapStats.bestLapMs)}`, 18, 102);
      const history = lapStats.lapHistoryMs.slice(-3).map(formatLapTime).join("  ") || "—";
      context.fillText(`Previous ${history}`, 18, 126);
      if (track.state === TrackState.DRIVING || track.state === TrackState.CRASHED) car.draw(context);
    };
    acceptTrackRef.current = (points) => {
      const bounds = canvas.getBoundingClientRect();
      const inset = track.roadWidth / 2 + car.length;
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxY = Math.max(...points.map((point) => point.y));
      const sourceWidth = Math.max(1, maxX - minX);
      const sourceHeight = Math.max(1, maxY - minY);
      const targetWidth = Math.max(1, bounds.width - inset * 2);
      const targetHeight = Math.max(1, bounds.height - inset * 2);
      const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
      const offsetX = (bounds.width - sourceWidth * scale) / 2;
      const offsetY = (bounds.height - sourceHeight * scale) / 2;
      const scaled = points.map((point) => ({
        x: offsetX + (point.x - minX) * scale,
        y: offsetY + (point.y - minY) * scale,
      }));
      const candidate = new Track(car.width);
      if (!candidate.load(scaled)) {
        setEditorMessage(candidate.message);
        return;
      }
      track = candidate;
      lapStats = track.getLapStats(performance.now());
      closeEditor();
    };
    const tick = (time: number) => {
      const deltaSeconds = Math.min((time - (previousTime ?? time)) / 1000, 0.1);
      previousTime = time;
      if (!editorOpenRef.current) {
        gamepad.update();
        if (track.state === TrackState.DRIVING) {
          const previousPosition = { x: car.x, y: car.y };
          car.update(deltaSeconds);
          track.recordRaceProgress(previousPosition, { x: car.x, y: car.y }, car.speed, time);
          if (track.collidesWithBody(car.getBodyCorners())) track.crash(time);
        }
        if (time - lastHudUpdate >= 250) {
          lapStats = track.getLapStats(time);
          lastHudUpdate = time;
        }
      }
      render();
      frameId = requestAnimationFrame(tick);
    };

    resizeCanvas();
    input.attach();
    window.addEventListener("resize", resizeCanvas);
    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resizeCanvas);
      input.detach();
      acceptTrackRef.current = () => {};
      carRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = editorCanvasRef.current;
    if (!canvas || !isEditorOpen) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.round(bounds.width * pixelRatio);
      canvas.height = Math.round(bounds.height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.fillStyle = "#0f172a";
      context.fillRect(0, 0, bounds.width, bounds.height);
      if (editorPoints.length > 1) {
        context.beginPath();
        context.moveTo(editorPoints[0].x, editorPoints[0].y);
        editorPoints.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.strokeStyle = "#94a3b8";
        context.lineWidth = 3;
        context.lineCap = "round";
        context.stroke();
      }
      const start = editorPoints[0];
      if (start) {
        context.beginPath();
        context.arc(start.x, start.y, 7, 0, Math.PI * 2);
        context.fillStyle = "#4ade80";
        context.fill();
      }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [editorPoints, isEditorOpen]);

  const positionFor = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = positionFor(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    editorPointsRef.current = [point];
    setEditorPoints([point]);
    setEditorMessage(editorPrompt);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = positionFor(event);
    const points = editorPointsRef.current;
    const previous = points[points.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) < 5) return;
    editorPointsRef.current = [...points, point];
    setEditorPoints(editorPointsRef.current);
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = positionFor(event);
    event.currentTarget.releasePointerCapture(event.pointerId);
    const points = editorPointsRef.current;
    const start = points[0];
    if (!start || Math.hypot(point.x - start.x, point.y - start.y) > editorCloseDistance) {
      setEditorMessage("Release near the green start marker to close the loop.");
      return;
    }
    acceptTrackRef.current(points);
  };

  return (
    <main className="game-shell">
      <canvas ref={canvasRef} className="game-canvas" aria-label="Car simulation" />
      <button className="new-track-button" type="button" onClick={openEditor}>New Track</button>
      {isEditorOpen && (
        <div className="track-editor-backdrop" role="presentation">
          <section className="track-editor" role="dialog" aria-modal="true" aria-labelledby="track-editor-title">
            <div className="track-editor-header">
              <div>
                <h1 id="track-editor-title">Draw a new track</h1>
                <p>{editorMessage}</p>
              </div>
              <div className="track-editor-actions">
                <button type="button" onClick={clearEditor}>Clear</button>
                <button type="button" onClick={closeEditor}>Cancel</button>
              </div>
            </div>
            <canvas ref={editorCanvasRef} className="track-editor-canvas" aria-label="Track drawing area"
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
