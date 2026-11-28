export function openingCaptionText(text: string): string;
export function openingCaptionLines(text: string, aspect?: number): string;
type TimedWord = { text: string; start: number; end: number };
export function openingCaptionPages(
  phrases: TimedWord[][],
  duration: number,
): TimedWord[];
