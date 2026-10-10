/**
 * Russian noun pluralization for cardinal numerals.
 * Picks the right suffix ("", "а", "ов") for the cardinal form:
 *   1 источник, 2 источника, 5 источников, 11 источников, 22 источника.
 *
 * Returns just the suffix, not the whole word, so the caller can compose
 * it as `${n} источник${ruPlural(n)}`.
 */
export function ruPlural(n: number): '' | 'а' | 'ов' {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'ов';
  if (last === 1) return '';
  if (last >= 2 && last <= 4) return 'а';
  return 'ов';
}