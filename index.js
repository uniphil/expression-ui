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


var expressionStore = Reflux.createStore({
  init: function() {
    this.data = {
      expr: '',
      width: 0,
      ast: null
    };
    this.listenToMany(exprActions);
  },
  onChange: function(expr) {
    var newAST = expr && parse(cleanExpr(expr)) || null;
    this.update({
      expr: expr,
      ast: newAST
    });
  },
  onChangeWidth: function(exprWidth) {
    this.update({width: exprWidth});  // beware the double-trigger...
  },
  update: function(change) {
    this.data = extend({}, this.data, change);
    this.trigger(this.data);
  },
  getInitialState: function() {
    return this.data.expr;  // maybe check URL or something...
  }
});


var contextStore = Reflux.createStore({

  init: function() {
    this.listenTo(expressionStore, this.refreshContext);
    this.listenTo(actions.contextChange, this.updateContext);
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
    this.setContext(newContext);
  },

  updateContext: function(name, update) {
    var updatedContext = extend({}, this.context);
    updatedContext[name] = extend({}, this.context[name], update);
    this.setContext(updatedContext);
  },

  setContext: function(context) {
    if (shallowEq(context, this.context)) { return; }
    this.context = extend({}, context);
    this.contextCache = extend({}, this.contextCache, context);
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


var BarsComponent = createComponent({
  init: function() {
    this.listenTo(expressionStore, this.render);
    this.listenTo(afterIf(expressionStore, contextStore), this.scaleBars);
    this.barIdMap = null;
    this.barValues = null;
  },
  scaleBars: function(context) {
    context = this.context = context || this.context;
    if (!context) { return; }
    var exprContext = Object.keys(context).reduce(function(ctx, k) {
          ctx[k] = context[k].value;
          return ctx;
        }, {}),
        values = this.barValues(exprContext),
        logified;
    this.barIdMap.forEach(function(bar, id) {
      logified = logify(values[id]);
      style(bar, {
        'top': (values[id] > 0 ? (280 - logified) : 280) + 'px',
        'height': logified + 'px'
      });
    });
  },
  render: function(expr) {
    var container = style(crel('span', {'class': 'expr-bars'}),
      {'width': expr && expr.width + 6 + 'px' || '456px'});
    if (!expr || !expr.ast) { return container; }

    this.barIdMap = [];
    this.barValues = values.fromAST(expr.ast);
    var bars = crel(container,
      walkTemplatesToDom(expr.ast, 'bar', function(node, el) {
        el.insertBefore(this.barIdMap[node.id] = crel('span',
          {'class': 'expr-bar-bar'}), el.firstChild);
      }, this));
    this.scaleBars();
    return bars;
  }
});


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


var InputComponent = createComponent({
  init: function() {
    this.eventEls = {
      input: {
        'keyup': this.change,
        'change': this.change
      }
    };
    this.highlighter = new Highlighter();
  },
  change: function(e) {
    exprActions.change(e.target.value);
    this.updateWidth(e.target.value);
  },
  updateWidth: function(newText) {
    this.widthMeasureEl.textContent = newText;
    var exprWidth = this.widthMeasureEl.offsetWidth,
        widgetWidth = Math.max(456, exprWidth + 32);
    style(this.container, {
      'width': widgetWidth + 'px'
    });
    exprActions.changeWidth(exprWidth, widgetWidth);
  },
  render: function() {
    return (this.container = crel('div', {'class': 'expr-input'},
      this.highlighter.render(),
      this.eventEls.input.el = crel('input', {
        'class': 'expr-input-textinput',
        'spellcheck': 'false'}),
      style(crel('span',
        this.widthMeasureEl = crel('span', {'class': 'expr-input-highlighted'})), {
        'position': 'absolute',
        'left': '-99999em'
      })));
  }
});


var ContextWidgetComponent = createComponent({
  init: function() {
    this.listenTo(contextStore, this.contextUpdate);
    this.eventEls = {
      value: {
        'focus': this.beginEditing,
        'keyup': this.changeValue,
        'change': this.changeValue,
        'blur': this.endEditing
      },
      type: { 'change': this.changeType },  // maybe add click for even moar compatability?
      minValue: {'change': this.changeMin },
      maxValue: { 'change': this.changeMax },
      slider: {
        'focus': this.beginEditing,
        'input': this.dragSlider,
        'change': this.changeSlider,
        'blur': this.endEditing
      }
    };
    this.lastChange = {};
    this.isEditing = false;
  },
  beginEditing: function() { this.isEditing = true; },
  endEditing: function() { this.isEditing = false; },
  changeValue: function(e) {
    var newValue = parseNumba(e.target.value);
    this.maybeChange({value: newValue});
    this.pushSlider(parseNumba(e.target.value));
  },
  changeType: function(e) {
    this.maybeChange({type: e.target.value});
  },
  changeMin: function(e) {
    this.maybeChange({min: parseNumba(e.target.value)});
  },
  changeMax: function(e) {
    this.maybeChange({max: parseNumba(e.target.value)});
  },
  dragSlider: function(e) {
    var newValue = unrange(this.nameContext, parseInt(e.target.value, 10));
    this.isEditing = true;
    this.maybeChange({value: newValue});
    this.spinValue(newValue);
  },
  changeSlider: function(e) {
    var newValue = unrange(this.nameContext, parseInt(e.target.value, 10));
    this.maybeChange({value: newValue});
  },
  maybeChange: function(change) {
    if (shallowEq(change, this.lastChange)) { return; }
    this.lastChange = change;
    actions.contextChange(this.name, change);
  },
  pushSlider: function(newValue) {
    if (this.nameContext.type === 'range') {
      this.eventEls.slider.el.value = rangeNorm(this.nameContext, newValue);
    }
  },
  spinValue: function(newValue) {
    this.eventEls.value.el.value = newValue;
  },
  contextUpdate: function(context) {
    if (!(this.nameContext = context[this.name])) { return; }
    window.setImmediate(function() {  // wait for any blurs...
      if (!this.isEditing) {
        this.render(this.name, context[this.name]);
      }
    }.bind(this));
  },
  render: function(name, nameContext) {
    this.name = name;  // ugh...
    this.nameContext = nameContext;  // uuugghh...
    return crel('span',
      crel('label', {'for': name + '-expr-value'},
        crel('span', {'class': 'expr-name'}, name),
        '='),
      crel('div', {'class': 'expr-input'},
        this.eventEls.value.el = crel('input', {
          'class': 'expr-input-textinput expr-literal expr-context-const',
          'id': name + '-expr-value',
          'value': nameContext.value })),
      this.eventEls.type.el = crel('span', {'class': 'expr-choices'},
        this.choiceButton(name, nameContext, 'const', 'constant'),
        this.choiceButton(name, nameContext, 'range', 'variable')),
      nameContext.type === 'range' ? this.slider(name, nameContext) : void 0);
  },
  choiceButton: function(name, nameContext, choiceKey, choiceName) {
    var elName = 'expr-choice-' + name,
        id = elName + '-' + choiceKey,
        inputAttrs = {
          'class': 'expr-input-radio expr-input-radio-name-type',
          'type': 'radio',
          'name': elName,
          'value': choiceKey,
          'id': id,
        };
    if (nameContext.type === choiceKey) { inputAttrs.checked = 'checked'; }
    return crel('span', {'class': 'expr-choice'},
      crel('input', inputAttrs),
      crel('label', {
        'class': 'expr-input-radio-label',
        'for': id
      }, choiceName));
  },
  slider: function(name, nameContext) {
    return crel('span', {'class': 'expr-variable-range'},
      crel('label', {'class': 'expr-rangebound-label'},
        crel('span', {'class': 'expr-rangebound-label-text'}, 'min:'),
        crel('span', {'class': 'expr-input'},
          this.eventEls.minValue.el = crel('input', {
            'class': 'expr-input-textinput expr-literal expr-context-rangebound',
            'value': nameContext.min
          }))),
      this.eventEls.slider.el = crel('input', {
        'class': 'expr-input-range expr-context-variable',
        'type': 'range',
        'min': 0,
        'max': SLIDER_STEPS,
        'value': rangeNorm(nameContext, nameContext.value)
      }),
      crel('label', {'class': 'expr-rangebound-label'},
        crel('span', {'class': 'expr-rangebound-label-text'}, 'max:'),
        crel('span', {'class': 'expr-input'},
          this.eventEls.maxValue.el = crel('input', {
            'class': 'expr-input-textinput expr-literal expr-context-rangebound',
            'value': nameContext.max
          }))));
  }
});


var ContextComponent = createComponent({
  init: function() {
    this.listenTo(contextStore, this.updateContext);
    this.mapContext = {};
  },
  updateContext: function(context) {
    var hasChanged = false,
        newMap = {};
    Object.keys(context).forEach(function(k) {
      if (!this.mapContext[k]) {
        hasChanged = true;
        newMap[k] = new ContextWidgetComponent('li');
      } else {
        newMap[k] = this.mapContext[k];
      }
    }, this);
    Object.keys(this.mapContext).forEach(function(k) {
      if (newMap[k]) { return; }  // we are keeping it around
      hasChanged = true;
      this.mapContext[k].removeListeners();  // it will be deleted
    }, this);
    if (!hasChanged) { return; }
    this.mapContext = newMap;
    this.render(context);
  },
  render: function(context) {
    return crel('ul', {'class': 'expr-context-widgets'},
      Object.keys(this.mapContext).map(function(k) {
        return this.mapContext[k].render(k, context[k]);
      }, this));
  }
});


function afterIf(maybeWaitFor, listenable) {
  var mockStore = Reflux.createStore(),
      waiting = false,
      payload;
  maybeWaitFor.listen(function() {
    if (waiting) {
      mockStore.trigger.apply(mockStore, payload);
      waiting = false;
    }
  });
  listenable.listen(function() {
    waiting = true;
    payload = Array.prototype.slice.call(arguments);
    window.setImmediate(function() {
      if (waiting) {
        mockStore.trigger.apply(mockStore, payload);
        waiting = false;
      }
    });
  });
  return mockStore;
}


function cleanExpr(expr) {
  if (!expr) { return ''; }
  try {
    return parseEcho(expr);
  } catch (err) {
    return cleanExpr(expr.slice(0, -1));
  }
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


var MainComponent = createComponent({
  init: function() {
    this.bars = new BarsComponent();
    this.input = new InputComponent();
    this.context = new ContextComponent();
  },
  render: function() {
    crel(this.el,
      this.bars.render(),
      this.input.render(),
      this.context.render());
  }
});


crel(document.getElementById('expression'), new MainComponent().render());
