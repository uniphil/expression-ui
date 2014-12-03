var parse = require('expression-compiler/parse');
var Reflux = require('reflux');
var actions = require('./actions');
var u = require('./util');


var expressionStore = Reflux.createStore({
  init: function() {
    this.data = {
      expr: '',
      width: 0,
      ast: null
    };
    this.listenToMany(actions.exprActions);
  },
  onChange: function(expr) {
    var newAST = expr && parse(u.cleanExpr(expr)) || null;
    this.update({
      expr: expr,
      ast: newAST
    });
  },
  onChangeWidth: function(exprWidth) {
    this.update({width: exprWidth});  // beware the double-trigger...
  },
  update: function(change) {
    this.data = u.extend({}, this.data, change);
    this.trigger(this.data);
  },
  getInitialState: function() {
    return this.data.expr;  // maybe check URL or something...
  }
});


var contextStore = Reflux.createStore({

  init: function() {
    this.listenTo(expressionStore, this.refreshContext);
    this.listenTo(actions.actions.contextChange, this.updateContext);
    this.context = {};
    this.contextCache = {};  // keep settings for a variable around
  },

  refreshContext: function(ast) {
    ast = ast.ast;
    var newContext = {};
    if (!ast) {
      this.setContext(newContext);
      return;
    }
    u.walkAst(ast, function(node) {
      if (node.node === 'name' && !Math[node.options.key.toUpperCase()]) {
        var name = node.options.key;
        newContext[name] = newContext[name] ||         // already encountered
                           this.context[name] ||       // had it last time
                           this.contextCache[name] ||  // had it before
                           this._createContext();      // it's new!
      }
    }, this);
    this.setContext(newContext);
  },

  updateContext: function(name, update) {
    var updatedContext = u.extend({}, this.context);
    updatedContext[name] = u.extend({}, this.context[name], update);
    this.setContext(updatedContext);
  },

  setContext: function(context) {
    if (u.shallowEq(context, this.context)) { return; }
    this.context = u.extend({}, context);
    this.contextCache = u.extend({}, this.contextCache, context);
    this.trigger(this.context);
  },

  _createContext: function() {
    return {
      type: 'const',  // "const" or "range"
      value: 1,
      min: 0,  // for ranges
      max: 10  // for ranges
    };
  }

});


module.exports = {
  expressionStore: expressionStore,
  contextStore: contextStore
};
