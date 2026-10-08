import { useEffect, useRef } from "react";
import { KeyboardInput } from "./input/KeyboardInput";
import { GamepadInput } from "./input/GamepadInput";
import { Car } from "./sim/Car";
import { Track, TrackState } from "./sim/Track";
import "./App.css";

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const car = new Car(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const track = new Track(car.width);
    const startDriving = () => {
      const start = track.startDriving();
      if (!start) return;
      car.x = start.x;
      car.y = start.y;
      car.angle = track.startingAngle();
      car.speed = 0;
    };
    const restart = () => {
      if (track.restart()) startDriving();
    };
    let controlSource: "keyboard" | "gamepad" = "keyboard";
    const gamepad = new GamepadInput((controls) => {
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
      () => gamepad.selectNextGamepad(),
      () => {
        controlSource = "keyboard";
      },
    );
    let frameId = 0;
    let previousTime: number | undefined;

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
      if (track.state === TrackState.DRIVING || track.state === TrackState.CRASHED) car.draw(context);
    };

    const tick = (time: number) => {
      const deltaSeconds = Math.min((time - (previousTime ?? time)) / 1000, 0.1);
      previousTime = time;
      gamepad.update();
      if (track.state === TrackState.DRIVING) {
        car.update(deltaSeconds);
        if (track.collidesWithBody(car.getBodyCorners())) track.crash();
      }
      render();
      frameId = requestAnimationFrame(tick);
    };

    resizeCanvas();
    input.attach();
    window.addEventListener("resize", resizeCanvas);
    frameId = requestAnimationFrame(tick);

    const positionFor = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const onPointerDown = (event: PointerEvent) => {
      if (track.state === TrackState.DRIVING) return;
      const point = positionFor(event);
      canvas.setPointerCapture(event.pointerId);
      track.begin(point.x, point.y);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!canvas.hasPointerCapture(event.pointerId)) return;
      const point = positionFor(event);
      track.addPoint(point.x, point.y);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!canvas.hasPointerCapture(event.pointerId)) return;
      const point = positionFor(event);
      track.finish(point.x, point.y);
      canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resizeCanvas);
      input.detach();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  return <canvas ref={canvasRef} className="game-canvas" aria-label="Car simulation" />;
}

export default App;
