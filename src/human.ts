import type { Page } from "playwright";

export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function humanScroll(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
  await page.mouse.move(
    randomBetween(100, viewport.width - 100),
    randomBetween(100, viewport.height - 100),
    { steps: randomBetween(5, 10) },
  );

  const delta = randomBetween(800, 2400);
  await page.mouse.wheel(0, delta);
  await sleep(randomBetween(700, 2500));
}

export async function maybeReadingPause(): Promise<void> {
  if (Math.random() < 0.25) {
    await sleep(randomBetween(3_000, 8_000));
  }
}
