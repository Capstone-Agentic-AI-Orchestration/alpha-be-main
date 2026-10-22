/** Formats a percentage with no decimals, for example 42%. */
export function formatPercent(value) {
  return Math.round(value * 100) + '%';
}
