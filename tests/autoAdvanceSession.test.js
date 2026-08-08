const test = require('node:test');
const assert = require('node:assert/strict');
const autoAdvanceQueue = require('../src/services/autoAdvanceQueue');

test('expired auto-advance session stays available while a waiter owns it', () => {
  const key = 'series:active-waiter';
  const session = autoAdvanceQueue.createSession(key, [], {});
  session.createdAt = 0;
  session.activeWaiters = 1;

  assert.equal(autoAdvanceQueue.getSession(key), session);
  assert.equal(session.closed, false);

  session.activeWaiters = 0;
  assert.equal(autoAdvanceQueue.getSession(key), null);
  assert.equal(session.closed, true);
});
