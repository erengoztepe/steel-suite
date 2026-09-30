/**
 * Reference logical viewport width (CSS px) the viewer's panel-sizing
 * constants (results/selection panel widths, the bottom control bar's
 * avoid-gap) were tuned against — the screen they were validated on: a 32"
 * 1080p monitor at Windows' 125% display scaling (1920 physical px / 1.25 =
 * 1536 logical px). Every tunable width scales linearly off this ratio, so
 * the proportions validated at that size are preserved on any other monitor
 * or window size instead of staying fixed absolute pixels.
 */
export const REFERENCE_WIDTH_PX = 1536;

export function scaleFromWidth(width: number): number {
  return width > 0 ? width / REFERENCE_WIDTH_PX : 1;
}
