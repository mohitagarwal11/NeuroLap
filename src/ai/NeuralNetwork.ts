import type { AiControls, AiDriver, AiObservation } from "./types";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const gaussian = (): number => {
  const first = Math.max(Math.random(), Number.MIN_VALUE);
  const second = Math.random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};

/** A deliberately small brain: 9 inputs, 10 hidden neurons, 2 controls. */
export class NeuralNetwork implements AiDriver {
  static readonly inputCount = 9;
  static readonly hiddenCount = 10;
  private readonly inputHidden: number[];
  private readonly hiddenBias: number[];
  private readonly hiddenOutput: number[];
  private readonly outputBias: number[];

  constructor(
    inputHidden = NeuralNetwork.randomWeights(NeuralNetwork.inputCount * NeuralNetwork.hiddenCount),
    hiddenBias = NeuralNetwork.randomWeights(NeuralNetwork.hiddenCount),
    hiddenOutput = NeuralNetwork.randomWeights(NeuralNetwork.hiddenCount * 2),
    outputBias = NeuralNetwork.randomWeights(2),
  ) {
    this.inputHidden = inputHidden;
    this.hiddenBias = hiddenBias;
    this.hiddenOutput = hiddenOutput;
    this.outputBias = outputBias;
  }

  decide(observation: AiObservation): AiControls {
    const input = [
      ...observation.sensors.slice(0, 5),
      clamp(observation.speed / 45, -1, 1),
      clamp(observation.slipAngle / Math.PI, -1, 1),
      clamp(observation.steer, -1, 1),
      clamp(observation.progress, -1, 1),
    ];
    while (input.length < NeuralNetwork.inputCount) input.push(0);
    const hidden = Array.from({ length: NeuralNetwork.hiddenCount }, (_, row) => {
      let sum = this.hiddenBias[row];
      for (let column = 0; column < NeuralNetwork.inputCount; column += 1)
        sum += input[column] * this.inputHidden[row * NeuralNetwork.inputCount + column];
      return Math.tanh(sum);
    });
    const output = [0, 1].map((row) => {
      let sum = this.outputBias[row];
      for (let column = 0; column < NeuralNetwork.hiddenCount; column += 1)
        sum += hidden[column] * this.hiddenOutput[row * NeuralNetwork.hiddenCount + column];
      return Math.tanh(sum);
    });
    return { steer: clamp(output[0], -1, 1), throttle: clamp(output[1], -1, 1) };
  }

  clone(): NeuralNetwork {
    return new NeuralNetwork([...this.inputHidden], [...this.hiddenBias], [...this.hiddenOutput], [...this.outputBias]);
  }

  mutate(rate: number, strength: number): NeuralNetwork {
    const mutate = (values: readonly number[]) => values.map((value) =>
      Math.random() < rate ? clamp(value + gaussian() * strength, -3, 3) : value,
    );
    return new NeuralNetwork(mutate(this.inputHidden), mutate(this.hiddenBias), mutate(this.hiddenOutput), mutate(this.outputBias));
  }

  crossover(other: NeuralNetwork): NeuralNetwork {
    const mix = (first: readonly number[], second: readonly number[]) => first.map((value, index) => Math.random() < 0.5 ? value : second[index]);
    return new NeuralNetwork(mix(this.inputHidden, other.inputHidden), mix(this.hiddenBias, other.hiddenBias), mix(this.hiddenOutput, other.hiddenOutput), mix(this.outputBias, other.outputBias));
  }

  toJSON(): number[][] {
    return [this.inputHidden, this.hiddenBias, this.hiddenOutput, this.outputBias];
  }

  static fromJSON(value: unknown): NeuralNetwork | undefined {
    if (!Array.isArray(value) || value.length !== 4 || !value.every((row) => Array.isArray(row) && row.every((weight) => typeof weight === "number" && Number.isFinite(weight)))) return undefined;
    const [inputHidden, hiddenBias, hiddenOutput, outputBias] = value as number[][];
    if (inputHidden.length !== 90 || hiddenBias.length !== 10 || hiddenOutput.length !== 20 || outputBias.length !== 2) return undefined;
    return new NeuralNetwork(inputHidden, hiddenBias, hiddenOutput, outputBias);
  }

  private static randomWeights(count: number): number[] {
    return Array.from({ length: count }, () => gaussian() * 0.6);
  }
}
