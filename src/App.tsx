import { useEffect, useRef, useState, type PointerEvent } from "react";
import { GamepadInput } from "./input/GamepadInput";
import { KeyboardInput } from "./input/KeyboardInput";
import { Car } from "./sim/Car";
import { type Point, Track, TrackState } from "./sim/Track";
import { TrainingManager, type TrainingStatus } from "./ai/TrainingManager";
import { defaultTrainingSettings, type TrainingSettings } from "./ai/types";
import "./App.css";

const editorCloseDistance = 36;
const editorPrompt = "Draw a loop, then release near the green start marker.";
const trackStorageKey = "neurolap-track-v1";
const formatAiTime = (seconds: number | undefined): string =>
  seconds === undefined ? "--:--.---" :
    `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
const formatAiDelta = (seconds: number | undefined): string =>
  seconds === undefined ? "--.---" : `${seconds >= 0 ? "+" : "−"}${Math.abs(seconds).toFixed(3)}s`;

const loadSavedTrack = (): Point[] | undefined => {
  try {
    const parsed = JSON.parse(localStorage.getItem(trackStorageKey) ?? "null") as unknown;
    if (!Array.isArray(parsed) || parsed.length < 3) return undefined;
    if (!parsed.every((point) => typeof point === "object" && point !== null && "x" in point && "y" in point && typeof point.x === "number" && typeof point.y === "number")) return undefined;
    return parsed as Point[];
  } catch {
    return undefined;
  }
};

const saveTrack = (points: readonly Point[]): void => {
  try { localStorage.setItem(trackStorageKey, JSON.stringify(points)); } catch { /* storage is optional */ }
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorCanvasRef = useRef<HTMLCanvasElement>(null);
  const [savedTrack] = useState<Point[] | undefined>(loadSavedTrack);
  const editorOpenRef = useRef(savedTrack === undefined);
  const editorPointsRef = useRef<Point[]>([]);
  const carRef = useRef<Car | null>(null);
  const acceptTrackRef = useRef<(points: readonly Point[]) => void>(() => {});
  const aiModeRef = useRef(false);
  const trainingActionsRef = useRef<{
    start: () => void;
    pause: () => void;
    reset: () => void;
    settings: (settings: TrainingSettings) => void;
  }>({
    start: () => {},
    pause: () => {},
    reset: () => {},
    settings: () => {},
  });
  const [isEditorOpen, setIsEditorOpen] = useState(savedTrack === undefined);
  const [editorPoints, setEditorPoints] = useState<Point[]>([]);
  const [editorMessage, setEditorMessage] = useState(editorPrompt);
  const [aiMode, setAiMode] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | undefined>();
  const [trainingSettings, setTrainingSettings] = useState<TrainingSettings>(defaultTrainingSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const setAiControlMode = (enabled: boolean) => {
    aiModeRef.current = enabled;
    setAiMode(enabled);
  };

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
    const training = new TrainingManager();
    const camera = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    setTrainingSettings(training.settings);
    if (savedTrack && !track.load(savedTrack)) {
      try { localStorage.removeItem(trackStorageKey); } catch { /* storage is optional */ }
      editorOpenRef.current = true;
      setIsEditorOpen(true);
    }

    const startDriving = () => {
      if (editorOpenRef.current) return;
      if (aiModeRef.current) {
        if (track.state === TrackState.READY) track.startDriving();
        training.start(track, car.width);
        return;
      }
      const start = track.startDriving();
      if (!start) return;
      car.reset(start.x, start.y, track.startingAngle());
    };
    const restart = () => {
      if (!editorOpenRef.current && track.restart()) startDriving();
    };
    const gamepad = new GamepadInput((controls) => {
      if (editorOpenRef.current || aiModeRef.current) return;
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
        if (aiModeRef.current) return;
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
      // A muted infield gives the black asphalt and white paint some contrast.
      context.fillStyle = "#254b35";
      context.fillRect(0, 0, width, height);
      if (aiModeRef.current) {
        const focus = training.focusAgent();
        if (focus) {
          camera.x += (focus.car.x - camera.x) * 0.08;
          camera.y += (focus.car.y - camera.y) * 0.08;
        }
        context.save();
        context.translate(width / 2 - camera.x, height / 2 - camera.y);
      }
      track.draw(context);
      if (aiModeRef.current) training.draw(context);
      if (aiModeRef.current) context.restore();
      context.fillStyle = "#e2e8f0";
      context.font = "16px system-ui";
      context.fillText(track.message, 18, 30);
      context.fillText(`${gamepad.selectedGamepadLabel()} — press G to switch`, 18, 54);
      context.fillText(`Lap ${formatLapTime(lapStats.currentLapMs)}`, 18, 78);
      context.fillText(`Best ${formatLapTime(lapStats.bestLapMs)}`, 18, 102);
      const history = lapStats.lapHistoryMs.slice(-3).map(formatLapTime).join("  ") || "—";
      context.fillText(`Previous ${history}`, 18, 126);
      if (!aiModeRef.current && (track.state === TrackState.DRIVING || track.state === TrackState.CRASHED)) car.draw(context);
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
      saveTrack(scaled);
      lapStats = track.getLapStats(performance.now());
      if (aiModeRef.current) {
        track.startDriving();
        training.reset(track, car.width, false, true, true);
        training.pause();
        setTrainingSettings(training.settings);
        setTrainingStatus(training.status());
      }
      closeEditor();
    };
    trainingActionsRef.current = {
      start: () => {
        if (editorOpenRef.current) return;
        if (track.state === TrackState.READY) track.startDriving();
        training.start(track, car.width);
      },
      pause: () => training.pause(),
      reset: () => {
        if (track.state === TrackState.READY) track.startDriving();
        training.reset(track, car.width, true);
        training.pause();
        setTrainingStatus(training.status());
      },
      settings: (settings) => training.setSettings(settings),
    };
    const tick = (time: number) => {
      const deltaSeconds = Math.min((time - (previousTime ?? time)) / 1000, 0.1);
      previousTime = time;
      if (!editorOpenRef.current) {
        if (!aiModeRef.current) gamepad.update();
        if (aiModeRef.current) {
          training.step(track, deltaSeconds);
        } else if (track.state === TrackState.DRIVING) {
          const previousPosition = { x: car.x, y: car.y };
          car.update(deltaSeconds);
          track.recordRaceProgress(previousPosition, { x: car.x, y: car.y }, car.speed, time);
          if (track.collidesWithBody(car.getBodyCorners())) track.crash(time);
        }
        if (time - lastHudUpdate >= 250) {
          lapStats = track.getLapStats(time);
          if (aiModeRef.current) setTrainingStatus(training.status());
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
      trainingActionsRef.current = { start: () => {}, pause: () => {}, reset: () => {}, settings: () => {} };
    };
  }, [savedTrack]);

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

  const updateTrainingSetting = (key: keyof TrainingSettings, value: number) => {
    const next = { ...trainingSettings, [key]: value };
    setTrainingSettings(next);
    trainingActionsRef.current.settings(next);
  };

  return (
    <main className="game-shell">
      <canvas ref={canvasRef} className="game-canvas" aria-label="Car simulation" />
      <button className="new-track-button" type="button" onClick={openEditor}>New Track</button>
      <section className="ai-controls" aria-label="AI driver controls">
        <button type="button" onClick={() => setAiControlMode(!aiMode)}>
          {aiMode ? "AI Mode" : "Human Mode"}
        </button> 
        {aiMode && <>
          <button type="button" onClick={() => trainingActionsRef.current.start()}>Start</button>
          <button type="button" onClick={() => trainingActionsRef.current.pause()}>Pause</button>
          <button type="button" onClick={() => {
            if (window.confirm("Reset AI training and remove the saved best brain?")) trainingActionsRef.current.reset();
          }}>Reset</button>
          <button type="button" aria-label="AI settings" onClick={() => setSettingsOpen(!settingsOpen)}>⚙</button>
          {trainingStatus && <p>
            Gen {trainingStatus.generation} · {trainingStatus.alive}/{trainingStatus.population} alive<br />
            Best {Math.round(trainingStatus.generationBest)} · All-time {Math.round(trainingStatus.bestEver)}<br />
            Current best {formatAiTime(trainingStatus.generationBestLapSeconds)} · Record {formatAiTime(trainingStatus.bestLapSeconds)}
            <br />Δ vs record {formatAiDelta(trainingStatus.generationBestDeltaSeconds)}
            <br />Leader record misses {trainingStatus.leaderRecordMisses}/3
            {trainingStatus.alive < trainingStatus.population * 0.25 && <><br />Survivor laps {trainingStatus.lowPopulationLaps}/2</>}
          </p>}
        </>}
      </section>
      {aiMode && settingsOpen && (
        <aside className="ai-settings" aria-label="AI training settings">
          <h2>AI settings</h2>
          {(
            [
              ["populationSize", "Population", 5, 100, 1],
              ["elitePercent", "Elite %", 0.02, 0.5, 0.01],
              ["mutationRate", "Mutation rate", 0, 1, 0.01],
              ["mutationStrength", "Mutation strength", 0.01, 2, 0.01],
              ["crossoverRate", "Crossover rate", 0, 1, 0.01],
              ["simulationSpeed", "Simulation speed", 0.25, 4, 0.25],
              ["sensorRange", "Sensor range", 40, 500, 10],
              ["progressReward", "Progress reward", 0.01, 20, 0.1],
              ["lapReward", "Lap reward", 10, 10000, 10],
              ["crashPenalty", "Crash penalty", 0, 1000, 5],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <label key={key}>{label}
              <input type="number" min={min} max={max} step={step} value={trainingSettings[key]}
                onChange={(event) => updateTrainingSetting(key, Number(event.target.value))} />
            </label>
          ))}
          <small>Changes apply to the next generation.</small>
        </aside>
      )}
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
