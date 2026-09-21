const { BudgetSolver } = require('./dist/context/budget_solver');
const s = new BudgetSolver();
if (typeof s.getReservedSlack !== 'function') process.exit(1);
s.setReservedSlack(300);
if (s.getReservedSlack() !== 300) process.exit(1);
process.exit(0);