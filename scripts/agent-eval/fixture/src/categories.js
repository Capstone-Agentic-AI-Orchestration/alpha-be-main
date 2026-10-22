/** Display label for a category key such as "eating_out". */
export function categoryLabel(key) {
  return key.replace(/_/g, ' ').toLowerCase();
}
