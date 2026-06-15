import { addNumbers, multiplyNumbers } from "./math";

export function computeTotal(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total = addNumbers(total, v);
  }
  return multiplyNumbers(total, 2);
}
