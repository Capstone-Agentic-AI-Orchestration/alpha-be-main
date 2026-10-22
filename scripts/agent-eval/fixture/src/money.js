/**
 * Money is stored in whole cents everywhere in this project. Convert at the edges only.
 */
export function toCents(amount) {
  return Math.round(amount * 100);
}

export function fromCents(cents) {
  return cents / 100;
}
