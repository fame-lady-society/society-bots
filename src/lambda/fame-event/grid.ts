import { formatEther } from "viem";

const TEXT_WIDTH = 17n;
const MAX_HEIGHT = 6n;

export function fillGrid(
  amount: bigint,
  min: bigint,
  max: bigint,
  emojis: string[]
) {
  if (emojis.length === 0) {
    throw new Error("Emojis array must have one or more characters.");
  }

  if (amount < min) {
    return null;
  }

  const totalCells = Number(TEXT_WIDTH * MAX_HEIGHT);
  const totalRange = max - min;

  // Apply easing formula: Adjust the amount using a quadratic progression
  // Assuming min, max, and amount are already defined BigInts
  // Convert BigInts to Numbers for the easing calculation
  const numMin = Number(min);
  const numMax = Number(max);
  const numAmount = Number(amount);

  // Calculate the normalized position of amount between min and max
  const normalizedAmount = (numAmount - numMin) / (numMax - numMin);

  // Apply a cubic easing function for a quick start and a smooth approach to max
  // Adjust the exponent as needed to control the easing effect
  const eased = numMin + (numMax - numMin) * Math.pow(normalizedAmount, 0.3);

  // Ensure eased is always greater than amount by checking if it's not, then set it to amount + a small increment
  // This increment can be adjusted based on how quickly you want to ease out from the amount
  const finalEased = Math.max(eased, numAmount + (numMax - numMin) * 0.01);

  // Clamp the result to ensure it doesn't exceed max
  const clampedEased = Math.max(numMin, Math.min(finalEased, numMax));

  // Convert the result back to BigInt
  const easedAmount = BigInt(Math.floor(clampedEased));

  // Ensure easedAmount is between min and max and greater than amount
  console.log(
    `Amount: ${formatEther(amount)} Eased Amount: ${formatEther(
      easedAmount
    )}, Min: ${formatEther(min)}, Max: ${formatEther(max)}`
  );
  const segmentSize = totalRange / BigInt(emojis.length);
  const segmentIndex = Number((easedAmount - min) / segmentSize);
  const segmentSubIndex =
    Number((easedAmount - min) % segmentSize) / Number(segmentSize);

  const numberOfElementsFilled = Math.floor(segmentSubIndex * totalCells);

  let grids: string[] = [];

  const fillRows = (emoji: string, count: number) => {
    let fillCount = 0;
    while (fillCount + Number(TEXT_WIDTH) <= count) {
      const row = Array.from({ length: Number(TEXT_WIDTH) }, () => emoji);
      grids.push(row.join(""));
      fillCount += Number(TEXT_WIDTH);
    }
    return fillCount;
  };

  if (easedAmount >= max) {
    fillRows(emojis[emojis.length - 1], totalCells);
    return grids;
  }

  fillRows(emojis[segmentIndex], numberOfElementsFilled);

  if (numberOfElementsFilled % Number(TEXT_WIDTH) > 0) {
    const remainingCells = numberOfElementsFilled % Number(TEXT_WIDTH);
    const partialRow = Array.from({ length: Number(TEXT_WIDTH) }, (_, i) =>
      i < remainingCells
        ? emojis[segmentIndex]
        : segmentIndex === 0
        ? ""
        : emojis[segmentIndex - 1]
    );
    grids.push(partialRow.join(""));
  }

  if (segmentIndex > 0) {
    const remainingCount = totalCells - numberOfElementsFilled;
    fillRows(emojis[segmentIndex - 1], remainingCount);
  }

  return grids;
}
