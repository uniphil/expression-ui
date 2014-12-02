require('es5-shim');  // patches globals
require('setimmediate');  // attaches to the global
var crel = require('crel');
var Reflux = require('reflux');

var parse = require('expression-compiler/parse');
var values = require('expression-compiler/values');
var parseEcho = require('expression-compiler/echo');
var parseToFunc = require('expression-compiler/func');

var createComponent = require('./create-component');


// config for reflux... would be nice if this didn't mutate global reflux...
Reflux.nextTick(window.setImmediate);


var SLIDER_STEPS = 200;


var exprActions = Reflux.createActions([
  'change'
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


var expressionStore = Reflux.createStore({
  init: function() {
    this.data = {
      expr: '',
      ast: null
    };
    this.listenToMany(exprActions);
  },
  onChange: function(expr) {
    var newAST = expr && parse(cleanExpr(expr)) || null;
    this.data = {
      expr: expr,
      ast: newAST
    };
    this.trigger(this.data);
  },
  getInitialState: function() {
    return this.data.expr;  // maybe check URL or something...
  }
});


var uiExprWidthStore = Reflux.createStore({

  init: function() {
    this.listenTo(actions.expressionWidthChange, this.changeWidth);
    this.width = 456;
  },

  changeWidth: function(exprWidth) {
    var newWidth = Math.max(456, exprWidth + 32);
    if (newWidth !== this.width) {
      this.width = newWidth;
      this.trigger(newWidth);
    }
  }

});


var contextStore = Reflux.createStore({

  init: function() {
    this.listenTo(expressionStore, this.refreshContext);
    this.listenTo(actions.contextChange, this.updateContext);
    this.listenTo(actions.contextSet, this.setContext);
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
    walkAst(ast, function(node) {
      if (node.node === 'name' && !Math[node.options.key.toUpperCase()]) {
        var name = node.options.key;
        newContext[name] = newContext[name] ||         // already encountered
                           this.context[name] ||       // had it last time
                           this.contextCache[name] ||  // had it before
                           this._createContext();      // it's new!
      }
    }, this);
    this.setContext(newContext, true);
  },

  updateContext: function(name, update) {
    var updatedContext = extend({}, this.context);
    updatedContext[name] = extend({}, this.context[name], update);
    this.setContext(updatedContext, true);
  },

  setContext: function(context, async) {
    this.context = extend({}, context);
    this.contextCache = extend({}, context);
    this[async ? 'triggerAsync' : 'trigger'](context);
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


var contextChangeStore = Reflux.createStore({

  init: function() {
    this.listenTo(flowThrottle(contextStore), this.newContext);
    this.prevContext = {};
  },

  newContext: function(context) {
    if (shallowEq(context, this.prevContext)) { return; }
    this.trigger(context);
    this.prevContext = context;
  }

});


var contextCommitStore = Reflux.createStore({
  init: function() {
    this.resetListeners();
  },
  resetListeners: function() {
    this.stopEx && this.stopEx.stop();
    this.stopCx && this.stopCx.stop();
    this.stopEx = this.joinTrailing(contextChangeStore, expressionStore, this.passCxChange0);
    this.stopCx = this.joinTrailing(contextChangeStore, actions.contextCommit, this.passCxChange);
  },
  passCxChange0: function(args) {
    this.trigger(args[0]);
    this.resetListeners();
  },
  passCxChange: function(args) {
    this.trigger(args[0]);
    this.resetListeners();
  }
});


var contextVaryStore = Reflux.joinTrailing(contextChangeStore, actions.contextVary);



function BarsComponent(root) {
  expressionStore.listen(newBars);
  contextStore.listen(scaleBars);
  uiExprWidthStore.listen(changeGraphWidth);

  var bl = crel('span', {'class': 'expr-bars'}),
      barIdMap,
      barValuer = values('0');

  crel(root, bl);

  function newBars(ast) {
    ast = ast.ast;
    emptyEl(bl);
    if (!ast) { return; }
    barIdMap = [];
    barValuer = values.fromAST(ast);

    crel(bl, walkTemplatesToDom(ast, 'bar', function(node, el) {
      el.insertBefore(barIdMap[node.id] = crel('span',
        {'class': 'expr-bar-bar'}), el.firstChild);
    }));
  }

  function scaleBars(context) {
    var exprContext = Object.keys(context).reduce(function(ctx, k) {
      ctx[k] = context[k].value;
      return ctx;
    }, {});
    var values = barValuer(exprContext);
    values.forEach(function(value, id) {
      var logified = logify(value);
      if (!barIdMap) {
        console.warn('no bars???', barIdMap, id);
        return;
      }
      style(barIdMap[id], {
        top: (value > 0 ? (280 - logified) : 280) + 'px',
        height: logified + 'px'
      });
    });
  }

  function changeGraphWidth(newWidth) { style(bl, {width: newWidth + 'px'}); }
}


var Highlighter = createComponent({
  init: function() {
    this.listenTo(expressionStore, this.render);
  },
  render: function(expr) {
    if (!expr || !expr.ast) { return void 0; }
    return crel('span', {'class': 'expr-input-highlighted'},
      walkTemplatesToDom(expr.ast, 'text'));
  }
});


var NewInputComponent = createComponent({
  init: function() {
    this.eventEls = {
      input: {
        'keyup': this.changeSync,
        'change': this.change
      }
    };
    this.highlighter = new Highlighter();
  },
  change: function(e) {
    exprActions.change(e.target.value);
    this.updateWidth(e.target.value);
  },
  changeSync: function(e) {
    // trigger input action synchronously to avoid blanking between redraws
    exprActions.change.trigger(e.target.value);
    this.updateWidth(e.target.value);
  },
  updateWidth: function(newText) {
    this.widthMeasureEl.textContent = newText;
    var width = this.widthMeasureEl.offsetWidth;
    style(this.container, {
      'width': Math.max(456, width + 32) + 'px'
    });
  },
  render: function() {
    return this.container = crel('div', {'class': 'expr-input'},
      this.highlighter.render(),
      this.eventEls.input.el = crel('input', {
        'class': 'expr-input-textinput',
        'spellcheck': 'false'}),
      style(crel('span',
        this.widthMeasureEl = crel('span', {'class': 'expr-input-highlighted'})), {
        'position': 'absolute',
        'left': '-99999em'
      }));
  }
});


function ContextComponent(root) {
  root.addEventListener('input', inputUpdate, false);
  root.addEventListener('keyup', inputUpdate, false);
  root.addEventListener('change', inputChange, false);

  flowThrottle(contextCommitStore).listen(newContext);
  contextVaryStore.listen(spinNumber);

  var currentContext;
  var inputNameMap;

  function newContext(context) {
    context = context || currentContext;
    currentContext = context;
    inputNameMap = {};
    var ctxWidget;
    emptyEl(root);
    crel(root,
      crel('ul', {'class': 'expr-context-widgets'},
        Object.keys(context).map(function(k) {
          ctxWidget = crel('li', _getContextWidget(k, context[k]));
          inputNameMap[k] = ctxWidget.querySelector('.expr-context-const');
          return ctxWidget;
        })));
  }

  function _getContextChoiceButton(name, context, choice, choiceName) {
    var elName = 'expr-choice-' + name,
        id = name + '-' + choice,
        inputAttrs = {
          'class': 'expr-input-radio expr-input-radio-name-type',
          'type': 'radio',
          'name': elName,
          'id': id,
          'data-ctxname': name,
          'data-ctxtype': choice
        };
    if (context.type === choice) { inputAttrs.checked = 'checked'; }
    return crel('span', {'class': 'expr-choice'},
      crel('input', inputAttrs),
      crel('label', {
        'class': 'expr-input-radio-label',
        'for': id
      }, choiceName));
  }

  function _getContextWidget(name, context) {
    return crel('span',
      crel('label', {'for': name + '-expr-value'},
        crel('span', {'class': 'expr-name'}, name),
        '='),
      crel('div', {'class': 'expr-input'},
        crel('input', {
          'class': 'expr-input-textinput expr-literal expr-context-const',
          'id': name + '-expr-value',
          'data-ctxname': name,
          'value': context.value })),
      crel('span', {'class': 'expr-choices'},
        _getContextChoiceButton(name, context, 'const', 'constant'),
        _getContextChoiceButton(name, context, 'range', 'variable')),
      (context.type === 'range' ?
        crel('span', {'class': 'expr-variable-range'},
          crel('label', {'class': 'expr-rangebound-label'},
            crel('span', {'class': 'expr-rangebound-label-text'}, 'min:'),
            crel('span', {'class': 'expr-input'},
              crel('input', {
                'class': 'expr-input-textinput expr-literal expr-context-rangebound',
                'data-ctxname': name,
                'data-ctxprop': 'min',
                'value': context.min
              }))),
          crel('input', {
            'class': 'expr-input-range expr-context-variable',
            'type': 'range',
            'min': 0,
            'max': SLIDER_STEPS,
            'data-ctxname': name,
            'value': rangeNorm(context, context.value)
          }),
          crel('label', {'class': 'expr-rangebound-label'},
            crel('span', {'class': 'expr-rangebound-label-text'}, 'min:'),
            crel('span', {'class': 'expr-input'},
              crel('input', {
                'class': 'expr-input-textinput expr-literal expr-context-rangebound',
                'data-ctxname': name,
                'data-ctxprop': 'max',
                'value': context.max
              })))) :
        void 0));
  }

  function spinNumber(contexts, name) {
    inputNameMap[name].value = contexts[0][name].value;
  }

  function inputUpdate(e) {
    var input = e.target;
    if (input.classList.contains('expr-context-const')) {
      actions.contextChange(input.dataset.ctxname,
        {'value': parseNumba(input.value)});
    } else if (input.classList.contains('expr-input-radio-name-type')) {
      actions.contextChange(input.dataset.ctxname,
        {'type': input.dataset.ctxtype});
    } else if (input.classList.contains('expr-context-variable')) {
      actions.contextChange(input.dataset.ctxname,
        {'value': unrange(currentContext[input.dataset.ctxname],
                          parseNumba(input.value))});
      actions.contextVary(input.dataset.ctxname);
    } else if (input.classList.contains('expr-context-rangebound')) {
      var changeObj = {};
      changeObj[input.dataset.ctxprop] = parseNumba(input.value);
      actions.contextChange(input.dataset.ctxname, changeObj);
    }
  }

  function inputChange(e) {
    inputUpdate(e);
    actions.contextCommit();
  }
}


function cleanExpr(expr) {
  if (!expr) { return ''; }
  try {
    return parseEcho(expr);
  } catch (err) {
    return cleanExpr(expr.slice(0, -1));
  }
}


function flowThrottle(listenable, timeout) {
  // just do the last one
  var timer,
      store = Reflux.createStore(),
      args;
  listenable.listen(function() {
    clearTimeout(timer);
    args = Array.prototype.slice.call(arguments);
    timer = setTimeout(function() {
      store.trigger.apply(store, args);
    }, timeout || 0);
  });
  return store;
}


function parseNumba(str) {
  var value;
  try { value = parseToFunc(str)(); } catch (err) { value = NaN; }
  return value;
}


function walkAst(root, cb, thisContext) {
  (function walker(node) {
    cb.call(thisContext, node);
    node.children.forEach(walker);
  })(root);
}


function walkTemplatesToDom(root, key, cb, thisContext) {
  return (function walker(node) {
    var el = crel('span', {'class': 'expr-' + key + ' expr-' + node.node},
      node.template.split('#').reduce(function(pieces, nextPiece, i) {
        pieces.push(nextPiece);
        if (i <= node.children.length - 1) { pieces.push(walker(node.children[i])); }
        return pieces;
      }, []));
    if (cb) { cb.call(thisContext, node, el); }
    return el;
  })(root);
}


function style(el, styles) {
  el.setAttribute('style', Object.keys(styles).map(function(key) {
    return [key, styles[key]].join(':');
  }).join(';'));
  return el;
}


function shallowEq(a, b) {
  return a === b ||
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).reduce(function(r, k) {
      return r && a[k] === b[k];
    }, true);
}


function extend(out) {
  /* http://youmightnotneedjquery.com/#extend */
  out = out || {};
  for (var i = 1; i < arguments.length; i++) {
    if (!arguments[i]) { continue; }
    for (var key in arguments[i]) {
      if (arguments[i].hasOwnProperty(key)) { out[key] = arguments[i][key]; }
    }
  }
  return out;
}


function emptyEl(el) {
  while (el.firstChild) { el.removeChild(el.firstChild); }
}


function logify(num) {
  // return 18 * Math.log(Math.abs(num) + 1);
  return 32 * Math.abs(num);
}


function rangeNorm(context, value) {
  return (value - context.min) / (context.max - context.min) * SLIDER_STEPS;
}
function unrange(context, value) {
  return value / SLIDER_STEPS * (context.max - context.min) + context.min;
}


(function InitApp(root) {
  var barsEl = crel('div'),
      newInputEl = crel('div'),
      contextEl = crel('div');
  crel(root,
    barsEl,
    newInputEl,
    contextEl
  );

  new BarsComponent(barsEl);
  var nic = new NewInputComponent();
  new ContextComponent(contextEl);

  crel(newInputEl, nic.render());

})(document.getElementById('expression'));
