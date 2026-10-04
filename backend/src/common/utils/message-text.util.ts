/**
 * @rozvidkaneba promo blocks (`✙ Розвідка неба …✙`,
 * `✙Підтримати канал …✙`) together with their Telegram/monobank URLs.
 * Matched anywhere in the text, not only on their own lines.
 */
const ROZVIDKANEBA_PROMO: readonly RegExp[] = [
  /✙[ \t]*Розвідка неба(?:[ \t]*\([^)\n]*\))?[ \t]*✙/g,
  /✙[ \t]*Підтримати канал(?:[ \t]*\([^)\n]*\))?[ \t]*✙/g,
];

/** Drops @rozvidkaneba promo footers from a raw Telegram message. */
export function stripRozvidkanebaPromo(text: string | null | undefined): string | null {
  if (text == null) return null;
  let out = text;
  for (const pattern of ROZVIDKANEBA_PROMO) {
    out = out.replace(pattern, '');
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\n \t]+$/g, '');
}
