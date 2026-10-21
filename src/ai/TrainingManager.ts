import { Car } from "../sim/Car";
import { Track } from "../sim/Track";
import { NeuralNetwork } from "./NeuralNetwork";
import {
  defaultTrainingSettings,
  type AiObservation,
  type TrainingSettings,
} from "./types";

const storageKey = "neurolap-ai-v1";
const sensorAngles = [-0.8, -0.35, 0, 0.35, 0.8];
const stalledGenerationSeconds = 6;
const meaningfulProgress = 0.5;
const leaderRecordMissLimit = 3;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export type TrainingAgent = {
  car: Car;
  brain: NeuralNetwork;
  reward: number;
  totalProgress: number;
  lapStartProgress: number;
  lastProgress: number;
  lapSeconds: number;
  laps: number;
  lapJustCompleted: boolean;
  lastLapWasRecord: boolean;
  lastLapSeconds: number | undefined;
  previousLapSeconds: number | undefined;
  active: boolean;
};

export type TrainingStatus = {
  generation: number;
  alive: number;
  population: number;
  generationBest: number;
  bestEver: number;
  completedLaps: number;
  generationBestLapSeconds: number | undefined;
  bestLapSeconds: number | undefined;
  lowPopulationLaps: number;
  leaderLapSeconds: number;
  leaderRecordMisses: number;
  leaderLastLapSeconds: number | undefined;
  leaderLapDeltaSeconds: number | undefined;
  generationBestDeltaSeconds: number | undefined;
  running: boolean;
};

type SavedTraining = {
  brain: number[][];
  bestLapSeconds?: number;
};

/** Evolves a compact population locally; it never changes the Track or Car rules. */
export class TrainingManager {
  settings: TrainingSettings;
  readonly agents: TrainingAgent[] = [];
  running = false;
  generation = 0;
  bestEverReward = Number.NEGATIVE_INFINITY;
  bestBrain: NeuralNetwork | undefined;
  completedLaps = 0;
  private generationBestLapSeconds: number | undefined;
  bestLapSeconds: number | undefined;
  private generationBestDeltaSeconds: number | undefined;
  private pendingSettings: TrainingSettings | undefined;
  private lowPopulationLaps = 0;
  private lowPopulationPhase = false;
  private bestGenerationProgress = 0;
  private stalledSeconds = 0;
  private leaderRecordMisses = 0;
  private bestLapAgent: TrainingAgent | undefined;

  constructor(settings = defaultTrainingSettings) {
    const saved = TrainingManager.load();
    this.settings = { ...defaultTrainingSettings, ...settings };
    this.bestBrain = saved?.brain ? NeuralNetwork.fromJSON(saved.brain) : undefined;
  }

  start(track: Track, carWidth: number): void {
    if (!track.startPoint) return;
    if (this.agents.length === 0) this.createGeneration(track, carWidth);
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  reset(
    track: Track,
    carWidth: number,
    clearSaved = false,
    resetLapRecord = clearSaved,
    resetSettings = false,
  ): void {
    this.agents.length = 0;
    this.generation = 0;
    this.completedLaps = 0;
    this.lowPopulationLaps = 0;
    this.lowPopulationPhase = false;
    this.bestGenerationProgress = 0;
    this.stalledSeconds = 0;
    this.leaderRecordMisses = 0;
    this.pendingSettings = undefined;
    if (resetSettings) this.settings = { ...defaultTrainingSettings };
    if (clearSaved) {
      this.bestBrain = undefined;
      this.bestEverReward = Number.NEGATIVE_INFINITY;
      this.bestLapSeconds = undefined;
      this.generationBestDeltaSeconds = undefined;
      try { localStorage.removeItem(storageKey); } catch { /* storage is optional */ }
    }
    if (resetLapRecord) {
      this.bestLapSeconds = undefined;
      this.bestEverReward = Number.NEGATIVE_INFINITY;
    }
    this.save();
    this.createGeneration(track, carWidth);
  }

  setSettings(next: TrainingSettings): void {
    const sanitized = TrainingManager.sanitizeSettings(next);
    if (this.agents.length === 0) {
      this.settings = sanitized;
    } else {
      this.pendingSettings = sanitized;
    }
  }

  step(track: Track, deltaSeconds: number): void {
    if (!this.running || this.agents.length === 0 || track.length === 0) return;
    const dt = Math.min(deltaSeconds * this.settings.simulationSpeed, 0.1);
    let newLapRecord = false;
    for (const agent of this.agents) {
      if (!agent.active) continue;
      const controls = agent.brain.decide(this.observe(track, agent));
      agent.car.steer = clamp(controls.steer, -1, 1);
      agent.car.throttle = clamp(controls.throttle, -1, 1);
      agent.car.update(dt);
      if (this.score(track, agent, dt)) newLapRecord = true;
    }
    const leader = this.leader();
    if (newLapRecord) {
      // A record can be set by a car other than the current reward leader.
      // It still proves the generation is improving, so restart the counter.
      this.leaderRecordMisses = 0;
    } else if (leader?.lapJustCompleted) {
      this.leaderRecordMisses = leader.lastLapWasRecord
        ? 0
        : this.leaderRecordMisses + 1;
      if (this.leaderRecordMisses >= leaderRecordMissLimit) {
        this.evolve(track);
        return;
      }
    }
    const survivors = this.agents.filter((agent) => agent.active);
    if (survivors.length === 0) {
      this.evolve(track);
      return;
    }
    const bestProgress = this.agents.reduce(
      (best, agent) => Math.max(best, agent.totalProgress),
      Number.NEGATIVE_INFINITY,
    );
    if (bestProgress > this.bestGenerationProgress + meaningfulProgress) {
      this.bestGenerationProgress = bestProgress;
      this.stalledSeconds = 0;
    } else {
      this.stalledSeconds += dt;
      if (this.stalledSeconds >= stalledGenerationSeconds) {
        this.evolve(track);
        return;
      }
    }
    if (survivors.length < this.agents.length * 0.25) {
      this.lowPopulationPhase = true;
      if (this.lowPopulationLaps >= 2) this.evolve(track, survivors);
    }
  }

  status(): TrainingStatus {
    const generationBest = this.agents.reduce((best, agent) => Math.max(best, agent.reward), Number.NEGATIVE_INFINITY);
    const leader = this.leader();
    return {
      generation: this.generation,
      alive: this.agents.filter((agent) => agent.active).length,
      population: this.agents.length,
      generationBest: Number.isFinite(generationBest) ? generationBest : 0,
      bestEver: Number.isFinite(this.bestEverReward) ? this.bestEverReward : 0,
      completedLaps: this.completedLaps,
      generationBestLapSeconds: this.generationBestLapSeconds,
      bestLapSeconds: this.bestLapSeconds,
      lowPopulationLaps: this.lowPopulationLaps,
      leaderLapSeconds: leader?.lapSeconds ?? 0,
      leaderRecordMisses: this.leaderRecordMisses,
      leaderLastLapSeconds: leader?.lastLapSeconds,
      leaderLapDeltaSeconds:
        leader?.lastLapSeconds !== undefined && leader.previousLapSeconds !== undefined
          ? leader.lastLapSeconds - leader.previousLapSeconds
          : undefined,
      generationBestDeltaSeconds: this.generationBestDeltaSeconds,
      running: this.running,
    };
  }

  leader(): TrainingAgent | undefined {
    return this.agents.reduce<TrainingAgent | undefined>((best, agent) => !best || agent.reward > best.reward ? agent : best, undefined);
  }

  /** Prefer the active car that owns the current track record for the camera. */
  focusAgent(): TrainingAgent | undefined {
    return this.bestLapAgent?.active ? this.bestLapAgent : this.leader();
  }

  draw(context: CanvasRenderingContext2D): void {
    const leader = this.focusAgent();
    for (const agent of this.agents) {
      if (!agent.active) continue;
      agent.car.draw(context);
      if (agent === leader) {
        context.strokeStyle = "#facc15";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(agent.car.x, agent.car.y, agent.car.length * 0.7, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }

  private observe(track: Track, agent: TrainingAgent): AiObservation {
    const { car } = agent;
    return {
      sensors: sensorAngles.map((offset) => track.raycast(car, car.angle + offset, this.settings.sensorRange) / this.settings.sensorRange),
      speed: car.speed,
      slipAngle: car.slipAngle,
      steer: car.steer,
      progress: clamp(agent.totalProgress / Math.max(track.length, 1), -1, 1),
    };
  }

  private score(track: Track, agent: TrainingAgent, dt: number): boolean {
    agent.lapJustCompleted = false;
    agent.lastLapWasRecord = false;
    const progress = track.progressAt(agent.car);
    let change = progress - agent.lastProgress;
    if (change < -track.length / 2) change += track.length;
    if (change > track.length / 2) change -= track.length;
    agent.lastProgress = progress;
    agent.totalProgress += change;
    agent.lapSeconds += dt;
    agent.reward += Math.max(0, change) * this.settings.progressReward;

    let setLapRecord = false;
    if (agent.totalProgress - agent.lapStartProgress >= track.length * 0.95) {
      agent.reward += this.settings.lapReward;
      this.completedLaps += 1;
      agent.laps += 1;
      agent.lapJustCompleted = true;
      agent.previousLapSeconds = agent.lastLapSeconds;
      agent.lastLapSeconds = agent.lapSeconds;
      const recordBeforeLap = this.bestLapSeconds;
      if (
        this.generationBestLapSeconds === undefined ||
        agent.lapSeconds < this.generationBestLapSeconds
      ) {
        this.generationBestLapSeconds = agent.lapSeconds;
        this.generationBestDeltaSeconds =
          recordBeforeLap === undefined
            ? undefined
            : agent.lapSeconds - recordBeforeLap;
      }
      agent.lapStartProgress += track.length;
      if (this.lowPopulationPhase) this.lowPopulationLaps += 1;
      if (this.bestLapSeconds === undefined || agent.lapSeconds < this.bestLapSeconds) {
        agent.lastLapWasRecord = true;
        setLapRecord = true;
        this.bestLapSeconds = agent.lapSeconds;
        this.bestLapAgent = agent;
        // A new all-time lap record earns a second lap bonus.
        agent.reward += this.settings.lapReward;
        this.bestBrain = agent.brain.clone();
        this.save();
      }
      agent.lapSeconds = 0;
    } else if (track.collidesWithBody(agent.car.getBodyCorners())) {
      agent.reward -= this.settings.crashPenalty;
      agent.active = false;
    }
    return setLapRecord;
  }

  private evolve(track: Track, candidates = this.agents): void {
    const ranked = [...candidates].sort((first, second) => second.reward - first.reward);
    const champion = ranked[0];
    if (champion && champion.reward > this.bestEverReward) {
      this.bestEverReward = champion.reward;
      this.save();
    }
    if (this.pendingSettings) {
      this.settings = this.pendingSettings;
      this.pendingSettings = undefined;
      this.save();
    }
    const size = this.settings.populationSize;
    const eliteCount = Math.max(1, Math.round(size * this.settings.elitePercent));
    const parents = ranked.slice(0, eliteCount);
    // The record-holder is always copied unchanged. Reward-ranked elites then
    // fill the remaining protected slots and provide crossover parents.
    const brains: NeuralNetwork[] = this.bestBrain ? [this.bestBrain.clone()] : [];
    for (const parent of parents) {
      if (brains.length >= eliteCount) break;
      brains.push(parent.brain.clone());
    }
    while (brains.length < size) {
      const first = parents[Math.floor(Math.random() * parents.length)].brain;
      const second = parents[Math.floor(Math.random() * parents.length)].brain;
      const child = Math.random() < this.settings.crossoverRate ? first.crossover(second) : first.clone();
      brains.push(child.mutate(this.settings.mutationRate, this.settings.mutationStrength));
    }
    this.createGeneration(track, ranked[0]?.car.width ?? 16, brains);
  }

  private createGeneration(track: Track, carWidth: number, suppliedBrains?: readonly NeuralNetwork[]): void {
    const start = track.startPoint;
    if (!start) return;
    this.agents.length = 0;
    this.generation += 1;
    this.lowPopulationLaps = 0;
    this.lowPopulationPhase = false;
    this.generationBestLapSeconds = undefined;
    this.generationBestDeltaSeconds = undefined;
    this.bestGenerationProgress = 0;
    this.stalledSeconds = 0;
    this.leaderRecordMisses = 0;
    this.bestLapAgent = undefined;
    const brains = suppliedBrains ?? Array.from({ length: this.settings.populationSize }, (_, index) =>
      index === 0 && this.bestBrain ? this.bestBrain.clone() : new NeuralNetwork(),
    );
    const startProgress = track.progressAt(start);
    for (const brain of brains) {
      const car = new Car(start.x, start.y, carWidth);
      car.reset(start.x, start.y, track.startingAngle());
      this.agents.push({
        car,
        brain,
        reward: 0,
        totalProgress: 0,
        lapStartProgress: 0,
        lastProgress: startProgress,
        lapSeconds: 0,
        laps: 0,
        lapJustCompleted: false,
        lastLapWasRecord: false,
        lastLapSeconds: undefined,
        previousLapSeconds: undefined,
        active: true,
      });
    }
  }

  private save(): void {
    try {
      if (this.bestBrain) localStorage.setItem(storageKey, JSON.stringify({ brain: this.bestBrain.toJSON() } satisfies SavedTraining));
      else localStorage.removeItem(storageKey);
    } catch { /* storage is optional */ }
  }

  private static load(): SavedTraining | undefined {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<SavedTraining>;
      if (!parsed.brain || !NeuralNetwork.fromJSON(parsed.brain)) return undefined;
      return { brain: parsed.brain as number[][] };
    } catch { return undefined; }
  }

  private static sanitizeSettings(settings: TrainingSettings): TrainingSettings {
    return {
      populationSize: Math.round(clamp(Number(settings.populationSize) || 50, 5, 100)),
      elitePercent: clamp(Number(settings.elitePercent) || 0.1, 0.02, 0.5),
      mutationRate: clamp(Number(settings.mutationRate) || 0.12, 0, 1),
      mutationStrength: clamp(Number(settings.mutationStrength) || 0.35, 0.01, 2),
      crossoverRate: clamp(Number(settings.crossoverRate) || 0.5, 0, 1),
      simulationSpeed: clamp(Number(settings.simulationSpeed) || 1, 0.25, 4),
      sensorRange: clamp(Number(settings.sensorRange) || 180, 40, 500),
      progressReward: clamp(Number(settings.progressReward) || 1, 0.01, 20),
      lapReward: clamp(Number(settings.lapReward) || 1000, 10, 10_000),
      crashPenalty: clamp(Number(settings.crashPenalty) || 30, 0, 1_000),
    };
  }
}
