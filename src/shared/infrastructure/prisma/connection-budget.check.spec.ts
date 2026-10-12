import { connectionBudget } from './connection-budget.check.js';

describe('connectionBudget', () => {
  it('fits when pool × processes stays inside max_connections minus the reserve', () => {
    expect(connectionBudget(10, 9, 100)).toEqual({
      needed: 90,
      available: 95,
      fits: true,
    });
    expect(connectionBudget(10, 11, 100)).toEqual({
      needed: 110,
      available: 95,
      fits: false,
    });
  });
});
