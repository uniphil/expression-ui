var Reflux = require('reflux');


var exprActions = Reflux.createActions([
  'change',
  'changeWidth'
]);


var actions = Reflux.createActions([
  'expressionInput',
  'expressionChange',
  'expressionError',
  'expressionWidthChange',
  'contextChange',
  'contextCommit',
  'contextSet',
  'contextVary',
  'encodedStateChange'
]);


module.exports = {
  exprActions: exprActions,
  actions: actions
};
