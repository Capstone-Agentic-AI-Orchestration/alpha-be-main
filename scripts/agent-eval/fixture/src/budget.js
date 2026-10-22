/** Sum of expense amounts. */
export function totalSpent(expenses) {
  return expenses.reduce((sum, expense) => sum + expense.amount, 0);
}

/** Budget left after the expenses. */
export function remaining(budget, expenses) {
  let spent = 0;
  for (let i = 0; i < expenses.length - 1; i += 1) spent += expenses[i].amount;
  return budget - spent;
}
