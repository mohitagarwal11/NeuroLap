export type AiControls = {
  steer: number;
  throttle: number;
};

export type AiObservation = {
  sensors: readonly number[];
  speed: number;
  slipAngle: number;
  steer: number;
  progress: number;
};

export interface AiDriver {
  decide(observation: AiObservation): AiControls;
}

export type TrainingSettings = {
  populationSize: number;
  elitePercent: number;
  mutationRate: number;
  mutationStrength: number;
  crossoverRate: number;
  simulationSpeed: number;
  sensorRange: number;
  progressReward: number;
  lapReward: number;
  crashPenalty: number;
};

export const defaultTrainingSettings: TrainingSettings = {
  populationSize: 50,
  elitePercent: 0.1,
  mutationRate: 0.12,
  mutationStrength: 0.35,
  crossoverRate: 0.5,
  simulationSpeed: 1,
  sensorRange: 180,
  progressReward: 1,
  lapReward: 1_000,
  crashPenalty: 30,
};
