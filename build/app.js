(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
require('es5-shim');  // patches globals
require('setimmediate');  // attaches to the global
var crel = require('crel');
var Reflux = require('reflux');
var parse = require('expression-compiler/parse');
var parseEcho = require('expression-compiler/echo');
var values = require('expression-compiler/values');
var parseToFunc = require('expression-compiler/func');


// config for reflux... would be nice if this didn't mutate global reflux...
Reflux.nextTick(window.setImmediate);


var SLIDER_STEPS = 200;


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
    this.listenTo(actions.expressionInput, this.outputIfChanged);
    this.listenTo(actions.expressionChange, this.outputIfChanged);
    this.lastInput = '';
  },
  outputIfChanged: function(rawInput) {
    if (rawInput === this.lastInput) { return; }
    this.trigger(rawInput);
    this.lastInput = rawInput;
  }
});


var astStore = Reflux.createStore({

  init: function() {
    this.listenTo(expressionStore, this.parse);
    this.lastExpr = null;
  },

  parse: function(newExpr) {
    var ast;
    try {
      ast = parse(newExpr);
    } catch (e) {
      actions.expressionError(e);
      var okExpr = newExpr;
      while (okExpr = okExpr.slice(0, -1)) { // trim from the end until we get a valid ast
        try {
          ast = parse(okExpr);
          break;
        } catch (err) {
          continue;
        }
      }
    }
    this.trigger(ast);
  }

});


var uiExprWidthStore = Reflux.createStore({

  init: function() {
    this.listenTo(actions.expressionWidthChange, this.changeWidth);
    this.width = 200;
  },

  changeWidth: function(exprWidth) {
    var newWidth = Math.max(256, exprWidth + 32);
    if (newWidth !== this.width) {
      this.width = newWidth;
      this.trigger(newWidth);
    }
  }

});


var contextStore = Reflux.createStore({

  init: function() {
    this.listenTo(astStore, this.refreshContext);
    this.listenTo(actions.contextChange, this.updateContext);
    this.listenTo(actions.contextSet, this.setContext);
    this.context = {};
    this.contextCache = {};  // keep settings for a variable around
  },

  refreshContext: function(ast) {
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


var stateStore = Reflux.createStore({

  init: function() {
    this.listenTo(expressionStore, this.newExpression);
    this.listenTo(contextCommitStore, this.newContext);
    this.state = {
      expr: '',
      context: {}
    };
  },

  newExpression: function(expr) {
    this.state.expr = expr;
    this.trigger(this.state);
  },

  newContext: function(context) {
    this.state.context = context;
    this.trigger(this.state);
  }

});


var encodedStateStore = Reflux.createStore({
  // #expr="URLENCODED"&name=e;5;0;10
  init: function() {
    this.listenTo(flowThrottle(stateStore), this.encode);
  },

  encode: function(state) {
    var pieces = Object.keys(state.context).map(function(name) {
      return 'name=' + name + ';' + this.encodeName(state.context[name]);
    }, this);
    pieces.unshift('expr=' + this.encodeExpr(state.expr));
    this.trigger(pieces.join('&'));
  },

  encodeExpr: function(expr) {
    return encodeURIComponent(cleanExpr(expr));
  },

  encodeName: function(nameContext) {
    var encoded = '' + nameContext.value;
    if (nameContext.type === 'range') {
      encoded = [encoded, nameContext.min, nameContext.max].join(';');
    }
    return encoded;
  }
});

var decodedStateStore = Reflux.createStore({

  init: function() {
    this.listenTo(actions.encodedStateChange, this.decode);
  },

  decode: function(encoded) {
    var _this = this;  // Array.prototype.reduce takes no thisValue
    var state = encoded
      .split('&')
      .map(function(piece) { return piece.split('='); })
      .reduce(function(state, pieces) {
        var encKey = pieces[0],
            encVal = pieces[1];
        if (encKey === 'expr') {
          if (state[encKey]) { console.warn('duplicate key', encKey); }
          state.expr = _this.decodeExpr(encVal);
        } else if (encKey === 'name') {
          var parts = encVal.split(';');
          if (state.context[encKey]) { console.warn('duplicate key', encKey); }
          state.context[parts[0]] = _this.decodeName(parts.slice(1));
        } else {
          console.warn('garbage encoded part:', encKey, encVal);
        }
        return state;
      }, {expr: '', context: {}});
    actions.expressionChange(state.expr);
    actions.contextSet(state.context, true);
    actions.contextCommit();
    this.trigger(state);
  },

  decodeExpr: function(encodedExpr) {
    var exprValue;
    // first, get rid of the url encoding
    try {
      exprValue = decodeURIComponent(encodedExpr);
    } catch (err) {  // firefox may give it to us already-decoded
      exprValue = encodedExpr;
    }
    // then, make sure it's a valid expression, not something nasty
    return cleanExpr(exprValue);
  },

  decodeName: function(parts) {
    var nameContext = { 'value': parseNumba(parts[0]) };
    if (parts.length === 3) {
      extend(nameContext, {
        'type': 'range',
        'min': parseNumba(parts[1]),
        'max': parseNumba(parts[2])
      });
    } else {
      extend(nameContext, {
        'type': 'const',
        'min': 0,
        'max': 10
      });
      if (parts.length !== 1) { console.warn('bad name context', parts);}
    }
    return nameContext;
  }
});


function BarsComponent(root) {
  astStore.listen(newBars);
  contextStore.listen(scaleBars);
  uiExprWidthStore.listen(changeGraphWidth);

  var bl = crel('span', {'class': 'expr-bars'}),
      barIdMap,
      barValuer = values('0');

  crel(root, bl);

  function newBars(ast) {
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


function InputComponent(root) {
  root.addEventListener('keyup', input, false);
  root.addEventListener('change', change, false);

  decodedStateStore.listen(setInput);
  astStore.listen(highlight);
  expressionStore.listen(measureExpressionWidth);
  uiExprWidthStore.listen(changeInputWidth);

  function input(e) { actions.expressionInput(e.target.value); }
  function change(e) { actions.expressionChange(e.target.value); }

  // TODO: make render a seperate step from init maybe
  var hl = crel('span', {'class': 'expr-input-highlighted'}),
      containerEl = crel('div', {'class': 'expr-input'}),
      widthMeasureEl = crel('span', {'class': 'expr-input-highlighted'});
  emptyEl(root);
  style(widthMeasureEl, {'visibility': 'hidden'});
  crel(root,
    crel(containerEl,
      hl,
      crel('input', {
        'class': 'expr-input-textinput',
        'spellcheck': 'false'
      }),
      widthMeasureEl));


  function setInput(state) {
    root.querySelector('.expr-input-textinput').value = state.expr;
  }

  function highlight(ast) {
    emptyEl(hl);
    if (!ast) { return; }
    crel(hl, walkTemplatesToDom(ast, 'text'));
  }

  function measureExpressionWidth(expr) {
    widthMeasureEl.textContent = expr;
    var width = widthMeasureEl.offsetWidth;
    actions.expressionWidthChange(width);
  }

  function changeInputWidth(newWidth) {
    style(containerEl, {width: newWidth + 'px'});
  }
}


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


function URLComponent(w) {
  var pushRemove = encodedStateStore.listen(pushState);
  w.addEventListener('hashchange', onHashChange, false);

  function pushState(encodedState) {
    w.removeEventListener('hashchange', onHashChange, false);
    w.location.hash = encodedState;
    window.setImmediate(function() {
      w.addEventListener('hashchange', onHashChange, false);
    });
  }

  function onHashChange() {
    var hash = w.location.hash.slice(1);  // remove leading #
    pushRemove();
    actions.encodedStateChange(hash);
    var tmp = encodedStateStore.listen(function() {
      tmp();
      pushRemove = encodedStateStore.listen(pushState);
    });
  }

  onHashChange();
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
      inputEl = crel('div'),
      contextEl = crel('div');
  crel(root,
    barsEl,
    inputEl,
    contextEl
  );

  new BarsComponent(barsEl);
  new InputComponent(inputEl);
  new ContextComponent(contextEl);

  new URLComponent(window);

})(document.getElementById('expression'));

},{"crel":2,"es5-shim":3,"expression-compiler/echo":4,"expression-compiler/func":5,"expression-compiler/parse":8,"expression-compiler/values":9,"reflux":21,"setimmediate":26}],2:[function(require,module,exports){
//Copyright (C) 2012 Kory Nunn

//Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

//The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

//THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/*

    This code is not formatted for readability, but rather run-speed and to assist compilers.

    However, the code's intention should be transparent.

    *** IE SUPPORT ***

    If you require this library to work in IE7, add the following after declaring crel.

    var testDiv = document.createElement('div'),
        testLabel = document.createElement('label');

    testDiv.setAttribute('class', 'a');
    testDiv['className'] !== 'a' ? crel.attrMap['class'] = 'className':undefined;
    testDiv.setAttribute('name','a');
    testDiv['name'] !== 'a' ? crel.attrMap['name'] = function(element, value){
        element.id = value;
    }:undefined;


    testLabel.setAttribute('for', 'a');
    testLabel['htmlFor'] !== 'a' ? crel.attrMap['for'] = 'htmlFor':undefined;



*/

(function (root, factory) {
    if (typeof exports === 'object') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        root.crel = factory();
    }
}(this, function () {
    var fn = 'function',
        obj = 'object',
        isType = function(a, type){
            return typeof a === type;
        },
        isNode = typeof Node === fn ? function (object) {
            return object instanceof Node;
        } :
        // in IE <= 8 Node is an object, obviously..
        function(object){
            return object &&
                isType(object, obj) &&
                ('nodeType' in object) &&
                isType(object.ownerDocument,obj);
        },
        isElement = function (object) {
            return crel.isNode(object) && object.nodeType === 1;
        },
        isArray = function(a){
            return a instanceof Array;
        },
        appendChild = function(element, child) {
          if(!isNode(child)){
              child = document.createTextNode(child);
          }
          element.appendChild(child);
        };


    function crel(){
        var args = arguments, //Note: assigned to a variable to assist compilers. Saves about 40 bytes in closure compiler. Has negligable effect on performance.
            element = args[0],
            child,
            settings = args[1],
            childIndex = 2,
            argumentsLength = args.length,
            attributeMap = crel.attrMap;

        element = crel.isElement(element) ? element : document.createElement(element);
        // shortcut
        if(argumentsLength === 1){
            return element;
        }

        if(!isType(settings,obj) || crel.isNode(settings) || isArray(settings)) {
            --childIndex;
            settings = null;
        }

        // shortcut if there is only one child that is a string
        if((argumentsLength - childIndex) === 1 && isType(args[childIndex], 'string') && element.textContent !== undefined){
            element.textContent = args[childIndex];
        }else{
            for(; childIndex < argumentsLength; ++childIndex){
                child = args[childIndex];

                if(child == null){
                    continue;
                }

                if (isArray(child)) {
                  for (var i=0; i < child.length; ++i) {
                    appendChild(element, child[i]);
                  }
                } else {
                  appendChild(element, child);
                }
            }
        }

        for(var key in settings){
            if(!attributeMap[key]){
                element.setAttribute(key, settings[key]);
            }else{
                var attr = crel.attrMap[key];
                if(typeof attr === fn){
                    attr(element, settings[key]);
                }else{
                    element.setAttribute(attr, settings[key]);
                }
            }
        }

        return element;
    }

    // Used for mapping one kind of attribute to the supported version of that in bad browsers.
    // String referenced so that compilers maintain the property name.
    crel['attrMap'] = {};

    // String referenced so that compilers maintain the property name.
    crel["isElement"] = isElement;
    crel["isNode"] = isNode;

    return crel;
}));

},{}],3:[function(require,module,exports){
/*!
 * https://github.com/es-shims/es5-shim
 * @license es5-shim Copyright 2009-2014 by contributors, MIT License
 * see https://github.com/es-shims/es5-shim/blob/master/LICENSE
 */

// vim: ts=4 sts=4 sw=4 expandtab


// UMD (Universal Module Definition)
// see https://github.com/umdjs/umd/blob/master/returnExports.js
// Add semicolon to prevent IIFE from being passed as argument to concatenated code.
;(function (root, factory) {
    'use strict';
    /*global define, exports, module */
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(factory);
    } else if (typeof exports === 'object') {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like enviroments that support module.exports,
        // like Node.
        module.exports = factory();
    } else {
        // Browser globals (root is window)
        root.returnExports = factory();
    }
}(this, function () {

/**
 * Brings an environment as close to ECMAScript 5 compliance
 * as is possible with the facilities of erstwhile engines.
 *
 * Annotated ES5: http://es5.github.com/ (specific links below)
 * ES5 Spec: http://www.ecma-international.org/publications/files/ECMA-ST/Ecma-262.pdf
 * Required reading: http://javascriptweblog.wordpress.com/2011/12/05/extending-javascript-natives/
 */

// Shortcut to an often accessed properties, in order to avoid multiple
// dereference that costs universally.
var ArrayPrototype = Array.prototype;
var ObjectPrototype = Object.prototype;
var FunctionPrototype = Function.prototype;
var StringPrototype = String.prototype;
var NumberPrototype = Number.prototype;
var array_slice = ArrayPrototype.slice;
var array_splice = ArrayPrototype.splice;
var array_push = ArrayPrototype.push;
var array_unshift = ArrayPrototype.unshift;
var call = FunctionPrototype.call;

// Having a toString local variable name breaks in Opera so use to_string.
var to_string = ObjectPrototype.toString;

var isFunction = function (val) {
    return to_string.call(val) === '[object Function]';
};
var isRegex = function (val) {
    return to_string.call(val) === '[object RegExp]';
};
var isArray = function isArray(obj) {
    return to_string.call(obj) === '[object Array]';
};
var isString = function isString(obj) {
    return to_string.call(obj) === '[object String]';
};
var isArguments = function isArguments(value) {
    var str = to_string.call(value);
    var isArgs = str === '[object Arguments]';
    if (!isArgs) {
        isArgs = !isArray(value) &&
          value !== null &&
          typeof value === 'object' &&
          typeof value.length === 'number' &&
          value.length >= 0 &&
          isFunction(value.callee);
    }
    return isArgs;
};

var supportsDescriptors = Object.defineProperty && (function () {
    try {
        Object.defineProperty({}, 'x', {});
        return true;
    } catch (e) { /* this is ES3 */
        return false;
    }
}());

// Define configurable, writable and non-enumerable props
// if they don't exist.
var defineProperty;
if (supportsDescriptors) {
    defineProperty = function (object, name, method, forceAssign) {
        if (!forceAssign && (name in object)) { return; }
        Object.defineProperty(object, name, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: method
        });
    };
} else {
    defineProperty = function (object, name, method, forceAssign) {
        if (!forceAssign && (name in object)) { return; }
        object[name] = method;
    };
}
var defineProperties = function (object, map, forceAssign) {
    for (var name in map) {
        if (ObjectPrototype.hasOwnProperty.call(map, name)) {
          defineProperty(object, name, map[name], forceAssign);
        }
    }
};

//
// Util
// ======
//

// ES5 9.4
// http://es5.github.com/#x9.4
// http://jsperf.com/to-integer

function toInteger(num) {
    var n = +num;
    if (n !== n) { // isNaN
        n = 0;
    } else if (n !== 0 && n !== (1 / 0) && n !== -(1 / 0)) {
        n = (n > 0 || -1) * Math.floor(Math.abs(n));
    }
    return n;
}

function isPrimitive(input) {
    var type = typeof input;
    return input === null ||
        type === 'undefined' ||
        type === 'boolean' ||
        type === 'number' ||
        type === 'string';
}

function toPrimitive(input) {
    var val, valueOf, toStr;
    if (isPrimitive(input)) {
        return input;
    }
    valueOf = input.valueOf;
    if (isFunction(valueOf)) {
        val = valueOf.call(input);
        if (isPrimitive(val)) {
            return val;
        }
    }
    toStr = input.toString;
    if (isFunction(toStr)) {
        val = toStr.call(input);
        if (isPrimitive(val)) {
            return val;
        }
    }
    throw new TypeError();
}

var ES = {
    // ES5 9.9
    // http://es5.github.com/#x9.9
    ToObject: function (o) {
        /*jshint eqnull: true */
        if (o == null) { // this matches both null and undefined
            throw new TypeError("can't convert " + o + ' to object');
        }
        return Object(o);
    },
    ToUint32: function ToUint32(x) {
        return x >>> 0;
    }
};

//
// Function
// ========
//

// ES-5 15.3.4.5
// http://es5.github.com/#x15.3.4.5

var Empty = function Empty() {};

defineProperties(FunctionPrototype, {
    bind: function bind(that) { // .length is 1
        // 1. Let Target be the this value.
        var target = this;
        // 2. If IsCallable(Target) is false, throw a TypeError exception.
        if (!isFunction(target)) {
            throw new TypeError('Function.prototype.bind called on incompatible ' + target);
        }
        // 3. Let A be a new (possibly empty) internal list of all of the
        //   argument values provided after thisArg (arg1, arg2 etc), in order.
        // XXX slicedArgs will stand in for "A" if used
        var args = array_slice.call(arguments, 1); // for normal call
        // 4. Let F be a new native ECMAScript object.
        // 11. Set the [[Prototype]] internal property of F to the standard
        //   built-in Function prototype object as specified in 15.3.3.1.
        // 12. Set the [[Call]] internal property of F as described in
        //   15.3.4.5.1.
        // 13. Set the [[Construct]] internal property of F as described in
        //   15.3.4.5.2.
        // 14. Set the [[HasInstance]] internal property of F as described in
        //   15.3.4.5.3.
        var bound;
        var binder = function () {

            if (this instanceof bound) {
                // 15.3.4.5.2 [[Construct]]
                // When the [[Construct]] internal method of a function object,
                // F that was created using the bind function is called with a
                // list of arguments ExtraArgs, the following steps are taken:
                // 1. Let target be the value of F's [[TargetFunction]]
                //   internal property.
                // 2. If target has no [[Construct]] internal method, a
                //   TypeError exception is thrown.
                // 3. Let boundArgs be the value of F's [[BoundArgs]] internal
                //   property.
                // 4. Let args be a new list containing the same values as the
                //   list boundArgs in the same order followed by the same
                //   values as the list ExtraArgs in the same order.
                // 5. Return the result of calling the [[Construct]] internal
                //   method of target providing args as the arguments.

                var result = target.apply(
                    this,
                    args.concat(array_slice.call(arguments))
                );
                if (Object(result) === result) {
                    return result;
                }
                return this;

            } else {
                // 15.3.4.5.1 [[Call]]
                // When the [[Call]] internal method of a function object, F,
                // which was created using the bind function is called with a
                // this value and a list of arguments ExtraArgs, the following
                // steps are taken:
                // 1. Let boundArgs be the value of F's [[BoundArgs]] internal
                //   property.
                // 2. Let boundThis be the value of F's [[BoundThis]] internal
                //   property.
                // 3. Let target be the value of F's [[TargetFunction]] internal
                //   property.
                // 4. Let args be a new list containing the same values as the
                //   list boundArgs in the same order followed by the same
                //   values as the list ExtraArgs in the same order.
                // 5. Return the result of calling the [[Call]] internal method
                //   of target providing boundThis as the this value and
                //   providing args as the arguments.

                // equiv: target.call(this, ...boundArgs, ...args)
                return target.apply(
                    that,
                    args.concat(array_slice.call(arguments))
                );

            }

        };

        // 15. If the [[Class]] internal property of Target is "Function", then
        //     a. Let L be the length property of Target minus the length of A.
        //     b. Set the length own property of F to either 0 or L, whichever is
        //       larger.
        // 16. Else set the length own property of F to 0.

        var boundLength = Math.max(0, target.length - args.length);

        // 17. Set the attributes of the length own property of F to the values
        //   specified in 15.3.5.1.
        var boundArgs = [];
        for (var i = 0; i < boundLength; i++) {
            boundArgs.push('$' + i);
        }

        // XXX Build a dynamic function with desired amount of arguments is the only
        // way to set the length property of a function.
        // In environments where Content Security Policies enabled (Chrome extensions,
        // for ex.) all use of eval or Function costructor throws an exception.
        // However in all of these environments Function.prototype.bind exists
        // and so this code will never be executed.
        bound = Function('binder', 'return function (' + boundArgs.join(',') + '){ return binder.apply(this, arguments); }')(binder);

        if (target.prototype) {
            Empty.prototype = target.prototype;
            bound.prototype = new Empty();
            // Clean up dangling references.
            Empty.prototype = null;
        }

        // TODO
        // 18. Set the [[Extensible]] internal property of F to true.

        // TODO
        // 19. Let thrower be the [[ThrowTypeError]] function Object (13.2.3).
        // 20. Call the [[DefineOwnProperty]] internal method of F with
        //   arguments "caller", PropertyDescriptor {[[Get]]: thrower, [[Set]]:
        //   thrower, [[Enumerable]]: false, [[Configurable]]: false}, and
        //   false.
        // 21. Call the [[DefineOwnProperty]] internal method of F with
        //   arguments "arguments", PropertyDescriptor {[[Get]]: thrower,
        //   [[Set]]: thrower, [[Enumerable]]: false, [[Configurable]]: false},
        //   and false.

        // TODO
        // NOTE Function objects created using Function.prototype.bind do not
        // have a prototype property or the [[Code]], [[FormalParameters]], and
        // [[Scope]] internal properties.
        // XXX can't delete prototype in pure-js.

        // 22. Return F.
        return bound;
    }
});

// _Please note: Shortcuts are defined after `Function.prototype.bind` as we
// us it in defining shortcuts.
var owns = call.bind(ObjectPrototype.hasOwnProperty);

//
// Array
// =====
//

// ES5 15.4.4.12
// http://es5.github.com/#x15.4.4.12
var spliceNoopReturnsEmptyArray = (function () {
    var a = [1, 2];
    var result = a.splice();
    return a.length === 2 && isArray(result) && result.length === 0;
}());
defineProperties(ArrayPrototype, {
    // Safari 5.0 bug where .splice() returns undefined
    splice: function splice(start, deleteCount) {
        if (arguments.length === 0) {
            return [];
        } else {
            return array_splice.apply(this, arguments);
        }
    }
}, spliceNoopReturnsEmptyArray);

var spliceWorksWithEmptyObject = (function () {
    var obj = {};
    ArrayPrototype.splice.call(obj, 0, 0, 1);
    return obj.length === 1;
}());
defineProperties(ArrayPrototype, {
    splice: function splice(start, deleteCount) {
        if (arguments.length === 0) { return []; }
        var args = arguments;
        this.length = Math.max(toInteger(this.length), 0);
        if (arguments.length > 0 && typeof deleteCount !== 'number') {
            args = array_slice.call(arguments);
            if (args.length < 2) {
                args.push(this.length - start);
            } else {
                args[1] = toInteger(deleteCount);
            }
        }
        return array_splice.apply(this, args);
    }
}, !spliceWorksWithEmptyObject);

// ES5 15.4.4.12
// http://es5.github.com/#x15.4.4.13
// Return len+argCount.
// [bugfix, ielt8]
// IE < 8 bug: [].unshift(0) === undefined but should be "1"
var hasUnshiftReturnValueBug = [].unshift(0) !== 1;
defineProperties(ArrayPrototype, {
    unshift: function () {
        array_unshift.apply(this, arguments);
        return this.length;
    }
}, hasUnshiftReturnValueBug);

// ES5 15.4.3.2
// http://es5.github.com/#x15.4.3.2
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/Array/isArray
defineProperties(Array, { isArray: isArray });

// The IsCallable() check in the Array functions
// has been replaced with a strict check on the
// internal class of the object to trap cases where
// the provided function was actually a regular
// expression literal, which in V8 and
// JavaScriptCore is a typeof "function".  Only in
// V8 are regular expression literals permitted as
// reduce parameters, so it is desirable in the
// general case for the shim to match the more
// strict and common behavior of rejecting regular
// expressions.

// ES5 15.4.4.18
// http://es5.github.com/#x15.4.4.18
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/array/forEach

// Check failure of by-index access of string characters (IE < 9)
// and failure of `0 in boxedString` (Rhino)
var boxedString = Object('a');
var splitString = boxedString[0] !== 'a' || !(0 in boxedString);

var properlyBoxesContext = function properlyBoxed(method) {
    // Check node 0.6.21 bug where third parameter is not boxed
    var properlyBoxesNonStrict = true;
    var properlyBoxesStrict = true;
    if (method) {
        method.call('foo', function (_, __, context) {
            if (typeof context !== 'object') { properlyBoxesNonStrict = false; }
        });

        method.call([1], function () {
            'use strict';
            properlyBoxesStrict = typeof this === 'string';
        }, 'x');
    }
    return !!method && properlyBoxesNonStrict && properlyBoxesStrict;
};

defineProperties(ArrayPrototype, {
    forEach: function forEach(fun /*, thisp*/) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            thisp = arguments[1],
            i = -1,
            length = self.length >>> 0;

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(); // TODO message
        }

        while (++i < length) {
            if (i in self) {
                // Invoke the callback function with call, passing arguments:
                // context, property value, property key, thisArg object
                // context
                fun.call(thisp, self[i], i, object);
            }
        }
    }
}, !properlyBoxesContext(ArrayPrototype.forEach));

// ES5 15.4.4.19
// http://es5.github.com/#x15.4.4.19
// https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Objects/Array/map
defineProperties(ArrayPrototype, {
    map: function map(fun /*, thisp*/) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            length = self.length >>> 0,
            result = Array(length),
            thisp = arguments[1];

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(fun + ' is not a function');
        }

        for (var i = 0; i < length; i++) {
            if (i in self) {
                result[i] = fun.call(thisp, self[i], i, object);
            }
        }
        return result;
    }
}, !properlyBoxesContext(ArrayPrototype.map));

// ES5 15.4.4.20
// http://es5.github.com/#x15.4.4.20
// https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Objects/Array/filter
defineProperties(ArrayPrototype, {
    filter: function filter(fun /*, thisp */) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            length = self.length >>> 0,
            result = [],
            value,
            thisp = arguments[1];

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(fun + ' is not a function');
        }

        for (var i = 0; i < length; i++) {
            if (i in self) {
                value = self[i];
                if (fun.call(thisp, value, i, object)) {
                    result.push(value);
                }
            }
        }
        return result;
    }
}, !properlyBoxesContext(ArrayPrototype.filter));

// ES5 15.4.4.16
// http://es5.github.com/#x15.4.4.16
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/Array/every
defineProperties(ArrayPrototype, {
    every: function every(fun /*, thisp */) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            length = self.length >>> 0,
            thisp = arguments[1];

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(fun + ' is not a function');
        }

        for (var i = 0; i < length; i++) {
            if (i in self && !fun.call(thisp, self[i], i, object)) {
                return false;
            }
        }
        return true;
    }
}, !properlyBoxesContext(ArrayPrototype.every));

// ES5 15.4.4.17
// http://es5.github.com/#x15.4.4.17
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/Array/some
defineProperties(ArrayPrototype, {
    some: function some(fun /*, thisp */) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            length = self.length >>> 0,
            thisp = arguments[1];

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(fun + ' is not a function');
        }

        for (var i = 0; i < length; i++) {
            if (i in self && fun.call(thisp, self[i], i, object)) {
                return true;
            }
        }
        return false;
    }
}, !properlyBoxesContext(ArrayPrototype.some));

// ES5 15.4.4.21
// http://es5.github.com/#x15.4.4.21
// https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Objects/Array/reduce
var reduceCoercesToObject = false;
if (ArrayPrototype.reduce) {
    reduceCoercesToObject = typeof ArrayPrototype.reduce.call('es5', function (_, __, ___, list) { return list; }) === 'object';
}
defineProperties(ArrayPrototype, {
    reduce: function reduce(fun /*, initial*/) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            length = self.length >>> 0;

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(fun + ' is not a function');
        }

        // no value to return if no initial value and an empty array
        if (!length && arguments.length === 1) {
            throw new TypeError('reduce of empty array with no initial value');
        }

        var i = 0;
        var result;
        if (arguments.length >= 2) {
            result = arguments[1];
        } else {
            do {
                if (i in self) {
                    result = self[i++];
                    break;
                }

                // if array contains no values, no initial value to return
                if (++i >= length) {
                    throw new TypeError('reduce of empty array with no initial value');
                }
            } while (true);
        }

        for (; i < length; i++) {
            if (i in self) {
                result = fun.call(void 0, result, self[i], i, object);
            }
        }

        return result;
    }
}, !reduceCoercesToObject);

// ES5 15.4.4.22
// http://es5.github.com/#x15.4.4.22
// https://developer.mozilla.org/en/Core_JavaScript_1.5_Reference/Objects/Array/reduceRight
var reduceRightCoercesToObject = false;
if (ArrayPrototype.reduceRight) {
    reduceRightCoercesToObject = typeof ArrayPrototype.reduceRight.call('es5', function (_, __, ___, list) { return list; }) === 'object';
}
defineProperties(ArrayPrototype, {
    reduceRight: function reduceRight(fun /*, initial*/) {
        var object = ES.ToObject(this),
            self = splitString && isString(this) ? this.split('') : object,
            length = self.length >>> 0;

        // If no callback function or if callback is not a callable function
        if (!isFunction(fun)) {
            throw new TypeError(fun + ' is not a function');
        }

        // no value to return if no initial value, empty array
        if (!length && arguments.length === 1) {
            throw new TypeError('reduceRight of empty array with no initial value');
        }

        var result, i = length - 1;
        if (arguments.length >= 2) {
            result = arguments[1];
        } else {
            do {
                if (i in self) {
                    result = self[i--];
                    break;
                }

                // if array contains no values, no initial value to return
                if (--i < 0) {
                    throw new TypeError('reduceRight of empty array with no initial value');
                }
            } while (true);
        }

        if (i < 0) {
            return result;
        }

        do {
            if (i in self) {
                result = fun.call(void 0, result, self[i], i, object);
            }
        } while (i--);

        return result;
    }
}, !reduceRightCoercesToObject);

// ES5 15.4.4.14
// http://es5.github.com/#x15.4.4.14
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/Array/indexOf
var hasFirefox2IndexOfBug = Array.prototype.indexOf && [0, 1].indexOf(1, 2) !== -1;
defineProperties(ArrayPrototype, {
    indexOf: function indexOf(sought /*, fromIndex */) {
        var self = splitString && isString(this) ? this.split('') : ES.ToObject(this),
            length = self.length >>> 0;

        if (!length) {
            return -1;
        }

        var i = 0;
        if (arguments.length > 1) {
            i = toInteger(arguments[1]);
        }

        // handle negative indices
        i = i >= 0 ? i : Math.max(0, length + i);
        for (; i < length; i++) {
            if (i in self && self[i] === sought) {
                return i;
            }
        }
        return -1;
    }
}, hasFirefox2IndexOfBug);

// ES5 15.4.4.15
// http://es5.github.com/#x15.4.4.15
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/Array/lastIndexOf
var hasFirefox2LastIndexOfBug = Array.prototype.lastIndexOf && [0, 1].lastIndexOf(0, -3) !== -1;
defineProperties(ArrayPrototype, {
    lastIndexOf: function lastIndexOf(sought /*, fromIndex */) {
        var self = splitString && isString(this) ? this.split('') : ES.ToObject(this),
            length = self.length >>> 0;

        if (!length) {
            return -1;
        }
        var i = length - 1;
        if (arguments.length > 1) {
            i = Math.min(i, toInteger(arguments[1]));
        }
        // handle negative indices
        i = i >= 0 ? i : length - Math.abs(i);
        for (; i >= 0; i--) {
            if (i in self && sought === self[i]) {
                return i;
            }
        }
        return -1;
    }
}, hasFirefox2LastIndexOfBug);

//
// Object
// ======
//

// ES5 15.2.3.14
// http://es5.github.com/#x15.2.3.14

// http://whattheheadsaid.com/2010/10/a-safer-object-keys-compatibility-implementation
var hasDontEnumBug = !({'toString': null}).propertyIsEnumerable('toString'),
    hasProtoEnumBug = function () {}.propertyIsEnumerable('prototype'),
    dontEnums = [
        'toString',
        'toLocaleString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'constructor'
    ],
    dontEnumsLength = dontEnums.length;

defineProperties(Object, {
    keys: function keys(object) {
        var isFn = isFunction(object),
            isArgs = isArguments(object),
            isObject = object !== null && typeof object === 'object',
            isStr = isObject && isString(object);

        if (!isObject && !isFn && !isArgs) {
            throw new TypeError('Object.keys called on a non-object');
        }

        var theKeys = [];
        var skipProto = hasProtoEnumBug && isFn;
        if (isStr || isArgs) {
            for (var i = 0; i < object.length; ++i) {
                theKeys.push(String(i));
            }
        } else {
            for (var name in object) {
                if (!(skipProto && name === 'prototype') && owns(object, name)) {
                    theKeys.push(String(name));
                }
            }
        }

        if (hasDontEnumBug) {
            var ctor = object.constructor,
                skipConstructor = ctor && ctor.prototype === object;
            for (var j = 0; j < dontEnumsLength; j++) {
                var dontEnum = dontEnums[j];
                if (!(skipConstructor && dontEnum === 'constructor') && owns(object, dontEnum)) {
                    theKeys.push(dontEnum);
                }
            }
        }
        return theKeys;
    }
});

var keysWorksWithArguments = Object.keys && (function () {
    // Safari 5.0 bug
    return Object.keys(arguments).length === 2;
}(1, 2));
var originalKeys = Object.keys;
defineProperties(Object, {
    keys: function keys(object) {
        if (isArguments(object)) {
            return originalKeys(ArrayPrototype.slice.call(object));
        } else {
            return originalKeys(object);
        }
    }
}, !keysWorksWithArguments);

//
// Date
// ====
//

// ES5 15.9.5.43
// http://es5.github.com/#x15.9.5.43
// This function returns a String value represent the instance in time
// represented by this Date object. The format of the String is the Date Time
// string format defined in 15.9.1.15. All fields are present in the String.
// The time zone is always UTC, denoted by the suffix Z. If the time value of
// this object is not a finite Number a RangeError exception is thrown.
var negativeDate = -62198755200000;
var negativeYearString = '-000001';
var hasNegativeDateBug = Date.prototype.toISOString && new Date(negativeDate).toISOString().indexOf(negativeYearString) === -1;

defineProperties(Date.prototype, {
    toISOString: function toISOString() {
        var result, length, value, year, month;
        if (!isFinite(this)) {
            throw new RangeError('Date.prototype.toISOString called on non-finite value.');
        }

        year = this.getUTCFullYear();

        month = this.getUTCMonth();
        // see https://github.com/es-shims/es5-shim/issues/111
        year += Math.floor(month / 12);
        month = (month % 12 + 12) % 12;

        // the date time string format is specified in 15.9.1.15.
        result = [month + 1, this.getUTCDate(), this.getUTCHours(), this.getUTCMinutes(), this.getUTCSeconds()];
        year = (
            (year < 0 ? '-' : (year > 9999 ? '+' : '')) +
            ('00000' + Math.abs(year)).slice(0 <= year && year <= 9999 ? -4 : -6)
        );

        length = result.length;
        while (length--) {
            value = result[length];
            // pad months, days, hours, minutes, and seconds to have two
            // digits.
            if (value < 10) {
                result[length] = '0' + value;
            }
        }
        // pad milliseconds to have three digits.
        return (
            year + '-' + result.slice(0, 2).join('-') +
            'T' + result.slice(2).join(':') + '.' +
            ('000' + this.getUTCMilliseconds()).slice(-3) + 'Z'
        );
    }
}, hasNegativeDateBug);


// ES5 15.9.5.44
// http://es5.github.com/#x15.9.5.44
// This function provides a String representation of a Date object for use by
// JSON.stringify (15.12.3).
var dateToJSONIsSupported = false;
try {
    dateToJSONIsSupported = (
        Date.prototype.toJSON &&
        new Date(NaN).toJSON() === null &&
        new Date(negativeDate).toJSON().indexOf(negativeYearString) !== -1 &&
        Date.prototype.toJSON.call({ // generic
            toISOString: function () {
                return true;
            }
        })
    );
} catch (e) {
}
if (!dateToJSONIsSupported) {
    Date.prototype.toJSON = function toJSON(key) {
        // When the toJSON method is called with argument key, the following
        // steps are taken:

        // 1.  Let O be the result of calling ToObject, giving it the this
        // value as its argument.
        // 2. Let tv be toPrimitive(O, hint Number).
        var o = Object(this),
            tv = toPrimitive(o),
            toISO;
        // 3. If tv is a Number and is not finite, return null.
        if (typeof tv === 'number' && !isFinite(tv)) {
            return null;
        }
        // 4. Let toISO be the result of calling the [[Get]] internal method of
        // O with argument "toISOString".
        toISO = o.toISOString;
        // 5. If IsCallable(toISO) is false, throw a TypeError exception.
        if (typeof toISO !== 'function') {
            throw new TypeError('toISOString property is not callable');
        }
        // 6. Return the result of calling the [[Call]] internal method of
        //  toISO with O as the this value and an empty argument list.
        return toISO.call(o);

        // NOTE 1 The argument is ignored.

        // NOTE 2 The toJSON function is intentionally generic; it does not
        // require that its this value be a Date object. Therefore, it can be
        // transferred to other kinds of objects for use as a method. However,
        // it does require that any such object have a toISOString method. An
        // object is free to use the argument key to filter its
        // stringification.
    };
}

// ES5 15.9.4.2
// http://es5.github.com/#x15.9.4.2
// based on work shared by Daniel Friesen (dantman)
// http://gist.github.com/303249
var supportsExtendedYears = Date.parse('+033658-09-27T01:46:40.000Z') === 1e15;
var acceptsInvalidDates = !isNaN(Date.parse('2012-04-04T24:00:00.500Z')) || !isNaN(Date.parse('2012-11-31T23:59:59.000Z'));
var doesNotParseY2KNewYear = isNaN(Date.parse('2000-01-01T00:00:00.000Z'));
if (!Date.parse || doesNotParseY2KNewYear || acceptsInvalidDates || !supportsExtendedYears) {
    // XXX global assignment won't work in embeddings that use
    // an alternate object for the context.
    /*global Date: true */
    Date = (function (NativeDate) {

        // Date.length === 7
        function Date(Y, M, D, h, m, s, ms) {
            var length = arguments.length;
            if (this instanceof NativeDate) {
                var date = length === 1 && String(Y) === Y ? // isString(Y)
                    // We explicitly pass it through parse:
                    new NativeDate(Date.parse(Y)) :
                    // We have to manually make calls depending on argument
                    // length here
                    length >= 7 ? new NativeDate(Y, M, D, h, m, s, ms) :
                    length >= 6 ? new NativeDate(Y, M, D, h, m, s) :
                    length >= 5 ? new NativeDate(Y, M, D, h, m) :
                    length >= 4 ? new NativeDate(Y, M, D, h) :
                    length >= 3 ? new NativeDate(Y, M, D) :
                    length >= 2 ? new NativeDate(Y, M) :
                    length >= 1 ? new NativeDate(Y) :
                                  new NativeDate();
                // Prevent mixups with unfixed Date object
                date.constructor = Date;
                return date;
            }
            return NativeDate.apply(this, arguments);
        }

        // 15.9.1.15 Date Time String Format.
        var isoDateExpression = new RegExp('^' +
            '(\\d{4}|[+-]\\d{6})' + // four-digit year capture or sign +
                                      // 6-digit extended year
            '(?:-(\\d{2})' + // optional month capture
            '(?:-(\\d{2})' + // optional day capture
            '(?:' + // capture hours:minutes:seconds.milliseconds
                'T(\\d{2})' + // hours capture
                ':(\\d{2})' + // minutes capture
                '(?:' + // optional :seconds.milliseconds
                    ':(\\d{2})' + // seconds capture
                    '(?:(\\.\\d{1,}))?' + // milliseconds capture
                ')?' +
            '(' + // capture UTC offset component
                'Z|' + // UTC capture
                '(?:' + // offset specifier +/-hours:minutes
                    '([-+])' + // sign capture
                    '(\\d{2})' + // hours offset capture
                    ':(\\d{2})' + // minutes offset capture
                ')' +
            ')?)?)?)?' +
        '$');

        var months = [
            0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365
        ];

        function dayFromMonth(year, month) {
            var t = month > 1 ? 1 : 0;
            return (
                months[month] +
                Math.floor((year - 1969 + t) / 4) -
                Math.floor((year - 1901 + t) / 100) +
                Math.floor((year - 1601 + t) / 400) +
                365 * (year - 1970)
            );
        }

        function toUTC(t) {
            return Number(new NativeDate(1970, 0, 1, 0, 0, 0, t));
        }

        // Copy any custom methods a 3rd party library may have added
        for (var key in NativeDate) {
            Date[key] = NativeDate[key];
        }

        // Copy "native" methods explicitly; they may be non-enumerable
        Date.now = NativeDate.now;
        Date.UTC = NativeDate.UTC;
        Date.prototype = NativeDate.prototype;
        Date.prototype.constructor = Date;

        // Upgrade Date.parse to handle simplified ISO 8601 strings
        Date.parse = function parse(string) {
            var match = isoDateExpression.exec(string);
            if (match) {
                // parse months, days, hours, minutes, seconds, and milliseconds
                // provide default values if necessary
                // parse the UTC offset component
                var year = Number(match[1]),
                    month = Number(match[2] || 1) - 1,
                    day = Number(match[3] || 1) - 1,
                    hour = Number(match[4] || 0),
                    minute = Number(match[5] || 0),
                    second = Number(match[6] || 0),
                    millisecond = Math.floor(Number(match[7] || 0) * 1000),
                    // When time zone is missed, local offset should be used
                    // (ES 5.1 bug)
                    // see https://bugs.ecmascript.org/show_bug.cgi?id=112
                    isLocalTime = Boolean(match[4] && !match[8]),
                    signOffset = match[9] === '-' ? 1 : -1,
                    hourOffset = Number(match[10] || 0),
                    minuteOffset = Number(match[11] || 0),
                    result;
                if (
                    hour < (
                        minute > 0 || second > 0 || millisecond > 0 ?
                        24 : 25
                    ) &&
                    minute < 60 && second < 60 && millisecond < 1000 &&
                    month > -1 && month < 12 && hourOffset < 24 &&
                    minuteOffset < 60 && // detect invalid offsets
                    day > -1 &&
                    day < (
                        dayFromMonth(year, month + 1) -
                        dayFromMonth(year, month)
                    )
                ) {
                    result = (
                        (dayFromMonth(year, month) + day) * 24 +
                        hour +
                        hourOffset * signOffset
                    ) * 60;
                    result = (
                        (result + minute + minuteOffset * signOffset) * 60 +
                        second
                    ) * 1000 + millisecond;
                    if (isLocalTime) {
                        result = toUTC(result);
                    }
                    if (-8.64e15 <= result && result <= 8.64e15) {
                        return result;
                    }
                }
                return NaN;
            }
            return NativeDate.parse.apply(this, arguments);
        };

        return Date;
    }(Date));
    /*global Date: false */
}

// ES5 15.9.4.4
// http://es5.github.com/#x15.9.4.4
if (!Date.now) {
    Date.now = function now() {
        return new Date().getTime();
    };
}


//
// Number
// ======
//

// ES5.1 15.7.4.5
// http://es5.github.com/#x15.7.4.5
var hasToFixedBugs = NumberPrototype.toFixed && (
  (0.00008).toFixed(3) !== '0.000' ||
  (0.9).toFixed(0) !== '1' ||
  (1.255).toFixed(2) !== '1.25' ||
  (1000000000000000128).toFixed(0) !== '1000000000000000128'
);

var toFixedHelpers = {
  base: 1e7,
  size: 6,
  data: [0, 0, 0, 0, 0, 0],
  multiply: function multiply(n, c) {
      var i = -1;
      while (++i < toFixedHelpers.size) {
          c += n * toFixedHelpers.data[i];
          toFixedHelpers.data[i] = c % toFixedHelpers.base;
          c = Math.floor(c / toFixedHelpers.base);
      }
  },
  divide: function divide(n) {
      var i = toFixedHelpers.size, c = 0;
      while (--i >= 0) {
          c += toFixedHelpers.data[i];
          toFixedHelpers.data[i] = Math.floor(c / n);
          c = (c % n) * toFixedHelpers.base;
      }
  },
  numToString: function numToString() {
      var i = toFixedHelpers.size;
      var s = '';
      while (--i >= 0) {
          if (s !== '' || i === 0 || toFixedHelpers.data[i] !== 0) {
              var t = String(toFixedHelpers.data[i]);
              if (s === '') {
                  s = t;
              } else {
                  s += '0000000'.slice(0, 7 - t.length) + t;
              }
          }
      }
      return s;
  },
  pow: function pow(x, n, acc) {
      return (n === 0 ? acc : (n % 2 === 1 ? pow(x, n - 1, acc * x) : pow(x * x, n / 2, acc)));
  },
  log: function log(x) {
      var n = 0;
      while (x >= 4096) {
          n += 12;
          x /= 4096;
      }
      while (x >= 2) {
          n += 1;
          x /= 2;
      }
      return n;
  }
};

defineProperties(NumberPrototype, {
    toFixed: function toFixed(fractionDigits) {
        var f, x, s, m, e, z, j, k;

        // Test for NaN and round fractionDigits down
        f = Number(fractionDigits);
        f = f !== f ? 0 : Math.floor(f);

        if (f < 0 || f > 20) {
            throw new RangeError('Number.toFixed called with invalid number of decimals');
        }

        x = Number(this);

        // Test for NaN
        if (x !== x) {
            return 'NaN';
        }

        // If it is too big or small, return the string value of the number
        if (x <= -1e21 || x >= 1e21) {
            return String(x);
        }

        s = '';

        if (x < 0) {
            s = '-';
            x = -x;
        }

        m = '0';

        if (x > 1e-21) {
            // 1e-21 < x < 1e21
            // -70 < log2(x) < 70
            e = toFixedHelpers.log(x * toFixedHelpers.pow(2, 69, 1)) - 69;
            z = (e < 0 ? x * toFixedHelpers.pow(2, -e, 1) : x / toFixedHelpers.pow(2, e, 1));
            z *= 0x10000000000000; // Math.pow(2, 52);
            e = 52 - e;

            // -18 < e < 122
            // x = z / 2 ^ e
            if (e > 0) {
                toFixedHelpers.multiply(0, z);
                j = f;

                while (j >= 7) {
                    toFixedHelpers.multiply(1e7, 0);
                    j -= 7;
                }

                toFixedHelpers.multiply(toFixedHelpers.pow(10, j, 1), 0);
                j = e - 1;

                while (j >= 23) {
                    toFixedHelpers.divide(1 << 23);
                    j -= 23;
                }

                toFixedHelpers.divide(1 << j);
                toFixedHelpers.multiply(1, 1);
                toFixedHelpers.divide(2);
                m = toFixedHelpers.numToString();
            } else {
                toFixedHelpers.multiply(0, z);
                toFixedHelpers.multiply(1 << (-e), 0);
                m = toFixedHelpers.numToString() + '0.00000000000000000000'.slice(2, 2 + f);
            }
        }

        if (f > 0) {
            k = m.length;

            if (k <= f) {
                m = s + '0.0000000000000000000'.slice(0, f - k + 2) + m;
            } else {
                m = s + m.slice(0, k - f) + '.' + m.slice(k - f);
            }
        } else {
            m = s + m;
        }

        return m;
    }
}, hasToFixedBugs);


//
// String
// ======
//

// ES5 15.5.4.14
// http://es5.github.com/#x15.5.4.14

// [bugfix, IE lt 9, firefox 4, Konqueror, Opera, obscure browsers]
// Many browsers do not split properly with regular expressions or they
// do not perform the split correctly under obscure conditions.
// See http://blog.stevenlevithan.com/archives/cross-browser-split
// I've tested in many browsers and this seems to cover the deviant ones:
//    'ab'.split(/(?:ab)*/) should be ["", ""], not [""]
//    '.'.split(/(.?)(.?)/) should be ["", ".", "", ""], not ["", ""]
//    'tesst'.split(/(s)*/) should be ["t", undefined, "e", "s", "t"], not
//       [undefined, "t", undefined, "e", ...]
//    ''.split(/.?/) should be [], not [""]
//    '.'.split(/()()/) should be ["."], not ["", "", "."]

var string_split = StringPrototype.split;
if (
    'ab'.split(/(?:ab)*/).length !== 2 ||
    '.'.split(/(.?)(.?)/).length !== 4 ||
    'tesst'.split(/(s)*/)[1] === 't' ||
    'test'.split(/(?:)/, -1).length !== 4 ||
    ''.split(/.?/).length ||
    '.'.split(/()()/).length > 1
) {
    (function () {
        var compliantExecNpcg = typeof (/()??/).exec('')[1] === 'undefined'; // NPCG: nonparticipating capturing group

        StringPrototype.split = function (separator, limit) {
            var string = this;
            if (typeof separator === 'undefined' && limit === 0) {
                return [];
            }

            // If `separator` is not a regex, use native split
            if (to_string.call(separator) !== '[object RegExp]') {
                return string_split.call(this, separator, limit);
            }

            var output = [],
                flags = (separator.ignoreCase ? 'i' : '') +
                        (separator.multiline ? 'm' : '') +
                        (separator.extended ? 'x' : '') + // Proposed for ES6
                        (separator.sticky ? 'y' : ''), // Firefox 3+
                lastLastIndex = 0,
                // Make `global` and avoid `lastIndex` issues by working with a copy
                separator2, match, lastIndex, lastLength;
            separator = new RegExp(separator.source, flags + 'g');
            string += ''; // Type-convert
            if (!compliantExecNpcg) {
                // Doesn't need flags gy, but they don't hurt
                separator2 = new RegExp('^' + separator.source + '$(?!\\s)', flags);
            }
            /* Values for `limit`, per the spec:
             * If undefined: 4294967295 // Math.pow(2, 32) - 1
             * If 0, Infinity, or NaN: 0
             * If positive number: limit = Math.floor(limit); if (limit > 4294967295) limit -= 4294967296;
             * If negative number: 4294967296 - Math.floor(Math.abs(limit))
             * If other: Type-convert, then use the above rules
             */
            limit = typeof limit === 'undefined' ?
                -1 >>> 0 : // Math.pow(2, 32) - 1
                ES.ToUint32(limit);
            while (match = separator.exec(string)) {
                // `separator.lastIndex` is not reliable cross-browser
                lastIndex = match.index + match[0].length;
                if (lastIndex > lastLastIndex) {
                    output.push(string.slice(lastLastIndex, match.index));
                    // Fix browsers whose `exec` methods don't consistently return `undefined` for
                    // nonparticipating capturing groups
                    if (!compliantExecNpcg && match.length > 1) {
                        match[0].replace(separator2, function () {
                            for (var i = 1; i < arguments.length - 2; i++) {
                                if (typeof arguments[i] === 'undefined') {
                                    match[i] = void 0;
                                }
                            }
                        });
                    }
                    if (match.length > 1 && match.index < string.length) {
                        array_push.apply(output, match.slice(1));
                    }
                    lastLength = match[0].length;
                    lastLastIndex = lastIndex;
                    if (output.length >= limit) {
                        break;
                    }
                }
                if (separator.lastIndex === match.index) {
                    separator.lastIndex++; // Avoid an infinite loop
                }
            }
            if (lastLastIndex === string.length) {
                if (lastLength || !separator.test('')) {
                    output.push('');
                }
            } else {
                output.push(string.slice(lastLastIndex));
            }
            return output.length > limit ? output.slice(0, limit) : output;
        };
    }());

// [bugfix, chrome]
// If separator is undefined, then the result array contains just one String,
// which is the this value (converted to a String). If limit is not undefined,
// then the output array is truncated so that it contains no more than limit
// elements.
// "0".split(undefined, 0) -> []
} else if ('0'.split(void 0, 0).length) {
    StringPrototype.split = function split(separator, limit) {
        if (typeof separator === 'undefined' && limit === 0) { return []; }
        return string_split.call(this, separator, limit);
    };
}

var str_replace = StringPrototype.replace;
var replaceReportsGroupsCorrectly = (function () {
    var groups = [];
    'x'.replace(/x(.)?/g, function (match, group) {
        groups.push(group);
    });
    return groups.length === 1 && typeof groups[0] === 'undefined';
}());

if (!replaceReportsGroupsCorrectly) {
    StringPrototype.replace = function replace(searchValue, replaceValue) {
        var isFn = isFunction(replaceValue);
        var hasCapturingGroups = isRegex(searchValue) && (/\)[*?]/).test(searchValue.source);
        if (!isFn || !hasCapturingGroups) {
            return str_replace.call(this, searchValue, replaceValue);
        } else {
            var wrappedReplaceValue = function (match) {
                var length = arguments.length;
                var originalLastIndex = searchValue.lastIndex;
                searchValue.lastIndex = 0;
                var args = searchValue.exec(match) || [];
                searchValue.lastIndex = originalLastIndex;
                args.push(arguments[length - 2], arguments[length - 1]);
                return replaceValue.apply(this, args);
            };
            return str_replace.call(this, searchValue, wrappedReplaceValue);
        }
    };
}

// ECMA-262, 3rd B.2.3
// Not an ECMAScript standard, although ECMAScript 3rd Edition has a
// non-normative section suggesting uniform semantics and it should be
// normalized across all browsers
// [bugfix, IE lt 9] IE < 9 substr() with negative value not working in IE
var string_substr = StringPrototype.substr;
var hasNegativeSubstrBug = ''.substr && '0b'.substr(-1) !== 'b';
defineProperties(StringPrototype, {
    substr: function substr(start, length) {
        return string_substr.call(
            this,
            start < 0 ? ((start = this.length + start) < 0 ? 0 : start) : start,
            length
        );
    }
}, hasNegativeSubstrBug);

// ES5 15.5.4.20
// whitespace from: http://es5.github.io/#x15.5.4.20
var ws = '\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u180E\u2000\u2001\u2002\u2003' +
    '\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028' +
    '\u2029\uFEFF';
var zeroWidth = '\u200b';
var wsRegexChars = '[' + ws + ']';
var trimBeginRegexp = new RegExp('^' + wsRegexChars + wsRegexChars + '*');
var trimEndRegexp = new RegExp(wsRegexChars + wsRegexChars + '*$');
var hasTrimWhitespaceBug = StringPrototype.trim && (ws.trim() || !zeroWidth.trim());
defineProperties(StringPrototype, {
    // http://blog.stevenlevithan.com/archives/faster-trim-javascript
    // http://perfectionkills.com/whitespace-deviations/
    trim: function trim() {
        if (typeof this === 'undefined' || this === null) {
            throw new TypeError("can't convert " + this + ' to object');
        }
        return String(this).replace(trimBeginRegexp, '').replace(trimEndRegexp, '');
    }
}, hasTrimWhitespaceBug);

// ES-5 15.1.2.2
if (parseInt(ws + '08') !== 8 || parseInt(ws + '0x16') !== 22) {
    /*global parseInt: true */
    parseInt = (function (origParseInt) {
        var hexRegex = /^0[xX]/;
        return function parseIntES5(str, radix) {
            str = String(str).trim();
            if (!Number(radix)) {
                radix = hexRegex.test(str) ? 16 : 10;
            }
            return origParseInt(str, radix);
        };
    }(parseInt));
}

}));

},{}],4:[function(require,module,exports){
/* get back the (hopefully) exact input expression from the AST */

var R = require('ramda');
var parse = require('./parse');


var template = function(str, vals) {
  var valIdx = 0;
  return str.replace(/#/g, function() { return vals[valIdx++]; });
};


var _echo = function _echo(node) {
  return template(node.template, R.map(_echo, node.children));
};


var echo = R.pipe(parse, _echo);
echo.fromAST = _echo;
module.exports = echo;

},{"./parse":8,"ramda":7}],5:[function(require,module,exports){
var R = require('ramda');
var parse = require('./parse');


var transformers = {
  expr: function(node) {
    return { c: function(vals) { return '(' + vals[0] + ')'; },
             subs: node.children };
  },
  literal: function(node) {
    var str = '' + node.options.value;
    if (!R.contains('.', str)) {
      str += '.0';
    }
    return { c: function() { return str; },
             subs: [] };
  },
  name: function(node) {
    var key = node.options.key;
    if (R.prop(key, Math)) {
      return {
        c: function() {
          return 'Math.' + key;
        },
        subs: []
      };
    }
    return {
      c: function() {
        return 'symbols["' + key + '"]';
      },
      subs: []
    };
  },
  func: function(node) {
    var key = node.options.key;
    var narys = {
      product: '*',
      div: '/',
      mod: '%',
      sum: '+',
      minus: '-',
      lessThan: '<',
      greaterThan: '>'
    };
    if (narys[key]) {
      return {
        c: function(args) { return '(' + args.join(narys[key]) + ')'; },
        subs: node.children
      };
    }
    if (key === 'neg') {
      return {
        c: function(args) { return '(-' + args[0] + ')'; },
        subs: node.children
      };
    }
    if (R.prop(key, Math)) {
      return {
        c: function(args) { return 'Math.' + key + '(' + args.join(',') + ')'; },
        subs: node.children
      };
    }
    return { c: function(args) { return 'symbols["' + node.options.key + '"]' +
      '(' + args.join(',') + ')'; }, subs: node.children };
  }
};


var compileAST = function comp(ASTNode) {
  var transformer = transformers[ASTNode.node](ASTNode);
  return transformer.c(R.map(comp, transformer.subs));
};


var functionify = function(expr) {
  var templateFn = function(symbols, expr) {
    symbols = symbols || {};
    return expr;
  };
  var body = templateFn
    .toString()
    .split('\n')
    .slice(1, -1)  // drop function header and closing }
    .join('\n')
    .replace('expr', expr);
  /* jslint evil:true */
  return new Function('symbols', body);
  /* jslint evil:false */
};


var compile = R.pipe(parse, compileAST, functionify);
compile.fromAST = R.pipe(compileAST, functionify);
compile.express = R.pipe(parse, compileAST);
compile.express.fromAST = compileAST;

module.exports = compile;

},{"./parse":8,"ramda":7}],6:[function(require,module,exports){
var R = require('ramda');

var tokenMatches = [
  { type: 'space',    match: /^\s+/ },
  { type: 'literal',  match: /^(\d*\.\d+|\d+)/ },
  { type: 'name',     match: /^[a-zA-Z_]\w*/ },
  { type: 'paren',    match: /^[\(\)\[\]]/ },
  { type: 'operator', match: /^[\+\-%\*\/\^<>]/ }
];


var mkToken = function(token, value, repr) {
  return {
    type: 'token',
    token: token,
    value: value,
    repr: repr || value
  };
};


var chomp = function(str) {
  var matcher = R.find(R.where({ match: function(re) { return re.test(str); } }), tokenMatches);
  var token = matcher ?
    mkToken(matcher.type, str.match(matcher.match)[0]) :
    mkToken(null, str[0]);
  return { token: token, leftover: str.slice(token.value.length) };
};


var chompReduce = function(str) {
  function reducer(initial, leftover) {
    if (!leftover) { return initial; }  // nothing more to eat!
    var result = chomp(leftover);
    return reducer(R.append(result.token, initial), result.leftover);
  }
  return reducer([], str);
};


chompReduce.token = mkToken;

module.exports = chompReduce;

},{"ramda":7}],7:[function(require,module,exports){
//     ramda.js
//     https://github.com/ramda/ramda
//     (c) 2013-2014 Scott Sauyet and Michael Hurley
//     Ramda may be freely distributed under the MIT license.

// Ramda
// -----
// A practical functional library for Javascript programmers.  Ramda is a collection of tools to make it easier to
// use Javascript as a functional programming language.  (The name is just a silly play on `lambda`.)

// Basic Setup
// -----------
// Uses a technique from the [Universal Module Definition][umd] to wrap this up for use in Node.js or in the browser,
// with or without an AMD-style loader.
//
//  [umd]: https://github.com/umdjs/umd/blob/master/returnExports.js

(function(factory) {
    if (typeof exports === 'object') {
        module.exports = factory(this);
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        this.R = factory(this);
    }
}(function() {

    'use strict';

    // This object is what is actually returned, with all the exposed functions attached as properties.

    /**
     * A practical functional library for Javascript programmers.
     *
     * @namespace R
     */
    var R = {version: '0.8.0'};

    // Internal Functions and Properties
    // ---------------------------------

    /**
     * Creates an exception about calling a function with no arguments.
     *
     * @private
     * @category Internal
     * @return {TypeError} A no arguments exception.
     */
    function _noArgsException() {
        return new TypeError('Function called with no arguments');
    }

    /**
     * An optimized, private array `slice` implementation.
     *
     * @private
     * @category Internal
     * @param {Arguments|Array} args The array or arguments object to consider.
     * @param {Number} [from=0] The array index to slice from, inclusive.
     * @param {Number} [to=args.length] The array index to slice to, exclusive.
     * @return {Array} A new, sliced array.
     * @example
     *
     *      _slice([1, 2, 3, 4, 5], 1, 3); //=> [2, 3]
     *
     *      var firstThreeArgs = function(a, b, c, d) {
     *        return _slice(arguments, 0, 3);
     *      };
     *      firstThreeArgs(1, 2, 3, 4); //=> [1, 2, 3]
     */
    function _slice(args, from, to) {
        switch (arguments.length) {
            case 0: throw _noArgsException();
            case 1: return _slice(args, 0, args.length);
            case 2: return _slice(args, from, args.length);
            default:
                var length = Math.max(0, to - from), list = new Array(length), idx = -1;
                while (++idx < length) {
                    list[idx] = args[from + idx];
                }
                return list;
        }
    }


    /**
     * Private `concat` function to merge two array-like objects.
     *
     * @private
     * @category Internal
     * @param {Array|Arguments} [set1=[]] An array-like object.
     * @param {Array|Arguments} [set2=[]] An array-like object.
     * @return {Array} A new, merged array.
     * @example
     *
     *      _concat([4, 5, 6], [1, 2, 3]); //=> [4, 5, 6, 1, 2, 3]
     */
    function _concat(set1, set2) {
        set1 = set1 || [];
        set2 = set2 || [];
        var idx;
        var len1 = set1.length;
        var len2 = set2.length;
        var result = new Array(len1 + len2);

        idx = -1;
        while (++idx < len1) {
            result[idx] = set1[idx];
        }
        idx = -1;
        while (++idx < len2) {
            result[len1 + idx] = set2[idx];
        }
        return result;
    }


    // Private reference to toString function.
    var toString = Object.prototype.toString;


    /**
     * Tests whether or not an object is an array.
     *
     * @private
     * @category Internal
     * @param {*} val The object to test.
     * @return {Boolean} `true` if `val` is an array, `false` otherwise.
     * @example
     *
     *      _isArray([]); //=> true
     *      _isArray(null); //=> false
     *      _isArray({}); //=> false
     */
    var _isArray = Array.isArray || function isArray(val) {
        return val != null && val.length >= 0 && toString.call(val) === '[object Array]';
    };


    /**
     * Tests whether or not an object is similar to an array.
     *
     * @func
     * @memberOf R
     * @category Type
     * @category List
     * @param {*} x The object to test.
     * @return {Boolean} `true` if `x` has a numeric length property and extreme indices defined; `false` otherwise.
     * @example
     *
     *      R.isArrayLike([]); //=> true
     *      R.isArrayLike(true); //=> false
     *      R.isArrayLike({}); //=> false
     *      R.isArrayLike({length: 10}); //=> false
     *      R.isArrayLike({0: 'zero', 9: 'nine', length: 10}); //=> true
     */
    var isArrayLike = R.isArrayLike = function isArrayLike(x) {
        if (_isArray(x)) { return true; }
        if (!x) { return false; }
        if (typeof x !== 'object') { return false; }
        if (x instanceof String) { return false; }
        if (x.nodeType === 1) { return !!x.length; }
        if (x.length === 0) { return true; }
        if (x.length > 0) {
            return x.hasOwnProperty(0) && x.hasOwnProperty(x.length - 1);
        }
        return false;
    };


    /**
     * Optimized internal two-arity curry function.
     *
     * @private
     * @category Function
     * @param {Function} fn The function to curry.
     * @return {Function} curried function
     * @example
     *
     *      var addTwo = function(a, b) {
     *        return a + b;
     *      };
     *
     *      var curriedAddTwo = _curry2(addTwo);
     */
    function _curry2(fn) {
        return function(a, b) {
            switch (arguments.length) {
                case 0:
                    throw _noArgsException();
                case 1:
                    return function(b) {
                        return fn(a, b);
                    };
                default:
                    return fn(a, b);
            }
        };
    }


    /**
     * Optimized internal three-arity curry function.
     *
     * @private
     * @category Function
     * @param {Function} fn The function to curry.
     * @return {Function} curried function
     * @example
     *
     *      var addThree = function(a, b, c) {
     *        return a + b + c;
     *      };
     *
     *      var curriedAddThree = _curry3(addThree);
     */
    function _curry3(fn) {
        return function(a, b, c) {
            switch (arguments.length) {
                case 0:
                    throw _noArgsException();
                case 1:
                    return _curry2(function(b, c) {
                        return fn(a, b, c);
                    });
                case 2:
                    return function(c) {
                        return fn(a, b, c);
                    };
                default:
                    return fn(a, b, c);
            }
        };
    }

    var __;  // This is intentionally left `undefined`.
    try {
        Object.defineProperty(R, '__', {writable: false, value: __});
    } catch (e) {
        R.__ = __;
    }

    /**
     * Uses a placeholder to convert a binary function into something like an infix operation.
     * When called with an `undefined` placeholder (e.g. `R.__`) the second argument is applied to the
     * second position, and it returns a function waiting for its first argument.
     * This can allow for more natural processing of functions which are really binary operators.
     *
     * @func
     * @memberOf R
     * @category Function
     * @param {Function} fn The binary operation to adjust
     * @return {Function} A new function that acts somewhat like an infix operator.
     * @example
     *
     *      var div = R.op(function (a, b) {
     *          return a / b;
     *      });
     *
     *      div(6, 3); //=> 2
     *      div(6)(3); //=> 2
     *      div(__, 3)(6); //=> 2 // note: `__` here is just an `undefined` value.  You could use `void 0` instead
     *      div(__)(3, 6); //=> 2
     *      div(__)(3)(6); //=> 2
     */
    var op = R.op = function op(fn) {
        var length = fn.length;
        if (length !== 2) {throw new Error('Expected binary function.');}

        return function _op(a, b) {
            switch (arguments.length) {
                case 0: throw _noArgsException();
                case 1: return a === __ ? binary(flip(_op)) : unary(lPartial(fn, a));
                default: return a === __ ? unary(rPartial(fn, b)) : fn(a, b);
            }
        };
    };


    /**
     * Creates a new version of `fn` with given arity that, when invoked,
     * will return either:
     * - A new function ready to accept one or more of `fn`'s remaining arguments, if all of
     * `fn`'s expected arguments have not yet been provided
     * - `fn`'s result if all of its expected arguments have been provided
     *
     * This function is useful in place of `curry`, when the arity of the
     * function to curry cannot be determined from its signature, e.g. if it's
     * a variadic function.
     *
     * @func
     * @memberOf R
     * @category core
     * @category Function
     * @sig Number -> (* -> a) -> (* -> a)
     * @param {Number} fnArity The arity for the returned function.
     * @param {Function} fn The function to curry.
     * @return {Function} A new, curried function.
     * @see R.curry
     * @example
     *
     *      var addFourNumbers = function() {
     *        return R.sum([].slice.call(arguments, 0, 4));
     *      };
     *
     *      var curriedAddFourNumbers = R.curryN(4, addFourNumbers);
     *      var f = curriedAddFourNumbers(1, 2);
     *      var g = f(3);
     *      g(4);//=> 10
     */
    var curryN = R.curryN = function curryN(length, fn) {
        return (function recurry(args) {
            return arity(Math.max(length - (args && args.length || 0), 0), function() {
                if (arguments.length === 0) { throw _noArgsException(); }
                var newArgs = _concat(args, arguments);
                if (newArgs.length >= length) {
                    return fn.apply(this, newArgs);
                } else {
                    return recurry(newArgs);
                }
            });
        }([]));
    };


    /**
     * Creates a new version of `fn` that, when invoked, will return either:
     * - A new function ready to accept one or more of `fn`'s remaining arguments, if all of
     * `fn`'s expected arguments have not yet been provided
     * - `fn`'s result if all of its expected arguments have been provided
     *
     * @func
     * @memberOf R
     * @category core
     * @category Function
     * @sig (* -> a) -> (* -> a)
     * @param {Function} fn The function to curry.
     * @return {Function} A new, curried function.
     * @see R.curryN
     * @example
     *
     *      var addFourNumbers = function(a, b, c, d) {
     *        return a + b + c + d;
     *      };
     *
     *      var curriedAddFourNumbers = R.curry(addFourNumbers);
     *      var f = curriedAddFourNumbers(1, 2);
     *      var g = f(3);
     *      g(4);//=> 10
     */
    var curry = R.curry = function curry(fn) {
        return curryN(fn.length, fn);
    };


    /**
     * Returns a new function much like the supplied one, except that the first two arguments'
     * order is reversed.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a -> b -> c -> ... -> z) -> (b -> a -> c -> ... -> z)
     * @param {Function} fn The function to invoke with its first two parameters reversed.
     * @return {*} The result of invoking `fn` with its first two parameters' order reversed.
     * @example
     *
     *      var mergeThree = function(a, b, c) {
     *        return ([]).concat(a, b, c);
     *      };
     *
     *      mergeThree(1, 2, 3); //=> [1, 2, 3]
     *
     *      R.flip(mergeThree)(1, 2, 3); //=> [2, 1, 3]
     */
    var flip = R.flip = function flip(fn) {
        return function(a, b) {
            switch (arguments.length) {
                case 0: throw _noArgsException();
                case 1: return function(b) { return fn.apply(this, [b, a].concat(_slice(arguments, 1))); };
                default: return fn.apply(this, _concat([b, a], _slice(arguments, 2)));
            }
        };
    };


    /**
     * Private function that determines whether or not a provided object has a given method.
     * Does not ignore methods stored on the object's prototype chain. Used for dynamically
     * dispatching Ramda methods to non-Array objects.
     *
     * @private
     * @category Internal
     * @param {String} methodName The name of the method to check for.
     * @param {Object} obj The object to test.
     * @return {Boolean} `true` has a given method, `false` otherwise.
     * @example
     *
     *      var person = { name: 'John' };
     *      person.shout = function() { alert(this.name); };
     *
     *      _hasMethod('shout', person); //=> true
     *      _hasMethod('foo', person); //=> false
     */
    function _hasMethod(methodName, obj) {
        return obj != null && !_isArray(obj) && typeof obj[methodName] === 'function';
    }


    /**
     * Similar to hasMethod, this checks whether a function has a [methodname]
     * function. If it isn't an array it will execute that function otherwise it will
     * default to the ramda implementation.
     *
     * @private
     * @category Internal
     * @param {Function} fn ramda implemtation
     * @param {String} methodname property to check for a custom implementation
     * @return {Object} whatever the return value of the method is
     */
    function _checkForMethod(methodname, fn) {
        return function(a, b, c) {
            var length = arguments.length;
            var obj = arguments[length - 1],
                callBound = obj && !_isArray(obj) && typeof obj[methodname] === 'function';
            switch (arguments.length) {
                case 0: return fn();
                case 1: return callBound ? obj[methodname]() : fn(a);
                case 2: return callBound ? obj[methodname](a) : fn(a, b);
                case 3: return callBound ? obj[methodname](a, b) : fn(a, b, c);
            }
        };
    }


    /**
     * Wraps a function of any arity (including nullary) in a function that accepts exactly `n`
     * parameters. Any extraneous parameters will not be passed to the supplied function.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig Number -> (* -> a) -> (* -> a)
     * @param {Number} n The desired arity of the new function.
     * @param {Function} fn The function to wrap.
     * @return {Function} A new function wrapping `fn`. The new function is guaranteed to be of
     *         arity `n`.
     * @example
     *
     *      var takesTwoArgs = function(a, b) {
     *        return [a, b];
     *      };
     *      takesTwoArgs.length; //=> 2
     *      takesTwoArgs(1, 2); //=> [1, 2]
     *
     *      var takesOneArg = R.nAry(1, takesTwoArgs);
     *      takesOneArg.length; //=> 1
     *      // Only `n` arguments are passed to the wrapped function
     *      takesOneArg(1, 2); //=> [1, undefined]
     */
    var nAry = R.nAry = function(n, fn) {
        switch (n) {
            case 0: return function() {return fn.call(this);};
            case 1: return function(a0) {return fn.call(this, a0);};
            case 2: return function(a0, a1) {return fn.call(this, a0, a1);};
            case 3: return function(a0, a1, a2) {return fn.call(this, a0, a1, a2);};
            case 4: return function(a0, a1, a2, a3) {return fn.call(this, a0, a1, a2, a3);};
            case 5: return function(a0, a1, a2, a3, a4) {return fn.call(this, a0, a1, a2, a3, a4);};
            case 6: return function(a0, a1, a2, a3, a4, a5) {return fn.call(this, a0, a1, a2, a3, a4, a5);};
            case 7: return function(a0, a1, a2, a3, a4, a5, a6) {return fn.call(this, a0, a1, a2, a3, a4, a5, a6);};
            case 8: return function(a0, a1, a2, a3, a4, a5, a6, a7) {return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7);};
            case 9: return function(a0, a1, a2, a3, a4, a5, a6, a7, a8) {return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7, a8);};
            case 10: return function(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {return fn.call(this, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);};
            default: return fn; // TODO: or throw?
        }
    };


    /**
     * Wraps a function of any arity (including nullary) in a function that accepts exactly 1
     * parameter. Any extraneous parameters will not be passed to the supplied function.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (* -> b) -> (a -> b)
     * @param {Function} fn The function to wrap.
     * @return {Function} A new function wrapping `fn`. The new function is guaranteed to be of
     *         arity 1.
     * @example
     *
     *      var takesTwoArgs = function(a, b) {
     *        return [a, b];
     *      };
     *      takesTwoArgs.length; //=> 2
     *      takesTwoArgs(1, 2); //=> [1, 2]
     *
     *      var takesOneArg = R.unary(takesTwoArgs);
     *      takesOneArg.length; //=> 1
     *      // Only 1 argument is passed to the wrapped function
     *      takesOneArg(1, 2); //=> [1, undefined]
     */
    var unary = R.unary = function unary(fn) {
        return nAry(1, fn);
    };


    /**
     * Wraps a function of any arity (including nullary) in a function that accepts exactly 2
     * parameters. Any extraneous parameters will not be passed to the supplied function.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (* -> c) -> (a, b -> c)
     * @param {Function} fn The function to wrap.
     * @return {Function} A new function wrapping `fn`. The new function is guaranteed to be of
     *         arity 2.
     * @example
     *
     *      var takesThreeArgs = function(a, b, c) {
     *        return [a, b, c];
     *      };
     *      takesThreeArgs.length; //=> 3
     *      takesThreeArgs(1, 2, 3); //=> [1, 2, 3]
     *
     *      var takesTwoArgs = R.binary(takesThreeArgs);
     *      takesTwoArgs.length; //=> 2
     *      // Only 2 arguments are passed to the wrapped function
     *      takesTwoArgs(1, 2, 3); //=> [1, 2, undefined]
     */
    var binary = R.binary = function binary(fn) {
        return nAry(2, fn);
    };


    /**
     * Wraps a function of any arity (including nullary) in a function that accepts exactly `n`
     * parameters. Unlike `nAry`, which passes only `n` arguments to the wrapped function,
     * functions produced by `arity` will pass all provided arguments to the wrapped function.
     *
     * @func
     * @memberOf R
     * @sig (Number, (* -> *)) -> (* -> *)
     * @category Function
     * @param {Number} n The desired arity of the returned function.
     * @param {Function} fn The function to wrap.
     * @return {Function} A new function wrapping `fn`. The new function is
     *         guaranteed to be of arity `n`.
     * @example
     *
     *      var takesTwoArgs = function(a, b) {
     *        return [a, b];
     *      };
     *      takesTwoArgs.length; //=> 2
     *      takesTwoArgs(1, 2); //=> [1, 2]
     *
     *      var takesOneArg = R.arity(1, takesTwoArgs);
     *      takesOneArg.length; //=> 1
     *      // All arguments are passed through to the wrapped function
     *      takesOneArg(1, 2); //=> [1, 2]
     */
    var arity = R.arity = function(n, fn) {
        switch (n) {
            case 0: return function() {return fn.apply(this, arguments);};
            case 1: return function(a0) {void a0; return fn.apply(this, arguments);};
            case 2: return function(a0, a1) {void a1; return fn.apply(this, arguments);};
            case 3: return function(a0, a1, a2) {void a2; return fn.apply(this, arguments);};
            case 4: return function(a0, a1, a2, a3) {void a3; return fn.apply(this, arguments);};
            case 5: return function(a0, a1, a2, a3, a4) {void a4; return fn.apply(this, arguments);};
            case 6: return function(a0, a1, a2, a3, a4, a5) {void a5; return fn.apply(this, arguments);};
            case 7: return function(a0, a1, a2, a3, a4, a5, a6) {void a6; return fn.apply(this, arguments);};
            case 8: return function(a0, a1, a2, a3, a4, a5, a6, a7) {void a7; return fn.apply(this, arguments);};
            case 9: return function(a0, a1, a2, a3, a4, a5, a6, a7, a8) {void a8; return fn.apply(this, arguments);};
            case 10: return function(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {void a9; return fn.apply(this, arguments);};
            default: return fn; // TODO: or throw?
        }
    };


    /**
     * Turns a named method with a specified arity into a function
     * that can be called directly supplied with arguments and a target object.
     *
     * The returned function is curried and accepts `len + 1` parameters where
     * the final parameter is the target object.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (Number, String) -> (a... -> c -> b)
     * @param {Number} len Number of arguments the returned function should take
     *        before the target object.
     * @param {Function} method Name of the method to call.
     * @return {Function} A new curried function.
     * @example
     *
     *      var sliceFrom = R.invokerN(1, 'slice');
     *      sliceFrom(6, 'abcdefghijklm'); //=> 'ghijklm'
     *      var sliceFrom6 = R.invokerN(2, 'slice', 6);
     *      sliceFrom6(8, 'abcdefghijklm'); //=> 'gh'
     */
    var invokerN = R.invokerN = function invokerN(arity, method) {
        var initialArgs = _slice(arguments, 2);
        var len = arity - initialArgs.length;
        return curryN(len + 1, function() {
            var target = arguments[len];
            var args = initialArgs.concat(_slice(arguments, 0, len));
            return target[method].apply(target, args);
        });
    };


    /**
     * Accepts a function `fn` and any number of transformer functions and returns a new
     * function. When the new function is invoked, it calls the function `fn` with parameters
     * consisting of the result of calling each supplied handler on successive arguments to the
     * new function. For example:
     *
     * ```javascript
     *
     *   var between = R.useWith(R.and,R.lt,R.gt)
     *
     *   //This invocation
     *   var isTeen = between(12,20)
     *
     *   //Is functionally equivalent to:
     *   var isTeen = R.and(R.gt(12), R.lt(20))
     *
     *   isTeen(13) //=> true
     *   isTeen(45) //=> false
     *
     * ```
     *
     * If more arguments are passed to the returned function than transformer functions, those
     * arguments are passed directly to `fn` as additional parameters. If you expect additional
     * arguments that don't need to be transformed, although you can ignore them, it's best to
     * pass an identity function so that the new function reports the correct arity.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig ((* -> *), (* -> *)...) -> (* -> *)
     * @param {Function} fn The function to wrap.
     * @param {...Function} transformers A variable number of transformer functions
     * @return {Function} The wrapped function.
     * @example
     *
     *      var double = function(y) { return y * 2; };
     *      var square = function(x) { return x * x; };
     *      var add = function(a, b) { return a + b; };
     *      // Adds any number of arguments together
     *      var addAll = function() {
     *        return R.reduce(add, 0, arguments);
     *      };
     *
     *      // Basic example
     *      var addDoubleAndSquare = R.useWith(addAll, double, square);
     *
     *      //≅ addAll(double(10), square(5));
     *      addDoubleAndSquare(10, 5); //=> 45
     *
     *      // Example of passing more arguments than transformers
     *      //≅ addAll(double(10), square(5), 100);
     *      addDoubleAndSquare(10, 5, 100); //=> 145
     *
     *      // But if you're expecting additional arguments that don't need transformation, it's best
     *      // to pass transformer functions so the resulting function has the correct arity
     *      var addDoubleAndSquareWithExtraParams = R.useWith(addAll, double, square, R.identity);
     *      //≅ addAll(double(10), square(5), R.identity(100));
     *      addDoubleAndSquare(10, 5, 100); //=> 145
     */
    var useWith = R.useWith = function useWith(fn /*, transformers */) {
        var transformers = _slice(arguments, 1);
        var tlen = transformers.length;
        return curry(arity(tlen, function() {
            var args = [], idx = -1;
            while (++idx < tlen) {
                args.push(transformers[idx](arguments[idx]));
            }
            return fn.apply(this, args.concat(_slice(arguments, tlen)));
        }));
    };


    /**
     * Iterate over an input `list`, calling a provided function `fn` for each element in the
     * list.
     *
     * `fn` receives one argument: *(value)*.
     *
     * Note: `R.forEach` does not skip deleted or unassigned indices (sparse arrays), unlike
     * the native `Array.prototype.forEach` method. For more details on this behavior, see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach#Description
     *
     * Also note that, unlike `Array.prototype.forEach`, Ramda's `forEach` returns the original
     * array. In some libraries this function is named `each`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> *) -> [a] -> [a]
     * @param {Function} fn The function to invoke. Receives one argument, `value`.
     * @param {Array} list The list to iterate over.
     * @return {Array} The original list.
     * @example
     *
     *      var printXPlusFive = function(x) { console.log(x + 5); };
     *      R.forEach(printXPlusFive, [1, 2, 3]); //=> [1, 2, 3]
     *      //-> 6
     *      //-> 7
     *      //-> 8
     */
    function forEach(fn, list) {
        var idx = -1, len = list.length;
        while (++idx < len) {
            fn(list[idx]);
        }
        // i can't bear not to return *something*
        return list;
    }
    R.forEach = _curry2(forEach);


    /**
     * Like `forEach`, but but passes additional parameters to the predicate function.
     *
     * `fn` receives three arguments: *(value, index, list)*.
     *
     * Note: `R.forEach.idx` does not skip deleted or unassigned indices (sparse arrays),
     * unlike the native `Array.prototype.forEach` method. For more details on this behavior,
     * see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach#Description
     *
     * Also note that, unlike `Array.prototype.forEach`, Ramda's `forEach` returns the original
     * array. In some libraries this function is named `each`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a, i, [a] -> ) -> [a] -> [a]
     * @param {Function} fn The function to invoke. Receives three arguments:
     *        (`value`, `index`, `list`).
     * @param {Array} list The list to iterate over.
     * @return {Array} The original list.
     * @alias forEach.idx
     * @example
     *
     *      // Note that having access to the original `list` allows for
     *      // mutation. While you *can* do this, it's very un-functional behavior:
     *      var plusFive = function(num, idx, list) { list[idx] = num + 5 };
     *      R.forEach.idx(plusFive, [1, 2, 3]); //=> [6, 7, 8]
     */
    R.forEach.idx = _curry2(function forEachIdx(fn, list) {
        var idx = -1, len = list.length;
        while (++idx < len) {
            fn(list[idx], idx, list);
        }
        // i can't bear not to return *something*
        return list;
    });


    /**
     * Creates a shallow copy of an array.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> [a]
     * @param {Array} list The list to clone.
     * @return {Array} A new copy of the original list.
     * @example
     *
     *      var numbers = [1, 2, 3];
     *      var numbersClone = R.clone(numbers); //=> [1, 2, 3]
     *      numbers === numbersClone; //=> false
     *
     *      // Note that this is a shallow clone--it does not clone complex values:
     *      var objects = [{}, {}, {}];
     *      var objectsClone = R.clone(objects);
     *      objects[0] === objectsClone[0]; //=> true
     */
    var clone = R.clone = function clone(list) {
        return _slice(list);
    };


    /**
     * Creates a deep copy of the value which may contain (nested) `Array`s and
     * `Object`s, `Number`s, `String`s, `Boolean`s and `Date`s. `Function`s are
     * not copied, but assigned by their reference.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {*} -> {*}
     * @param {*} value The object or array to clone
     * @returns {*} A new object or array
     * @example
     *
     *      var objects = [{}, {}, {}];
     *      var objectsClone = R.cloneDeep(objects);
     *      objects[0] === objectsClone[0]; //=> false
     *
     */
    R.cloneDeep = function cloneDeep(value) {
        return _baseCopy(value, [], []);
    };

    /**
     * Private `_baseCopy` function dispatches value copying to the `_copyObj`
     * function or creates a copy itself.
     *
     * @private
     * @category Internal
     * @param {*} value The value to be copied
     * @param {Array} refFrom Array containing the source references
     * @param {Array} refTo Array containing the copied source references
     * @return {*} The copied value.
     */
    function _baseCopy(value, refFrom, refTo) {
        switch (value && toString.call(value)) {
            case '[object Object]':   return _copyObj(value, {}, refFrom, refTo);
            case '[object Array]':    return _copyObj(value, [], refFrom, refTo);
            case '[object Function]': return value;
            case '[object Date]':     return new Date(value);
            default:
                return value;
        }
    }

    /**
     * Private `_copyObj` function creates a copy of the object or array provided by
     * the `_baseCopy` function.
     * Circular or duplicate references are detected using the source references in
     * refFrom and used to create the same circular or duplicate reference in the copy.
     *
     * @private
     * @category Internal
     * @param {*} value The value to be copied
     * @param {*} copiedValue Empty object or array or aid copying
     * @param {Array} refFrom Array containing the source references
     * @param {Array} refTo Array containing the copied source references
     * @return {*} The copied value.
     */
    function _copyObj(value, copiedValue, refFrom, refTo) {
        var len = refFrom.length;
        var idx = -1;
        while (++idx < len) {
            if (value === refFrom[idx]) {
                return refTo[idx];
            }
        }

        refFrom.push(value);
        refTo.push(copiedValue);
        for (var key in value) {
            copiedValue[key] = _baseCopy(value[key], refFrom, refTo);
        }
        return copiedValue;
    }


    // Core Functions
    // --------------
    //


    /**
     * Reports whether a value is "empty".
     * Empty values are null, undefined, "", and every object with a length
     * property whose value is 0 (such as an empty array).
     *
     * @func
     * @memberOf R
     * @category Core
     * @sig * -> Boolean
     * @param {*} val
     * @return {Boolean}
     * @example
     *
     *      R.isEmpty([1, 2, 3]); //=> false
     *      R.isEmpty([]); //=> true
     *      R.isEmpty(''); //=> true
     *      R.isEmpty(null); //=> true
     */
    var isEmpty = R.isEmpty = function isEmpty(val) {
        return val == null || val.length === 0;
    };


    function _prepend(el, list) {
        return _concat([el], list);
    }

    /**
     * Returns a new list with the given element at the front, followed by the contents of the
     * list.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig a -> [a] -> [a]
     * @param {*} el The item to add to the head of the output list.
     * @param {Array} list The array to add to the tail of the output list.
     * @return {Array} A new array.
     * @example
     *
     *      R.prepend('fee', ['fi', 'fo', 'fum']); //=> ['fee', 'fi', 'fo', 'fum']
     */
    var prepend = R.prepend = _curry2(_prepend);

    /**
     * @func
     * @memberOf R
     * @category List
     * @see R.prepend
     */
    R.cons = prepend;


    /**
     * Flipped version of R.prepend.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> a -> [a]
     * @param {Array} list
     * @param {*} el
     * @return {Array}
     * @example
     *
     *      R.prependTo(['fi', 'fo', 'fum'], 'fee'); //=> ['fee', 'fi', 'fo', 'fum']
     */
    R.prependTo = flip(_prepend);


    /**
     * Returns the nth element in a list.
     * If n is negative the element at index length + n is returned.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> a
     * @param {Number} idx
     * @param {Array} list
     * @return {*} The nth element of the list.
     * @example
     *
     *      var list = ['foo', 'bar', 'baz', 'quux'];
     *      R.nth(1, list); //=> 'bar'
     *      R.nth(-1, list); //=> 'quux'
     *      R.nth(-99, list); //=> undefined
     */
    var nth = R.nth = _curry2(function nth(n, list) {
        return n < 0 ? list[list.length + n] : list[n];
    });


    /**
     * Returns the first element in a list.
     * In some libraries this function is named `first`.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> a
     * @param {Array} [list=[]] The array to consider.
     * @return {*} The first element of the list, or `undefined` if the list is empty.
     * @example
     *
     *      R.head(['fi', 'fo', 'fum']); //=> 'fi'
     */
    var head = R.head = nth(0);

    /**
     * @func
     * @memberOf R
     * @category List
     * @see R.head
     */
    R.car = head;


    /**
     * Returns the last element from a list.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> a
     * @param {Array} [list=[]] The array to consider.
     * @return {*} The last element of the list, or `undefined` if the list is empty.
     * @example
     *
     *      R.last(['fi', 'fo', 'fum']); //=> 'fum'
     */
    R.last = nth(-1);


    /**
     * Returns all but the first element of a list. If the list provided has the `tail` method,
     * it will instead return `list.tail()`.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> [a]
     * @param {Array} [list=[]] The array to consider.
     * @return {Array} A new array containing all but the first element of the input list, or an
     *         empty list if the input list is a falsy value (e.g. `undefined`).
     * @example
     *
     *      R.tail(['fi', 'fo', 'fum']); //=> ['fo', 'fum']
     */
    var tail = R.tail = _checkForMethod('tail', function(list) {
        return _slice(list, 1);
    });

    /**
     * @func
     * @memberOf R
     * @category List
     * @see R.tail
     */
    R.cdr = tail;


    function _append(el, list) {
        return _concat(list, [el]);
    }

    /**
     * Returns a new list containing the contents of the given list, followed by the given
     * element.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig a -> [a] -> [a]
     * @param {*} el The element to add to the end of the new list.
     * @param {Array} list The list whose contents will be added to the beginning of the output
     *        list.
     * @return {Array} A new list containing the contents of the old list followed by `el`.
     * @example
     *
     *      R.append('tests', ['write', 'more']); //=> ['write', 'more', 'tests']
     *      R.append('tests', []); //=> ['tests']
     *      R.append(['tests'], ['write', 'more']); //=> ['write', 'more', ['tests']]
     */
    var append = R.append = _curry2(_append);

    /**
     * @func
     * @memberOf R
     * @category List
     * @see R.append
     */
    R.push = append;


    /**
     * Flipped version of R.append.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> a -> [a]
     * @param {Array} list
     * @param {*} el
     * @return {Array}
     * @example
     *
     *      R.appendTo([], 1); //=> [1]
     *      R.appendTo([1, 2, 3], 4); //=> [1, 2, 3, 4]
     *      R.appendTo([1, 2, 3], [4, 5, 6]); //=> [1, 2, 3, [4, 5, 6]]
     */
    R.appendTo = flip(_append);


    /**
     * Returns a new list consisting of the elements of the first list followed by the elements
     * of the second.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig [a] -> [a] -> [a]
     * @param {Array} list1 The first list to merge.
     * @param {Array} list2 The second set to merge.
     * @return {Array} A new array consisting of the contents of `list1` followed by the
     *         contents of `list2`. If, instead of an Array for `list1`, you pass an
     *         object with a `concat` method on it, `concat` will call `list1.concat`
     *         and pass it the value of `list2`.
     * @example
     *
     *      R.concat([], []); //=> []
     *      R.concat([4, 5, 6], [1, 2, 3]); //=> [4, 5, 6, 1, 2, 3]
     *      R.concat('ABC', 'DEF'); // 'ABCDEF'
     */
    R.concat = _curry2(function(set1, set2) {
        if (_isArray(set2)) {
            return _concat(set1, set2);
        } else if (_hasMethod('concat', set1)) {
            return set1.concat(set2);
        } else {
            throw new TypeError("can't concat " + typeof set1);
        }
    });


    /**
     * A function that does nothing but return the parameter supplied to it. Good as a default
     * or placeholder function.
     *
     * @func
     * @memberOf R
     * @category Core
     * @sig a -> a
     * @param {*} x The value to return.
     * @return {*} The input value, `x`.
     * @example
     *
     *      R.identity(1); //=> 1
     *
     *      var obj = {};
     *      R.identity(obj) === obj; //=> true
     */
    var identity = R.identity = function identity(x) {
        return x;
    };

    /**
     * @func
     * @memberOf R
     * @category Core
     * @see R.identity
     */
    R.I = identity;


    /**
     * Returns a function which returns its nth argument.
     *
     * @func
     * @memberOf R
     * @category Core
     * @sig Number -> *... -> *
     * @param {Number} n
     * @return {Function}
     * @example
     *
     *      R.argN(1)('a', 'b', 'c'); //=> 'b'
     */
    R.argN = function argN(n) {
        return function() {
            return arguments[n];
        };
    };


    /**
     * Calls an input function `n` times, returning an array containing the results of those
     * function calls.
     *
     * `fn` is passed one argument: The current value of `n`, which begins at `0` and is
     * gradually incremented to `n - 1`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (i -> a) -> i -> [a]
     * @param {Function} fn The function to invoke. Passed one argument, the current value of `n`.
     * @param {Number} n A value between `0` and `n - 1`. Increments after each function call.
     * @return {Array} An array containing the return values of all calls to `fn`.
     * @example
     *
     *      R.times(R.identity, 5); //=> [0, 1, 2, 3, 4]
     */
    var times = R.times = _curry2(function times(fn, n) {
        var list = new Array(n);
        var idx = -1;
        while (++idx < n) {
            list[idx] = fn(idx);
        }
        return list;
    });


    /**
     * Returns a fixed list of size `n` containing a specified identical value.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> n -> [a]
     * @param {*} value The value to repeat.
     * @param {Number} n The desired size of the output list.
     * @return {Array} A new array containing `n` `value`s.
     * @example
     *
     *      R.repeatN('hi', 5); //=> ['hi', 'hi', 'hi', 'hi', 'hi']
     *
     *      var obj = {};
     *      var repeatedObjs = R.repeatN(obj, 5); //=> [{}, {}, {}, {}, {}]
     *      repeatedObjs[0] === repeatedObjs[1]; //=> true
     */
    R.repeatN = _curry2(function repeatN(value, n) {
        return times(always(value), n);
    });



    // Function functions :-)
    // ----------------------
    //
    // These functions make new functions out of old ones.

    // --------

    /**
     * Applies function `fn` to the argument list `args`. This is useful for
     * creating a fixed-arity function from a variadic function. `fn` should
     * be a bound function if context is significant.
     *
     * @func
     * @memberOf R
     * @category core
     * @category Function
     * @sig (*... -> a) -> [*] -> a
     * @param {Function} fn
     * @param {Array} args
     * @return {*}
     * @example
     *
     *      var nums = [1, 2, 3, -99, 42, 6, 7];
     *      R.apply(Math.max, nums); //=> 42
     */
    R.apply = _curry2(function apply(fn, args) {
        return fn.apply(this, args);
    });


    /**
     * Takes a function `fn`, which takes a single array argument, and returns
     * a function which:
     *
     *   - takes any number of positional arguments;
     *   - passes these arguments to `fn` as an array; and
     *   - returns the result.
     *
     * In other words, R.unapply derives a variadic function from a function
     * which takes an array. R.unapply is the inverse of R.apply.
     *
     * @func
     * @memberOf R
     * @category core
     * @category Function
     * @sig ([*...] -> a) -> (*... -> a)
     * @param {Function} fn
     * @return {Function}
     * @see R.apply
     * @example
     *
     *      R.unapply(JSON.stringify)(1, 2, 3); //=> '[1,2,3]'
     */
    R.unapply = function unapply(fn) {
        if (arguments.length === 0) {
            throw _noArgsException();
        }
        return function() {
            return fn(_slice(arguments));
        };
    };


    /**
     * Basic, right-associative composition function. Accepts two functions and returns the
     * composite function; this composite function represents the operation `var h = f(g(x))`,
     * where `f` is the first argument, `g` is the second argument, and `x` is whatever
     * argument(s) are passed to `h`.
     *
     * This function's main use is to build the more general `compose` function, which accepts
     * any number of functions.
     *
     * @private
     * @category Function
     * @param {Function} f A function.
     * @param {Function} g A function.
     * @return {Function} A new function that is the equivalent of `f(g(x))`.
     * @example
     *
     *      var double = function(x) { return x * 2; };
     *      var square = function(x) { return x * x; };
     *      var squareThenDouble = _compose(double, square);
     *
     *      squareThenDouble(5); //≅ double(square(5)) => 50
     */
    function _compose(f, g) {
        return function() {
            return f.call(this, g.apply(this, arguments));
        };
    }


    /**
     * A right-associative two-argument composition function like `_compose`
     * but with automatic handling of promises (or, more precisely,
     * "thennables"). This function is used to construct a more general
     * `pCompose` function, which accepts any number of arguments.
     *
     * @private
     * @category Function
     * @param {Function} f A function.
     * @param {Function} g A function.
     * @return {Function} A new function that is the equivalent of `f(g(x))`.
     * @example
     *
     *      var Q = require('q');
     *      var double = function(x) { return x * 2; };
     *      var squareAsync = function(x) { return Q.when(x * x); };
     *      var squareAsyncThenDouble = _pCompose(double, squareAsync);
     *
     *      squareAsyncThenDouble(5)
     *          .then(function(result) {
     *            // the result is now 50.
     *          });
     */
    function _pCompose(f, g) {
        return function() {
            var context = this;
            var value = g.apply(this, arguments);
            if (_isThennable(value)) {
                return value.then(function(result) {
                    return f.call(context, result);
                });
            } else {
                return f.call(this, value);
            }
        };
    }


    /**
     * Tests if a value is a thennable (promise).
     */
    function _isThennable(value) {
        return (value != null) && (value === Object(value)) && value.then &&
            typeof value.then === 'function';
    }


    /*
     * Returns a function that makes a multi-argument version of compose from
     * either _compose or _pCompose.
     */
    function _createComposer(composeFunction) {
        return function() {
            switch (arguments.length) {
                case 0: throw _noArgsException();
                case 1: return arguments[0];
                default:
                    var idx = arguments.length - 1, fn = arguments[idx], length = fn.length;
                    while (idx--) {
                        fn = composeFunction(arguments[idx], fn);
                    }
                    return arity(length, fn);
            }
        };
    }


    /**
     * Creates a new function that runs each of the functions supplied as parameters in turn,
     * passing the return value of each function invocation to the next function invocation,
     * beginning with whatever arguments were passed to the initial invocation.
     *
     * Note that `compose` is a right-associative function, which means the functions provided
     * will be invoked in order from right to left. In the example `var h = compose(f, g)`,
     * the function `h` is equivalent to `f( g(x) )`, where `x` represents the arguments
     * originally passed to `h`.
     *
     * @func
     * @memberOf R
     * @category core
     * @category Function
     * @sig ((y -> z), (x -> y), ..., (b -> c), (a... -> b)) -> (a... -> z)
     * @param {...Function} functions A variable number of functions.
     * @return {Function} A new function which represents the result of calling each of the
     *         input `functions`, passing the result of each function call to the next, from
     *         right to left.
     * @example
     *
     *      var triple = function(x) { return x * 3; };
     *      var double = function(x) { return x * 2; };
     *      var square = function(x) { return x * x; };
     *      var squareThenDoubleThenTriple = R.compose(triple, double, square);
     *
     *      //≅ triple(double(square(5)))
     *      squareThenDoubleThenTriple(5); //=> 150
     */
    var compose = R.compose = _createComposer(_compose);


    /**
     * Similar to `compose` but with automatic handling of promises (or, more
     * precisely, "thennables"). The behavior is identical  to that of
     * compose() if all composed functions return something other than
     * promises (i.e., objects with a .then() method). If one of the function
     * returns a promise, however, then the next function in the composition
     * is called asynchronously, in the success callback of the promise, using
     * the resolved value as an input. Note that `pCompose` is a right-
     * associative function, just like `compose`.
     *
     * @func
     * @memberOf R
     * @category core
     * @category Function
     * @sig ((y -> z), (x -> y), ..., (b -> c), (a... -> b)) -> (a... -> z)
     * @param {...Function} functions A variable number of functions.
     * @return {Function} A new function which represents the result of calling each of the
     *         input `functions`, passing either the returned result or the asynchronously
     *         resolved value) of each function call to the next, from right to left.
     * @example
     *
     *      var Q = require('q');
     *      var triple = function(x) { return x * 3; };
     *      var double = function(x) { return x * 2; };
     *      var squareAsync = function(x) { return Q.when(x * x); };
     *      var squareAsyncThenDoubleThenTriple = R.pCompose(triple, double, squareAsync);
     *
     *      //≅ squareAsync(5).then(function(x) { return triple(double(x)) };
     *      squareAsyncThenDoubleThenTriple(5)
     *          .then(function(result) {
     *              // result is 150
     *          });
     */
    var pCompose = R.pCompose = _createComposer(_pCompose);


    /**
     * Creates a new function that runs each of the functions supplied as parameters in turn,
     * passing the return value of each function invocation to the next function invocation,
     * beginning with whatever arguments were passed to the initial invocation.
     *
     * `pipe` is the mirror version of `compose`. `pipe` is left-associative, which means that
     * each of the functions provided is executed in order from left to right.
     *
     * In some libraries this function is named `sequence`.
     * @func
     * @memberOf R
     * @category Function
     * @sig ((a... -> b), (b -> c), ..., (x -> y), (y -> z)) -> (a... -> z)
     * @param {...Function} functions A variable number of functions.
     * @return {Function} A new function which represents the result of calling each of the
     *         input `functions`, passing the result of each function call to the next, from
     *         right to left.
     * @example
     *
     *      var Q = require('q');
     *      var triple = function(x) { return x * 3; };
     *      var double = function(x) { return x * 2; };
     *      var squareAsync = function(x) { return Q.when(x * x); };
     *      var squareAsyncThenDoubleThenTriple = R.pPipe(squareAsync, double, triple);
     *
     *      //≅ squareAsync(5).then(function(x) { return triple(double(x)) };
     *      squareAsyncThenDoubleThenTriple(5)
     *          .then(function(result) {
     *              // result is 150
     *          });
     */
    R.pipe = function pipe() {
        return compose.apply(this, reverse(arguments));
    };


    /**
     * Creates a new function that runs each of the functions supplied as parameters in turn,
     * passing to the next function invocation either the value returned by the previous
     * function or the resolved value if the returned value is a promise. In other words,
     * if some of the functions in the sequence return promises, `pPipe` pipes the values
     * asynchronously. If none of the functions return promises, the behavior is the same as
     * that of `pipe`.
     *
     * `pPipe` is the mirror version of `pCompose`. `pPipe` is left-associative, which means that
     * each of the functions provided is executed in order from left to right.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig ((a... -> b), (b -> c), ..., (x -> y), (y -> z)) -> (a... -> z)
     * @param {...Function} functions A variable number of functions.
     * @return {Function} A new function which represents the result of calling each of the
     *         input `functions`, passing either the returned result or the asynchronously
     *         resolved value) of each function call to the next, from left to right.
     * @example
     *
     *      var triple = function(x) { return x * 3; };
     *      var double = function(x) { return x * 2; };
     *      var square = function(x) { return x * x; };
     *      var squareThenDoubleThenTriple = R.pipe(square, double, triple);
     *
     *      //≅ triple(double(square(5)))
     *      squareThenDoubleThenTriple(5); //=> 150
     */
    R.pPipe = function pPipe() {
        return pCompose.apply(this, reverse(arguments));
    };


    function _createPartialApplicator(concat) {
        return function(fn) {
            var args = _slice(arguments, 1);
            return arity(Math.max(0, fn.length - args.length), function() {
                return fn.apply(this, concat(args, arguments));
            });
        };
    }

    /**
     * Accepts as its arguments a function and any number of values and returns a function that,
     * when invoked, calls the original function with all of the values prepended to the
     * original function's arguments list. In some libraries this function is named `applyLeft`.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a -> b -> ... -> i -> j -> ... -> m -> n) -> a -> b-> ... -> i -> (j -> ... -> m -> n)
     * @param {Function} fn The function to invoke.
     * @param {...*} [args] Arguments to prepend to `fn` when the returned function is invoked.
     * @return {Function} A new function wrapping `fn`. When invoked, it will call `fn`
     *         with `args` prepended to `fn`'s arguments list.
     * @example
     *
     *      var multiply = function(a, b) { return a * b; };
     *      var double = R.lPartial(multiply, 2);
     *      double(2); //=> 4
     *
     *      var greet = function(salutation, title, firstName, lastName) {
     *        return salutation + ', ' + title + ' ' + firstName + ' ' + lastName + '!';
     *      };
     *      var sayHello = R.lPartial(greet, 'Hello');
     *      var sayHelloToMs = R.lPartial(sayHello, 'Ms.');
     *      sayHelloToMs('Jane', 'Jones'); //=> 'Hello, Ms. Jane Jones!'
     */
    var lPartial = R.lPartial = _createPartialApplicator(_concat);


    /**
     * Accepts as its arguments a function and any number of values and returns a function that,
     * when invoked, calls the original function with all of the values appended to the original
     * function's arguments list.
     *
     * Note that `rPartial` is the opposite of `lPartial`: `rPartial` fills `fn`'s arguments
     * from the right to the left.  In some libraries this function is named `applyRight`.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a -> b-> ... -> i -> j -> ... -> m -> n) -> j -> ... -> m -> n -> (a -> b-> ... -> i)
     * @param {Function} fn The function to invoke.
     * @param {...*} [args] Arguments to append to `fn` when the returned function is invoked.
     * @return {Function} A new function wrapping `fn`. When invoked, it will call `fn` with
     *         `args` appended to `fn`'s arguments list.
     * @example
     *
     *      var greet = function(salutation, title, firstName, lastName) {
     *        return salutation + ', ' + title + ' ' + firstName + ' ' + lastName + '!';
     *      };
     *      var greetMsJaneJones = R.rPartial(greet, 'Ms.', 'Jane', 'Jones');
     *
     *      greetMsJaneJones('Hello'); //=> 'Hello, Ms. Jane Jones!'
     */
    var rPartial = R.rPartial = _createPartialApplicator(flip(_concat));


    /**
     * Creates a new function that, when invoked, caches the result of calling `fn` for a given
     * argument set and returns the result. Subsequent calls to the memoized `fn` with the same
     * argument set will not result in an additional call to `fn`; instead, the cached result
     * for that set of arguments will be returned.
     *
     * Note that this version of `memoize` effectively handles only string and number
     * parameters.  Also note that it does not work on variadic functions.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a... -> b) -> (a... -> b)
     * @param {Function} fn The function to be wrapped by `memoize`.
     * @return {Function}  Returns a memoized version of `fn`.
     * @example
     *
     *      var numberOfCalls = 0;
     *      var trackedAdd = function(a, b) {
     *        numberOfCalls += 1;
     *        return a + b;
     *      };
     *      var memoTrackedAdd = R.memoize(trackedAdd);
     *
     *      memoTrackedAdd(1, 2); //=> 3
     *      numberOfCalls; //=> 1
     *      memoTrackedAdd(1, 2); //=> 3
     *      numberOfCalls; //=> 1
     *      memoTrackedAdd(2, 3); //=> 5
     *      numberOfCalls; //=> 2
     *
     *      // Note that argument order matters
     *      memoTrackedAdd(2, 1); //=> 3
     *      numberOfCalls; //=> 3
     */
    R.memoize = function memoize(fn) {
        if (!fn.length) {
            return once(fn);
        }
        var cache = {};
        return function() {
            if (!arguments.length) {return;}
            var position = reduce(function(cache, arg) {
                return cache[arg] || (cache[arg] = {});
            }, cache, _slice(arguments, 0, arguments.length - 1));
            var arg = arguments[arguments.length - 1];
            return (position[arg] || (position[arg] = fn.apply(this, arguments)));
        };
    };


    /**
     * Accepts a function `fn` and returns a function that guards invocation of `fn` such that
     * `fn` can only ever be called once, no matter how many times the returned function is
     * invoked.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a... -> b) -> (a... -> b)
     * @param {Function} fn The function to wrap in a call-only-once wrapper.
     * @return {Function} The wrapped function.
     * @example
     *
     *      var addOneOnce = R.once(function(x){ return x + 1; });
     *      addOneOnce(10); //=> 11
     *      addOneOnce(addOneOnce(50)); //=> 11
     */
    var once = R.once = function once(fn) {
        var called = false, result;
        return function() {
            if (called) {
                return result;
            }
            called = true;
            result = fn.apply(this, arguments);
            return result;
        };
    };


    /**
     * Wrap a function inside another to allow you to make adjustments to the parameters, or do
     * other processing either before the internal function is called or with its results.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig ((* -> *) -> ((* -> *), a...) -> (*, a... -> *)
     * @param {Function} fn The function to wrap.
     * @param {Function} wrapper The wrapper function.
     * @return {Function} The wrapped function.
     * @example
     *
     *      var slashify = R.wrap(R.flip(R.add)('/'), function(f, x) {
     *        return R.match(/\/$/, x) ? x : f(x);
     *      });
     *
     *      slashify('a');  //=> 'a/'
     *      slashify('a/'); //=> 'a/'
     */
    R.wrap = function wrap(fn, wrapper) {
        return arity(fn.length, function() {
            return wrapper.apply(this, _concat([fn], arguments));
        });
    };


    /**
     * Wraps a constructor function inside a curried function that can be called with the same
     * arguments and returns the same type. The arity of the function returned is specified
     * to allow using variadic constructor functions.
     *
     * NOTE: Does not work with some built-in objects such as Date.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig Number -> (* -> {*}) -> (* -> {*})
     * @param {Number} n The arity of the constructor function.
     * @param {Function} Fn The constructor function to wrap.
     * @return {Function} A wrapped, curried constructor function.
     * @example
     *
     *      // Variadic constructor function
     *      var Widget = function() {
     *        this.children = Array.prototype.slice.call(arguments);
     *        // ...
     *      };
     *      Widget.prototype = {
     *        // ...
     *      };
     *      var allConfigs = {
     *        // ...
     *      };
     *      R.map(R.constructN(1, Widget), allConfigs); // a list of Widgets
     */
    var constructN = R.constructN = _curry2(function constructN(n, Fn) {
        var f = function() {
            var Temp = function() {}, inst, ret;
            Temp.prototype = Fn.prototype;
            inst = new Temp();
            ret = Fn.apply(inst, arguments);
            return Object(ret) === ret ? ret : inst;
        };
        return n > 1 ? curry(nAry(n, f)) : f;
    });


    /**
     * Wraps a constructor function inside a curried function that can be called with the same
     * arguments and returns the same type.
     *
     * NOTE: Does not work with some built-in objects such as Date.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (* -> {*}) -> (* -> {*})
     * @param {Function} Fn The constructor function to wrap.
     * @return {Function} A wrapped, curried constructor function.
     * @example
     *
     *      // Constructor function
     *      var Widget = function(config) {
     *        // ...
     *      };
     *      Widget.prototype = {
     *        // ...
     *      };
     *      var allConfigs = {
     *        // ...
     *      };
     *      R.map(R.construct(Widget), allConfigs); // a list of Widgets
     */
    R.construct = function construct(Fn) {
        return constructN(Fn.length, Fn);
    };


    /**
     * Accepts at least three functions and returns a new function. When invoked, this new
     * function will invoke the first function, `after`, passing as its arguments the
     * results of invoking the subsequent functions with whatever arguments are passed to
     * the new function.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig ((*... -> c) -> (((* -> a), (* -> b), ...) -> c)
     * @param {Function} after A function. `after` will be invoked with the return values of
     *        `fn1` and `fn2` as its arguments.
     * @param {...Function} functions A variable number of functions.
     * @return {Function} A new function.
     * @example
     *
     *      var add = function(a, b) { return a + b; };
     *      var multiply = function(a, b) { return a * b; };
     *      var subtract = function(a, b) { return a - b; };
     *
     *      //≅ multiply( add(1, 2), subtract(1, 2) );
     *      R.converge(multiply, add, subtract)(1, 2); //=> -3
     *
     *      var add3 = function(a, b, c) { return a + b + c; };
     *      R.converge(add3, multiply, add, subtract)(1, 2); //=> 4
     */
    R.converge = function(after) {
        var fns = _slice(arguments, 1);
        return function() {
            var args = arguments;
            return after.apply(this, _map(function(fn) {
                return fn.apply(this, args);
            }, fns));
        };
    };



    // List Functions
    // --------------
    //
    // These functions operate on logical lists, here plain arrays.  Almost all of these are curried, and the list
    // parameter comes last, so you can create a new function by supplying the preceding arguments, leaving the
    // list parameter off.  For instance:
    //
    //     // skip third parameter
    //     var checkAllPredicates = reduce(andFn, alwaysTrue);
    //     // ... given suitable definitions of odd, lt20, gt5
    //     var test = checkAllPredicates([odd, lt20, gt5]);
    //     // test(7) => true, test(9) => true, test(10) => false,
    //     // test(3) => false, test(21) => false,

    // --------

    /**
     * Returns a single item by iterating through the list, successively calling the iterator
     * function and passing it an accumulator value and the current value from the array, and
     * then passing the result to the next call.
     *
     * The iterator function receives two values: *(acc, value)*
     *
     * Note: `R.reduce` does not skip deleted or unassigned indices (sparse arrays), unlike
     * the native `Array.prototype.reduce` method. For more details on this behavior, see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a,b -> a) -> a -> [b] -> a
     * @param {Function} fn The iterator function. Receives two values, the accumulator and the
     *        current element from the array.
     * @param {*} acc The accumulator value.
     * @param {Array} list The list to iterate over.
     * @return {*} The final, accumulated value.
     * @example
     *
     *      var numbers = [1, 2, 3];
     *      var add = function(a, b) {
     *        return a + b;
     *      };
     *
     *      R.reduce(add, 10, numbers); //=> 16
     */
    var reduce = R.reduce = _curry3(function reduce(fn, acc, list) {
        var idx = -1, len = list.length;
        while (++idx < len) {
            acc = fn(acc, list[idx]);
        }
        return acc;
    });

    /**
     * @func
     * @memberOf R
     * @category List
     * @see R.reduce
     */
    R.foldl = reduce;


    /**
     * Like `reduce`, but passes additional parameters to the predicate function.
     *
     * The iterator function receives four values: *(acc, value, index, list)*
     *
     * Note: `R.reduce.idx` does not skip deleted or unassigned indices (sparse arrays),
     * unlike the native `Array.prototype.reduce` method. For more details on this behavior,
     * see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a,b,i,[b] -> a) -> a -> [b] -> a
     * @param {Function} fn The iterator function. Receives four values: the accumulator, the
     *        current element from `list`, that element's index, and the entire `list` itself.
     * @param {*} acc The accumulator value.
     * @param {Array} list The list to iterate over.
     * @return {*} The final, accumulated value.
     * @alias reduce.idx
     * @example
     *
     *      var letters = ['a', 'b', 'c'];
     *      var objectify = function(accObject, elem, idx, list) {
     *        accObject[elem] = idx;
     *        return accObject;
     *      };
     *
     *      R.reduce.idx(objectify, {}, letters); //=> { 'a': 0, 'b': 1, 'c': 2 }
     */
    R.reduce.idx = _curry3(function reduceIdx(fn, acc, list) {
        var idx = -1, len = list.length;
        while (++idx < len) {
            acc = fn(acc, list[idx], idx, list);
        }
        return acc;
    });


    /**
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @alias foldl.idx
     * @see R.reduce.idx
     */
    R.foldl.idx = reduce.idx;


    /**
     * Returns a single item by iterating through the list, successively calling the iterator
     * function and passing it an accumulator value and the current value from the array, and
     * then passing the result to the next call.
     *
     * Similar to `reduce`, except moves through the input list from the right to the left.
     *
     * The iterator function receives two values: *(acc, value)*
     *
     * Note: `R.reduce` does not skip deleted or unassigned indices (sparse arrays), unlike
     * the native `Array.prototype.reduce` method. For more details on this behavior, see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a,b -> a) -> a -> [b] -> a
     * @param {Function} fn The iterator function. Receives two values, the accumulator and the
     *        current element from the array.
     * @param {*} acc The accumulator value.
     * @param {Array} list The list to iterate over.
     * @return {*} The final, accumulated value.
     * @example
     *
     *      var pairs = [ ['a', 1], ['b', 2], ['c', 3] ];
     *      var flattenPairs = function(acc, pair) {
     *        return acc.concat(pair);
     *      };
     *
     *      R.reduceRight(flattenPairs, [], pairs); //=> [ 'c', 3, 'b', 2, 'a', 1 ]
     */
    var reduceRight = R.reduceRight = _curry3(_checkForMethod('reduceRight', function reduceRight(fn, acc, list) {
        var idx = list.length;
        while (idx--) {
            acc = fn(acc, list[idx]);
        }
        return acc;
    }));

    /**
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @see R.reduceRight
     */
    R.foldr = reduceRight;


    /**
     * Like `reduceRight`, but passes additional parameters to the predicate function. Moves through
     * the input list from the right to the left.
     *
     * The iterator function receives four values: *(acc, value, index, list)*.
     *
     * Note: `R.reduceRight.idx` does not skip deleted or unassigned indices (sparse arrays),
     * unlike the native `Array.prototype.reduce` method. For more details on this behavior,
     * see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a,b,i,[b] -> a -> [b] -> a
     * @param {Function} fn The iterator function. Receives four values: the accumulator, the
     *        current element from `list`, that element's index, and the entire `list` itself.
     * @param {*} acc The accumulator value.
     * @param {Array} list The list to iterate over.
     * @return {*} The final, accumulated value.
     * @alias reduceRight.idx
     * @example
     *
     *      var letters = ['a', 'b', 'c'];
     *      var objectify = function(accObject, elem, idx, list) {
     *        accObject[elem] = idx;
     *        return accObject;
     *      };
     *
     *      R.reduceRight.idx(objectify, {}, letters); //=> { 'c': 2, 'b': 1, 'a': 0 }
     */
    R.reduceRight.idx = _curry3(function reduceRightIdx(fn, acc, list) {
        var idx = list.length;
        while (idx--) {
            acc = fn(acc, list[idx], idx, list);
        }
        return acc;
    });


    /**
     * @func
     * @memberOf R
     * @category List
     * @alias foldr.idx
     * @see R.reduceRight.idx
     */
    R.foldr.idx = reduceRight.idx;


    /**
     * Builds a list from a seed value. Accepts an iterator function, which returns either false
     * to stop iteration or an array of length 2 containing the value to add to the resulting
     * list and the seed to be used in the next call to the iterator function.
     *
     * The iterator function receives one argument: *(seed)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> [b]) -> * -> [b]
     * @param {Function} fn The iterator function. receives one argument, `seed`, and returns
     *        either false to quit iteration or an array of length two to proceed. The element
     *        at index 0 of this array will be added to the resulting array, and the element
     *        at index 1 will be passed to the next call to `fn`.
     * @param {*} seed The seed value.
     * @return {Array} The final list.
     * @example
     *
     *      var f = function(n) { return n > 50 ? false : [-n, n + 10] };
     *      R.unfoldr(f, 10); //=> [-10, -20, -30, -40, -50]
     */
    R.unfoldr = _curry2(function unfoldr(fn, seed) {
        var pair = fn(seed);
        var result = [];
        while (pair && pair.length) {
            result.push(pair[0]);
            pair = fn(pair[1]);
        }
        return result;
    });


    function _map(fn, list) {
        var idx = -1, len = list.length, result = new Array(len);
        while (++idx < len) {
            result[idx] = fn(list[idx]);
        }
        return result;
    }

    /**
     * Returns a new list, constructed by applying the supplied function to every element of the
     * supplied list.
     *
     * Note: `R.map` does not skip deleted or unassigned indices (sparse arrays), unlike the
     * native `Array.prototype.map` method. For more details on this behavior, see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a -> b) -> [a] -> [b]
     * @param {Function} fn The function to be called on every element of the input `list`.
     * @param {Array} list The list to be iterated over.
     * @return {Array} The new list.
     * @example
     *
     *      var double = function(x) {
     *        return x * 2;
     *      };
     *
     *      R.map(double, [1, 2, 3]); //=> [2, 4, 6]
     */
    var map = R.map = _curry2(_checkForMethod('map', _map));


    /**
     * Like `map`, but but passes additional parameters to the mapping function.
     * `fn` receives three arguments: *(value, index, list)*.
     *
     * Note: `R.map.idx` does not skip deleted or unassigned indices (sparse arrays), unlike
     * the native `Array.prototype.map` method. For more details on this behavior, see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a,i,[b] -> b) -> [a] -> [b]
     * @param {Function} fn The function to be called on every element of the input `list`.
     * @param {Array} list The list to be iterated over.
     * @return {Array} The new list.
     * @alias map.idx
     * @example
     *
     *      var squareEnds = function(elt, idx, list) {
     *        if (idx === 0 || idx === list.length - 1) {
     *          return elt * elt;
     *        }
     *        return elt;
     *      };
     *
     *      R.map.idx(squareEnds, [8, 5, 3, 0, 9]); //=> [64, 5, 3, 0, 81]
     */
    R.map.idx = _curry2(function mapIdx(fn, list) {
        var idx = -1, len = list.length, result = new Array(len);
        while (++idx < len) {
            result[idx] = fn(list[idx], idx, list);
        }
        return result;
    });


    /**
     * Map, but for objects. Creates an object with the same keys as `obj` and values
     * generated by running each property of `obj` through `fn`. `fn` is passed one argument:
     * *(value)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (v -> v) -> {k: v} -> {k: v}
     * @param {Function} fn A function called for each property in `obj`. Its return value will
     * become a new property on the return object.
     * @param {Object} obj The object to iterate over.
     * @return {Object} A new object with the same keys as `obj` and values that are the result
     * of running each property through `fn`.
     * @example
     *
     *      var values = { x: 1, y: 2, z: 3 };
     *      var double = function(num) {
     *        return num * 2;
     *      };
     *
     *      R.mapObj(double, values); //=> { x: 2, y: 4, z: 6 }
     */
    // TODO: consider mapObj.key in parallel with mapObj.idx.  Also consider folding together with `map` implementation.
    R.mapObj = _curry2(function mapObject(fn, obj) {
        return reduce(function(acc, key) {
            acc[key] = fn(obj[key]);
            return acc;
        }, {}, keys(obj));
    });


    /**
     * Like `mapObj`, but but passes additional arguments to the predicate function. The
     * predicate function is passed three arguments: *(value, key, obj)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (v, k, {k: v} -> v) -> {k: v} -> {k: v}
     * @param {Function} fn A function called for each property in `obj`. Its return value will
     *        become a new property on the return object.
     * @param {Object} obj The object to iterate over.
     * @return {Object} A new object with the same keys as `obj` and values that are the result
     *         of running each property through `fn`.
     * @alias mapObj.idx
     * @example
     *
     *      var values = { x: 1, y: 2, z: 3 };
     *      var prependKeyAndDouble = function(num, key, obj) {
     *        return key + (num * 2);
     *      };
     *
     *      R.mapObj.idx(prependKeyAndDouble, values); //=> { x: 'x2', y: 'y4', z: 'z6' }
     */
    R.mapObj.idx = _curry2(function mapObjectIdx(fn, obj) {
        return reduce(function(acc, key) {
            acc[key] = fn(obj[key], key, obj);
            return acc;
        }, {}, keys(obj));
    });

    /**
     * Scanl is similar to reduce, but returns a list of successively reduced values from the left
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a,b -> a) -> a -> [b] -> [a]
     * @param {Function} fn The iterator function. Receives two values, the accumulator and the
     *        current element from the array
     * @param {*} acc The accumulator value.
     * @param {Array} list The list to iterate over.
     * @return {Array} A list of all intermediately reduced values
     * @example
     *
     *      var numbers = [1, 2, 3, 4];
     *      var factorials = R.scanl(R.multiply, 1, numbers); //=> [1, 1, 2, 6, 24]
     */
    R.scanl = _curry3(function scanl(fn, acc, list) {
        var idx = 0, len = list.length + 1, result = new Array(len);
        result[idx] = acc;
        while (++idx < len) {
            acc = fn(acc, list[idx - 1]);
            result[idx] = acc;
        }
        return result;
    });


    /**
     * "lifts" a function to be the specified arity, so that it may "map over" that many
     * lists (or other Functors).
     *
     * @func
     * @memberOf R
     * @see R.lift
     * @category Function
     * @sig Number -> (*... -> *) -> ([*]... -> [*])
     * @param {Function} fn The function to lift into higher context
     * @return {Function} The function `fn` applicable to mappable objects.
     * @example
     *
     *     var madd3 = R.liftN(3, R.curryN(3, function() {
     *         return R.foldl(R.add, 0, arguments);
     *     }));
     *     madd3([1,2,3], [1,2,3], [1]); //=> [3, 4, 5, 4, 5, 6, 5, 6, 7]
     */
    var liftN = R.liftN = _curry2(function liftN(arity, fn) {
        var lifted = curryN(arity, fn);
        if (arguments.length === 0) {
            throw _noArgsException();
        }
        return curryN(arity, function() {
            return reduce(ap, _map(lifted, arguments[0]), _slice(arguments, 1));
        });
    });


    /**
     * "lifts" a function of arity > 1 so that it may "map over" an Array or
     * other Functor.
     *
     * @func
     * @memberOf R
     * @see R.liftN
     * @category Function
     * @sig (*... -> *) -> ([*]... -> [*])
     * @param {Function} fn The function to lift into higher context
     * @return {Function} The function `fn` applicable to mappable objects.
     * @example
     *
     *     var madd3 = R.lift(R.curryN(3, function(a, b, c) {
     *         return a + b + c;
     *     }));
     *     madd3([1,2,3], [1,2,3], [1]); //=> [3, 4, 5, 4, 5, 6, 5, 6, 7]
     *
     *     var madd5 = R.lift(R.curryN(5, function(a, b, c, d, e) {
     *         return a + b + c + d + e;
     *     }));
     *     madd5([1,2], [3], [4, 5], [6], [7, 8]); //=> [21, 22, 22, 23, 22, 23, 23, 24]
     */
    R.lift = function lift(fn) {
        if (arguments.length === 0) {
            throw _noArgsException();
        }
        return liftN(fn.length, fn);
    };


    /**
     * ap applies a list of functions to a list of values.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig [f] -> [a] -> [f a]
     * @param {Array} fns An array of functions
     * @param {Array} vs An array of values
     * @return the value of applying each the function `fns` to each value in `vs`
     * @example
     *
     *      R.ap([R.multiply(2), R.add(3)], [1,2,3]); //=> [2, 4, 6, 4, 5, 6]
     */
    var ap = R.ap = _curry2(function ap(fns, vs) {
        return _hasMethod('ap', fns) ? fns.ap(vs) : reduce(function(acc, fn) {
            return _concat(acc, _map(fn, vs));
        },  [], fns);
    });

    /**
     *
     * `of` wraps any object in an Array. This implementation is compatible with the
     * Fantasy-land Applicative spec, and will work with types that implement that spec.
     * Note this `of` is different from the ES6 `of`; See
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/of
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig a -> [a]
     * @param {*} x any value
     * @return [x]
     * @example
     *
     *      R.of(1); //=> [1]
     *      R.of([2]); //=> [[2]]
     *      R.of({}); //=> [{}]
     */
    R.of = function of(x, container) {
        return (_hasMethod('of', container)) ? container.of(x) : [x];
    };


    /**
     * `empty` wraps any object in an array. This implementation is compatible with the
     * Fantasy-land Monoid spec, and will work with types that implement that spec.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig * -> []
     * @return {Array} an empty array
     * @example
     *
     *      R.empty([1,2,3,4,5]); //=> []
     */
    R.empty = function empty(x) {
        return (_hasMethod('empty', x)) ? x.empty() : [];
    };


    /**
     * `chain` maps a function over a list and concatenates the results.
     * This implementation is compatible with the
     * Fantasy-land Chain spec, and will work with types that implement that spec.
     * `chain` is also known as `flatMap` in some libraries
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> [b]) -> [a] -> [b]
     * @param {Function} fn
     * @param {Array} list
     * @return {Array}
     * @example
     *
     *      var duplicate = function(n) {
     *        return [n, n];
     *      };
     *      R.chain(duplicate, [1, 2, 3]); //=> [1, 1, 2, 2, 3, 3]
     *
     */
    R.chain = _curry2(_checkForMethod('chain', function chain(f, list) {
        return unnest(_map(f, list));
    }));


    /**
     * Turns a list of Functors into a Functor of a list, applying
     * a mapping function to the elements of the list along the way.
     *
     * Note: `commuteMap` may be more useful to convert a list of non-Array Functors (e.g.
     * Maybe, Either, etc.) to Functor of a list.
     *
     * @func
     * @memberOf R
     * @category List
     * @see R.commute
     * @sig (a -> (b -> c)) -> (x -> [x]) -> [[*]...]
     * @param {Function} fn The transformation function
     * @param {Function} of A function that returns the data type to return
     * @param {Array} list An Array (or other Functor) of Arrays (or other Functors)
     * @return {Array}
     * @example
     *
     *     var plus10map = R.map(function(x) { return x + 10; });
     *     var as = [[1], [3, 4]];
     *     R.commuteMap(R.map(function(x) { return x + 10; }), R.of, as); //=> [[11, 13], [11, 14]]
     *
     *     var bs = [[1, 2], [3]];
     *     R.commuteMap(plus10map, R.of, bs); //=> [[11, 13], [12, 13]]
     *
     *     var cs = [[1, 2], [3, 4]];
     *     R.commuteMap(plus10map, R.of, cs); //=> [[11, 13], [12, 13], [11, 14], [12, 14]]
     *
     */
    var commuteMap = R.commuteMap = _curry3(function commuteMap(fn, of, list) {
        function consF(acc, ftor) {
            return ap(map(append, fn(ftor)), acc);
        }
        return reduce(consF, of([]), list);
    });

    /**
     * Turns a list of Functors into a Functor of a list.
     *
     * Note: `commute` may be more useful to convert a list of non-Array Functors (e.g.
     * Maybe, Either, etc.) to Functor of a list.
     *
     * @func
     * @memberOf R
     * @category List
     * @see R.commuteMap
     * @sig (x -> [x]) -> [[*]...]
     * @param {Function} of A function that returns the data type to return
     * @param {Array} list An Array (or other Functor) of Arrays (or other Functors)
     * @return {Array}
     * @example
     *
     *     var as = [[1], [3, 4]];
     *     R.commute(R.of, as); //=> [[1, 3], [1, 4]]
     *
     *     var bs = [[1, 2], [3]];
     *     R.commute(R.of, bs); //=> [[1, 3], [2, 3]]
     *
     *     var cs = [[1, 2], [3, 4]];
     *     R.commute(R.of, cs); //=> [[1, 3], [2, 3], [1, 4], [2, 4]]
     */
    R.commute = commuteMap(map(identity));


    /**
     * Returns the number of elements in the array by returning `list.length`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> Number
     * @param {Array} list The array to inspect.
     * @return {Number} The size of the array.
     * @example
     *
     *      R.size([]); //=> 0
     *      R.size([1, 2, 3]); //=> 3
     */
    var size = R.size = function size(list) {
        return list.length;
    };

    /**
     * @func
     * @memberOf R
     * @category List
     * @see R.size
     */
    R.length = size;


    function _filter(fn, list) {
        var idx = -1, len = list.length, result = [];
        while (++idx < len) {
            if (fn(list[idx])) {
                result.push(list[idx]);
            }
        }
        return result;
    }

    /**
     * Returns a new list containing only those items that match a given predicate function.
     * The predicate function is passed one argument: *(value)*.
     *
     * Note that `R.filter` does not skip deleted or unassigned indices, unlike the native
     * `Array.prototype.filter` method. For more details on this behavior, see:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter#Description
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a -> Boolean) -> [a] -> [a]
     * @param {Function} fn The function called per iteration.
     * @param {Array} list The collection to iterate over.
     * @return {Array} The new filtered array.
     * @example
     *
     *      var isEven = function(n) {
     *        return n % 2 === 0;
     *      };
     *      R.filter(isEven, [1, 2, 3, 4]); //=> [2, 4]
     */
    R.filter = _curry2(_checkForMethod('filter', _filter));


    /**
     * Like `filter`, but passes additional parameters to the predicate function. The predicate
     * function is passed three arguments: *(value, index, list)*.
     *
     * @func
     * @memberOf R
     * @category core
     * @category List
     * @sig (a, i, [a] -> Boolean) -> [a] -> [a]
     * @param {Function} fn The function called per iteration.
     * @param {Array} list The collection to iterate over.
     * @return {Array} The new filtered array.
     * @alias filter.idx
     * @example
     *
     *      var lastTwo = function(val, idx, list) {
     *        return list.length - idx <= 2;
     *      };
     *      R.filter.idx(lastTwo, [8, 6, 7, 5, 3, 0, 9]); //=> [0, 9]
     */
    function filterIdx(fn, list) {
        var idx = -1, len = list.length, result = [];
        while (++idx < len) {
            if (fn(list[idx], idx, list)) {
                result.push(list[idx]);
            }
        }
        return result;
    }
    R.filter.idx = _curry2(filterIdx);


    /**
     * Similar to `filter`, except that it keeps only values for which the given predicate
     * function returns falsy. The predicate function is passed one argument: *(value)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> [a]
     * @param {Function} fn The function called per iteration.
     * @param {Array} list The collection to iterate over.
     * @return {Array} The new filtered array.
     * @example
     *
     *      var isOdd = function(n) {
     *        return n % 2 === 1;
     *      };
     *      R.reject(isOdd, [1, 2, 3, 4]); //=> [2, 4]
     */
    var reject = function reject(fn, list) {
        return _filter(not(fn), list);
    };
    R.reject = _curry2(reject);


    /**
     * Like `reject`, but passes additional parameters to the predicate function. The predicate
     * function is passed three arguments: *(value, index, list)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a, i, [a] -> Boolean) -> [a] -> [a]
     * @param {Function} fn The function called per iteration.
     * @param {Array} list The collection to iterate over.
     * @return {Array} The new filtered array.
     * @alias reject.idx
     * @example
     *
     *      var lastTwo = function(val, idx, list) {
     *        return list.length - idx <= 2;
     *      };
     *
     *      R.reject.idx(lastTwo, [8, 6, 7, 5, 3, 0, 9]); //=> [8, 6, 7, 5, 3]
     */
    R.reject.idx = _curry2(function rejectIdx(fn, list) {
        return filterIdx(not(fn), list);
    });


    /**
     * Returns a new list containing the first `n` elements of a given list, passing each value
     * to the supplied predicate function, and terminating when the predicate function returns
     * `false`. Excludes the element that caused the predicate function to fail. The predicate
     * function is passed one argument: *(value)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> [a]
     * @param {Function} fn The function called per iteration.
     * @param {Array} list The collection to iterate over.
     * @return {Array} A new array.
     * @example
     *
     *      var isNotFour = function(x) {
     *        return !(x === 4);
     *      };
     *
     *      R.takeWhile(isNotFour, [1, 2, 3, 4]); //=> [1, 2, 3]
     */
    R.takeWhile = _curry2(_checkForMethod('takeWhile', function(fn, list) {
        var idx = -1, len = list.length;
        while (++idx < len && fn(list[idx])) {}
        return _slice(list, 0, idx);
    }));


    /**
     * Returns a new list containing the first `n` elements of the given list.  If
     * `n > * list.length`, returns a list of `list.length` elements.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> [a] -> [a]
     * @param {Number} n The number of elements to return.
     * @param {Array} list The array to query.
     * @return {Array} A new array containing the first elements of `list`.
     */
    R.take = _curry2(_checkForMethod('take', function(n, list) {
        return _slice(list, 0, Math.min(n, list.length));
    }));


    /**
     * Returns a new list containing the last `n` elements of a given list, passing each value
     * to the supplied predicate function, beginning when the predicate function returns
     * `true`. Excludes the element that caused the predicate function to fail. The predicate
     * function is passed one argument: *(value)*.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> [a]
     * @param {Function} fn The function called per iteration.
     * @param {Array} list The collection to iterate over.
     * @return {Array} A new array.
     * @example
     *
     *      var isTwo = function(x) {
     *        return x === 2;
     *      };
     *
     *      R.skipUntil(isTwo, [1, 2, 3, 4]); //=> [2, 3, 4]
     */
    R.skipUntil = _curry2(function skipUntil(fn, list) {
        var idx = -1, len = list.length;
        while (++idx < len && !fn(list[idx])) {}
        return _slice(list, idx);
    });


    /**
     * Returns a new list containing all but the first `n` elements of the given `list`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> [a] -> [a]
     * @param {Number} n The number of elements of `list` to skip.
     * @param {Array} list The array to consider.
     * @return {Array} The last `n` elements of `list`.
     * @example
     *
     *     R.skip(3, [1,2,3,4,5,6,7]); //=> [4,5,6,7]
     */
    R.skip = _curry2(_checkForMethod('skip', function skip(n, list) {
        if (n < list.length) {
            return _slice(list, n);
        } else {
            return [];
        }
    }));


    /**
     * Returns the first element of the list which matches the predicate, or `undefined` if no
     * element matches.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> a | undefined
     * @param {Function} fn The predicate function used to determine if the element is the
     *        desired one.
     * @param {Array} list The array to consider.
     * @return {Object} The element found, or `undefined`.
     * @example
     *
     *      var xs = [{a: 1}, {a: 2}, {a: 3}];
     *      R.find(R.propEq('a', 2))(xs); //=> {a: 2}
     *      R.find(R.propEq('a', 4))(xs); //=> undefined
     */
    R.find = _curry2(function find(fn, list) {
        var idx = -1;
        var len = list.length;
        while (++idx < len) {
            if (fn(list[idx])) {
                return list[idx];
            }
        }
    });


    /**
     * Returns the index of the first element of the list which matches the predicate, or `-1`
     * if no element matches.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> Number
     * @param {Function} fn The predicate function used to determine if the element is the
     * desired one.
     * @param {Array} list The array to consider.
     * @return {Number} The index of the element found, or `-1`.
     * @example
     *
     *      var xs = [{a: 1}, {a: 2}, {a: 3}];
     *      R.findIndex(R.propEq('a', 2))(xs); //=> 1
     *      R.findIndex(R.propEq('a', 4))(xs); //=> -1
     */
    R.findIndex = _curry2(function findIndex(fn, list) {
        var idx = -1;
        var len = list.length;
        while (++idx < len) {
            if (fn(list[idx])) {
                return idx;
            }
        }
        return -1;
    });


    /**
     * Returns the last element of the list which matches the predicate, or `undefined` if no
     * element matches.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> a | undefined
     * @param {Function} fn The predicate function used to determine if the element is the
     * desired one.
     * @param {Array} list The array to consider.
     * @return {Object} The element found, or `undefined`.
     * @example
     *
     *      var xs = [{a: 1, b: 0}, {a:1, b: 1}];
     *      R.findLast(R.propEq('a', 1))(xs); //=> {a: 1, b: 1}
     *      R.findLast(R.propEq('a', 4))(xs); //=> undefined
     */
    R.findLast = _curry2(function findLast(fn, list) {
        var idx = list.length;
        while (idx--) {
            if (fn(list[idx])) {
                return list[idx];
            }
        }
    });


    /**
     * Returns the index of the last element of the list which matches the predicate, or
     * `-1` if no element matches.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> Number
     * @param {Function} fn The predicate function used to determine if the element is the
     * desired one.
     * @param {Array} list The array to consider.
     * @return {Number} The index of the element found, or `-1`.
     * @example
     *
     *      var xs = [{a: 1, b: 0}, {a:1, b: 1}];
     *      R.findLastIndex(R.propEq('a', 1))(xs); //=> 1
     *      R.findLastIndex(R.propEq('a', 4))(xs); //=> -1
     */
    R.findLastIndex = _curry2(function findLastIndex(fn, list) {
        var idx = list.length;
        while (idx--) {
            if (fn(list[idx])) {
                return idx;
            }
        }
        return -1;
    });


    /**
     * Returns `true` if all elements of the list match the predicate, `false` if there are any
     * that don't.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> Boolean
     * @param {Function} fn The predicate function.
     * @param {Array} list The array to consider.
     * @return {Boolean} `true` if the predicate is satisfied by every element, `false`
     *         otherwise
     * @example
     *
     *      var lessThan2 = R.flip(R.lt)(2);
     *      var lessThan3 = R.flip(R.lt)(3);
     *      var xs = R.range(1, 3);
     *      xs; //=> [1, 2]
     *      R.every(lessThan2)(xs); //=> false
     *      R.every(lessThan3)(xs); //=> true
     */
    function every(fn, list) {
        var idx = -1;
        while (++idx < list.length) {
            if (!fn(list[idx])) {
                return false;
            }
        }
        return true;
    }
    R.every = _curry2(every);


    /**
     * Returns `true` if at least one of elements of the list match the predicate, `false`
     * otherwise.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> Boolean
     * @param {Function} fn The predicate function.
     * @param {Array} list The array to consider.
     * @return {Boolean} `true` if the predicate is satisfied by at least one element, `false`
     *         otherwise
     * @example
     *
     *      var lessThan0 = R.flip(R.lt)(0);
     *      var lessThan2 = R.flip(R.lt)(2);
     *      var xs = R.range(1, 3);
     *      xs; //=> [1, 2]
     *      R.some(lessThan0)(xs); //=> false
     *      R.some(lessThan2)(xs); //=> true
     */
    function some(fn, list) {
        var idx = -1;
        while (++idx < list.length) {
            if (fn(list[idx])) {
                return true;
            }
        }
        return false;
    }
    R.some = _curry2(some);


    /**
     * Internal implementation of `indexOf`.
     * Returns the position of the first occurrence of an item in an array
     * (by strict equality),
     * or -1 if the item is not included in the array.
     *
     * @private
     * @category Internal
     * @param {Array} list The array to search
     * @param {*} item the item to find in the Array
     * @param {Number} from (optional) the index to start searching the Array
     * @return {Number} the index of the found item, or -1
     *
     */
    function _indexOf(list, item, from) {
        var idx = 0, len = list.length;
        if (typeof from == 'number') {
            idx = from < 0 ? Math.max(0, len + from) : from;
        }
        while (idx < len) {
            if (list[idx] === item) {
                return idx;
            }
            ++idx;
        }
        return -1;
    }


    /**
     * Internal implementation of `lastIndexOf`.
     * Returns the position of the last occurrence of an item in an array
     * (by strict equality),
     * or -1 if the item is not included in the array.
     *
     * @private
     * @category Internal
     * @param {Array} list The array to search
     * @param {*} item the item to find in the Array
     * @param {Number} from (optional) the index to start searching the Array
     * @return {Number} the index of the found item, or -1
     *
     */
    function _lastIndexOf(list, item, from) {
        var idx = list.length;
        if (typeof from == 'number') {
            idx = from < 0 ? idx + from + 1 : Math.min(idx, from + 1);
        }
        while (--idx >= 0) {
            if (list[idx] === item) {
                return idx;
            }
        }
        return -1;
    }


    /**
     * Returns the position of the first occurrence of an item in an array
     * (by strict equality),
     * or -1 if the item is not included in the array.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> [a] -> Number
     * @param {*} target The item to find.
     * @param {Array} list The array to search in.
     * @return {Number} the index of the target, or -1 if the target is not found.
     *
     * @example
     *
     *      R.indexOf(3, [1,2,3,4]); //=> 2
     *      R.indexOf(10, [1,2,3,4]); //=> -1
     */
    R.indexOf = _curry2(function indexOf(target, list) {
        return _indexOf(list, target);
    });


    /**
     * Returns the position of the first occurrence of an item (by strict equality) in
     * an array, or -1 if the item is not included in the array. However,
     * `indexOf.from` will only search the tail of the array, starting from the
     * `fromIdx` parameter.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> Number -> [a] -> Number
     * @param {*} target The item to find.
     * @param {Array} list The array to search in.
     * @param {Number} fromIdx the index to start searching from
     * @return {Number} the index of the target, or -1 if the target is not found.
     *
     * @example
     *
     *      R.indexOf.from(3, 2, [-1,0,1,2,3,4]); //=> 4
     *      R.indexOf.from(10, 2, [1,2,3,4]); //=> -1
     */
    R.indexOf.from = _curry3(function indexOfFrom(target, fromIdx, list) {
        return _indexOf(list, target, fromIdx);
    });


    /**
     * Returns the position of the last occurrence of an item (by strict equality) in
     * an array, or -1 if the item is not included in the array.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> [a] -> Number
     * @param {*} target The item to find.
     * @param {Array} list The array to search in.
     * @return {Number} the index of the target, or -1 if the target is not found.
     *
     * @example
     *
     *      R.lastIndexOf(3, [-1,3,3,0,1,2,3,4]); //=> 6
     *      R.lastIndexOf(10, [1,2,3,4]); //=> -1
     */
    R.lastIndexOf = _curry2(function lastIndexOf(target, list) {
        return _lastIndexOf(list, target);
    });


    /**
     * Returns the position of the last occurrence of an item (by strict equality) in
     * an array, or -1 if the item is not included in the array. However,
     * `lastIndexOf.from` will only search the tail of the array, starting from the
     * `fromIdx` parameter.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> Number -> [a] -> Number
     * @param {*} target The item to find.
     * @param {Array} list The array to search in.
     * @param {Number} fromIdx the index to start searching from
     * @return {Number} the index of the target, or -1 if the target is not found.
     *
     * @example
     *
     *      R.lastIndexOf.from(3, 2, [-1,3,3,0,1,2,3,4]); //=> 2
     *      R.lastIndexOf.from(10, 2, [1,2,3,4]); //=> -1
     */
    R.lastIndexOf.from = _curry3(function lastIndexOfFrom(target, fromIdx, list) {
        return _lastIndexOf(list, target, fromIdx);
    });


    /**
     * Returns `true` if the specified item is somewhere in the list, `false` otherwise.
     * Equivalent to `indexOf(a)(list) > -1`. Uses strict (`===`) equality checking.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> [a] -> Boolean
     * @param {Object} a The item to compare against.
     * @param {Array} list The array to consider.
     * @return {Boolean} `true` if the item is in the list, `false` otherwise.
     * @example
     *
     *      R.contains(3)([1, 2, 3]); //=> true
     *      R.contains(4)([1, 2, 3]); //=> false
     *      R.contains({})([{}, {}]); //=> false
     *      var obj = {};
     *      R.contains(obj)([{}, obj, {}]); //=> true
     */
    function _contains(a, list) {
        return _indexOf(list, a) >= 0;
    }

    R.contains = _curry2(_contains);


    /**
     * Returns `true` if the `x` is found in the `list`, using `pred` as an
     * equality predicate for `x`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a, a -> Boolean) -> a -> [a] -> Boolean
     * @param {Function} pred A predicate used to test whether two items are equal.
     * @param {*} x The item to find
     * @param {Array} list The list to iterate over
     * @return {Boolean} `true` if `x` is in `list`, else `false`
     * @example
     *
     *     var xs = [{x: 12}, {x: 11}, {x: 10}];
     *     R.containsWith(function(a, b) { return a.x === b.x; }, {x: 10}, xs); //=> true
     *     R.containsWith(function(a, b) { return a.x === b.x; }, {x: 1}, xs); //=> false
     */
    function _containsWith(pred, x, list) {
        var idx = -1, len = list.length;
        while (++idx < len) {
            if (pred(x, list[idx])) {
                return true;
            }
        }
        return false;
    }

    var containsWith = R.containsWith = _curry3(_containsWith);


    /**
     * Returns a new list containing only one copy of each element in the original list.
     * Equality is strict here, meaning reference equality for objects and non-coercing equality
     * for primitives.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> [a]
     * @param {Array} list The array to consider.
     * @return {Array} The list of unique items.
     * @example
     *
     *      R.uniq([1, 1, 2, 1]); //=> [1, 2]
     *      R.uniq([{}, {}]);     //=> [{}, {}]
     *      R.uniq([1, '1']);     //=> [1, '1']
     */
    var uniq = R.uniq = function uniq(list) {
        var idx = -1, len = list.length;
        var result = [], item;
        while (++idx < len) {
            item = list[idx];
            if (!_contains(item, result)) {
                result.push(item);
            }
        }
        return result;
    };


    /**
     * Returns `true` if all elements are unique, otherwise `false`.
     * Uniqueness is determined using strict equality (`===`).
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> Boolean
     * @param {Array} list The array to consider.
     * @return {Boolean} `true` if all elements are unique, else `false`.
     * @example
     *
     *      R.isSet(['1', 1]); //=> true
     *      R.isSet([1, 1]);   //=> false
     *      R.isSet([{}, {}]); //=> true
     */
    R.isSet = function isSet(list) {
        var len = list.length;
        var idx = -1;
        while (++idx < len) {
            if (_indexOf(list, list[idx], idx + 1) >= 0) {
                return false;
            }
        }
        return true;
    };


    /**
     * Returns a new list containing only one copy of each element in the original list, based
     * upon the value returned by applying the supplied predicate to two list elements. Prefers
     * the first item if two items compare equal based on the predicate.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a, a -> Boolean) -> [a] -> [a]
     * @param {Function} pred A predicate used to test whether two items are equal.
     * @param {Array} list The array to consider.
     * @return {Array} The list of unique items.
     * @example
     *
     *      var strEq = function(a, b) { return String(a) === String(b); };
     *      R.uniqWith(strEq)([1, '1', 2, 1]); //=> [1, 2]
     *      R.uniqWith(strEq)([{}, {}]);       //=> [{}]
     *      R.uniqWith(strEq)([1, '1', 1]);    //=> [1]
     *      R.uniqWith(strEq)(['1', 1, 1]);    //=> ['1']
     */
    var uniqWith = R.uniqWith = _curry2(function uniqWith(pred, list) {
        var idx = -1, len = list.length;
        var result = [], item;
        while (++idx < len) {
            item = list[idx];
            if (!_containsWith(pred, item, result)) {
                result.push(item);
            }
        }
        return result;
    });


    /**
     * Returns a new list by plucking the same named property off all objects in the list supplied.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig String -> {*} -> [*]
     * @param {Number|String} key The key name to pluck off of each object.
     * @param {Array} list The array to consider.
     * @return {Array} The list of values for the given key.
     * @example
     *
     *      R.pluck('a')([{a: 1}, {a: 2}]); //=> [1, 2]
     *      R.pluck(0)([[1, 2], [3, 4]]);   //=> [1, 3]
     */
    var pluck = R.pluck = _curry2(function pluck(p, list) {
        return _map(prop(p), list);
    });


    /**
     * `_makeFlat` is a helper function that returns a one-level or fully recursive function
     * based on the flag passed in.
     *
     * @private
     */
    // TODO: document, even for internals...
    function _makeFlat(recursive) {
        return function flatt(list) {
            var value, result = [], idx = -1, j, ilen = list.length, jlen;
            while (++idx < ilen) {
                if (isArrayLike(list[idx])) {
                    value = (recursive) ? flatt(list[idx]) : list[idx];
                    j = -1;
                    jlen = value.length;
                    while (++j < jlen) {
                        result.push(value[j]);
                    }
                } else {
                    result.push(list[idx]);
                }
            }
            return result;
        };
    }


    /**
     * Returns a new list by pulling every item out of it (and all its sub-arrays) and putting
     * them in a new array, depth-first.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> [b]
     * @param {Array} list The array to consider.
     * @return {Array} The flattened list.
     * @example
     *
     *      R.flatten([1, 2, [3, 4], 5, [6, [7, 8, [9, [10, 11], 12]]]]);
     *      //=> [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
     */
    R.flatten = _makeFlat(true);


    /**
     * Returns a new list by pulling every item at the first level of nesting out, and putting
     * them in a new array.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> [b]
     * @param {Array} list The array to consider.
     * @return {Array} The flattened list.
     * @example
     *
     *      R.unnest([1, [2], [[3]]]); //=> [1, 2, [3]]
     *      R.unnest([[1, 2], [3, 4], [5, 6]]); //=> [1, 2, 3, 4, 5, 6]
     */
    var unnest = R.unnest = _makeFlat(false);


    /**
     * Creates a new list out of the two supplied by applying the function to
     * each equally-positioned pair in the lists. The returned list is
     * truncated to the length of the shorter of the two input lists.
     *
     * @function
     * @memberOf R
     * @category List
     * @sig (a,b -> c) -> a -> b -> [c]
     * @param {Function} fn The function used to combine the two elements into one value.
     * @param {Array} list1 The first array to consider.
     * @param {Array} list2 The second array to consider.
     * @return {Array} The list made by combining same-indexed elements of `list1` and `list2`
     * using `fn`.
     * @example
     *
     *      var f = function(x, y) {
     *        // ...
     *      };
     *      R.zipWith(f, [1, 2, 3], ['a', 'b', 'c']);
     *      //=> [f(1, 'a'), f(2, 'b'), f(3, 'c')]
     */
    R.zipWith = _curry3(function zipWith(fn, a, b) {
        var rv = [], idx = -1, len = Math.min(a.length, b.length);
        while (++idx < len) {
            rv[idx] = fn(a[idx], b[idx]);
        }
        return rv;
    });


    /**
     * Creates a new list out of the two supplied by pairing up
     * equally-positioned items from both lists.  The returned list is
     * truncated to the length of the shorter of the two input lists.
     * Note: `zip` is equivalent to `zipWith(function(a, b) { return [a, b] })`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> b -> [[a,b]]
     * @param {Array} list1 The first array to consider.
     * @param {Array} list2 The second array to consider.
     * @return {Array} The list made by pairing up same-indexed elements of `list1` and `list2`.
     * @example
     *
     *      R.zip([1, 2, 3], ['a', 'b', 'c']); //=> [[1, 'a'], [2, 'b'], [3, 'c']]
     */
    R.zip = _curry2(function zip(a, b) {
        var rv = [];
        var idx = -1;
        var len = Math.min(a.length, b.length);
        while (++idx < len) {
            rv[idx] = [a[idx], b[idx]];
        }
        return rv;
    });


    /**
     * Creates a new object out of a list of keys and a list of values.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig k -> v -> {k: v}
     * @param {Array} keys The array that will be properties on the output object.
     * @param {Array} values The list of values on the output object.
     * @return {Object} The object made by pairing up same-indexed elements of `keys` and `values`.
     * @example
     *
     *      R.zipObj(['a', 'b', 'c'], [1, 2, 3]); //=> {a: 1, b: 2, c: 3}
     */
    R.zipObj = _curry2(function zipObj(keys, values) {
        var idx = -1, len = keys.length, out = {};
        while (++idx < len) {
            out[keys[idx]] = values[idx];
        }
        return out;
    });


    /**
     * Creates a new object out of a list key-value pairs.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [[k,v]] -> {k: v}
     * @param {Array} pairs An array of two-element arrays that will be the keys and values of the output object.
     * @return {Object} The object made by pairing up `keys` and `values`.
     * @example
     *
     *      R.fromPairs([['a', 1], ['b', 2],  ['c', 3]]); //=> {a: 1, b: 2, c: 3}
     */
    var fromPairs = R.fromPairs = function fromPairs(pairs) {
        var idx = -1, len = pairs.length, out = {};
        while (++idx < len) {
            if (_isArray(pairs[idx]) && pairs[idx].length) {
                out[pairs[idx][0]] = pairs[idx][1];
            }
        }
        return out;
    };


    /**
     * Creates an object containing a single key:value pair.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig String -> a -> {String:a}
     * @param {String} key
     * @param {*} val
     * @return {Object}
     * @example
     *
     *      var matchPhrases = R.compose(
     *          R.createMapEntry('must'),
     *          R.map(R.createMapEntry('match_phrase'))
     *      );
     *      matchPhrases(['foo', 'bar', 'baz']); //=> {must: [{match_phrase: 'foo'}, {match_phrase: 'bar'}, {match_phrase: 'baz'}]}
     */
    var createMapEntry = R.createMapEntry = _curry2(function(key, val) {
        var obj = {};
        obj[key] = val;
        return obj;
    });


    /**
     * Creates a lens. Supply a function to `get` values from inside an object, and a `set`
     * function to change values on an object. (n.b.: This can, and should, be done without
     * mutating the original object!) The lens is a function wrapped around the input `get`
     * function, with the `set` function attached as a property on the wrapper. A `map`
     * function is also attached to the returned function that takes a function to operate
     * on the specified (`get`) property, which is then `set` before returning.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig (k -> v) -> (v -> a -> *) -> (a -> b)
     * @param {Function} get A function that gets a value by property name
     * @param {Function} set A function that gets a value by property name
     * @return {Function} the returned function has `set` and `map` properties that are
     *     also functions.
     * @example
     *
     *     var headLens = R.lens(
     *         function get(arr) { return arr[0]; },
     *         function set(val, arr) { return [val].concat(arr.slice(1)); }
     *     );
     *     headLens([10, 20, 30, 40]); //=> 10
     *     headLens.set('mu', [10, 20, 30, 40]); //=> ['mu', 20, 30, 40]
     *     headLens.map(function(x) { return x + 1; }, [10, 20, 30, 40]); //=> [11, 20, 30, 40]
     *
     *     var phraseLens = R.lens(
     *         function get(obj) { return obj.phrase; },
     *         function set(val, obj) {
     *             var out = R.cloneObj(obj);
     *             out.phrase = val;
     *             return out;
     *         }
     *     );
     *     var obj1 = { phrase: 'Absolute filth . . . and I LOVED it!'};
     *     var obj2 = { phrase: "What's all this, then?"};
     *     phraseLens(obj1); // => 'Absolute filth . . . and I LOVED it!'
     *     phraseLens(obj2); // => "What's all this, then?"
     *     phraseLens.set('Ooh Betty', obj1); //=> { phrase: 'Ooh Betty'}
     *     phraseLens.map(R.toUpperCase, obj2); //=> { phrase: "WHAT'S ALL THIS, THEN?"}
     */
    R.lens = _curry2(function lens(get, set) {
        var lns = function(a) { return get(a); };
        lns.set = set;
        lns.map = function(fn, a) { return set(fn(get(a)), a); };
        return lns;
    });


    /**
     * Creates a new list out of the two supplied by creating each possible
     * pair from the lists.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig a -> b -> [[a,b]]
     * @param {Array} as The first list.
     * @param {Array} bs The second list.
     * @return {Array} The list made by combining each possible pair from
     * `as` and `bs` into pairs (`[a, b]`).
     * @example
     *
     *      R.xprod([1, 2], ['a', 'b']); //=> [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']]
     */
    R.xprod = _curry2(function xprod(a, b) { // = xprodWith(prepend); (takes about 3 times as long...)
        if (isEmpty(a) || isEmpty(b)) {
            return [];
        }
        var idx = -1;
        var ilen = a.length;
        var j;
        var jlen = b.length;
        // Better to push them all or to do `new Array(ilen * jlen)` and calculate indices?
        var result = [];
        while (++idx < ilen) {
            j = -1;
            while (++j < jlen) {
                result.push([a[idx], b[j]]);
            }
        }
        return result;
    });


    /**
     * Returns a new list with the same elements as the original list, just
     * in the reverse order.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig [a] -> [a]
     * @param {Array} list The list to reverse.
     * @return {Array} A copy of the list in reverse order.
     * @example
     *
     *      R.reverse([1, 2, 3]);  //=> [3, 2, 1]
     *      R.reverse([1, 2]);     //=> [2, 1]
     *      R.reverse([1]);        //=> [1]
     *      R.reverse([]);         //=> []
     */
    var reverse = R.reverse = function reverse(list) {
        var idx = -1, length = list.length;
        var pointer = length;
        var result = new Array(length);
        while (++idx < length) {
            result[--pointer] = list[idx];
        }
        return result;
    };


    /**
     * Returns a list of numbers from `from` (inclusive) to `to`
     * (exclusive).
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> Number -> [Number]
     * @param {Number} from The first number in the list.
     * @param {Number} to One more than the last number in the list.
     * @return {Array} The list of numbers in tthe set `[a, b)`.
     * @example
     *
     *      R.range(1, 5);    //=> [1, 2, 3, 4]
     *      R.range(50, 53);  //=> [50, 51, 52]
     */
    R.range = _curry2(function range(from, to) {
        if (from >= to) {
            return [];
        }
        var idx = 0, result = new Array(Math.floor(to) - Math.ceil(from));
        while (from < to) {
            result[idx++] = from++;
        }
        return result;
    });


    /**
     * Returns a string made by inserting the `separator` between each
     * element and concatenating all the elements into a single string.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig String -> [a] -> String
     * @param {Number|String} separator The string used to separate the elements.
     * @param {Array} xs The elements to join into a string.
     * @return {String} str The string made by concatenating `xs` with `separator`.
     * @example
     *
     *      var spacer = R.join(' ');
     *      spacer(['a', 2, 3.4]);   //=> 'a 2 3.4'
     *      R.join('|', [1, 2, 3]);    //=> '1|2|3'
     */
    R.join = invokerN(1, 'join');


    /**
     * Returns the elements from `xs` starting at `a` and ending at `b - 1`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> Number -> [a] -> [a]
     * @param {Number} a The starting index.
     * @param {Number} b One more than the ending index.
     * @param {Array} xs The list to take elements from.
     * @return {Array} The items from `a` to `b - 1` from `xs`.
     * @example
     *
     *      var xs = R.range(0, 10);
     *      R.slice(2, 5)(xs); //=> [2, 3, 4]
     */
    R.slice = invokerN(2, 'slice');


    /**
     * Returns the elements from `xs` starting at `a` going to the end of `xs`.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> [a] -> [a]
     * @param {Number} a The starting index.
     * @param {Array} xs The list to take elements from.
     * @return {Array} The items from `a` to the end of `xs`.
     * @example
     *
     *      var xs = R.range(0, 10);
     *      R.slice.from(2)(xs); //=> [2, 3, 4, 5, 6, 7, 8, 9]
     *
     *      var ys = R.range(4, 8);
     *      var tail = R.slice.from(1);
     *      tail(ys); //=> [5, 6, 7]
     */
    R.slice.from = _curry2(function(a, xs) {
        return xs.slice(a, xs.length);
    });

    /**
     * Removes the sub-list of `list` starting at index `start` and containing
     * `count` elements.  _Note that this is not destructive_: it returns a
     * copy of the list with the changes.
     * <small>No lists have been harmed in the application of this function.</small>
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> Number -> [a] -> [a]
     * @param {Number} start The position to start removing elements
     * @param {Number} count The number of elements to remove
     * @param {Array} list The list to remove from
     * @return {Array} a new Array with `count` elements from `start` removed
     * @example
     *
     *      R.remove(2, 3, [1,2,3,4,5,6,7,8]); //=> [1,2,6,7,8]
     */
    R.remove = _curry3(function remove(start, count, list) {
        return _concat(_slice(list, 0, Math.min(start, list.length)),
                       _slice(list, Math.min(list.length, start + count)));
    });


    /**
     * Inserts the supplied element into the list, at index `index`.  _Note
     * that this is not destructive_: it returns a copy of the list with the changes.
     * <small>No lists have been harmed in the application of this function.</small>
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> a -> [a] -> [a]
     * @param {Number} index The position to insert the element
     * @param {*} elt The element to insert into the Array
     * @param {Array} list The list to insert into
     * @return {Array} a new Array with `elt` inserted at `index`
     * @example
     *
     *      R.insert(2, 'x', [1,2,3,4]); //=> [1,2,'x',3,4]
     */
    R.insert = _curry3(function insert(idx, elt, list) {
        idx = idx < list.length && idx >= 0 ? idx : list.length;
        return _concat(_append(elt, _slice(list, 0, idx)), _slice(list, idx));
    });


    /**
     * Inserts the sub-list into the list, at index `index`.  _Note  that this
     * is not destructive_: it returns a copy of the list with the changes.
     * <small>No lists have been harmed in the application of this function.</small>
     *
     * @func
     * @memberOf R
     * @category List
     * @sig Number -> [a] -> [a] -> [a]
     * @param {Number} index The position to insert the sub-list
     * @param {Array} elts The sub-list to insert into the Array
     * @param {Array} list The list to insert the sub-list into
     * @return {Array} a new Array with `elts` inserted starting at `index`
     * @example
     *
     *      R.insert.all(2, ['x','y','z'], [1,2,3,4]); //=> [1,2,'x','y','z',3,4]
     */
    R.insert.all = _curry3(function insertAll(idx, elts, list) {
        idx = idx < list.length && idx >= 0 ? idx : list.length;
        return _concat(_concat(_slice(list, 0, idx), elts), _slice(list, idx));
    });


    /**
     * Makes a comparator function out of a function that reports whether the first element is less than the second.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a, b -> Boolean) -> (a, b -> Number)
     * @param {Function} pred A predicate function of arity two.
     * @return {Function} a Function :: a -> b -> Int that returns `-1` if a < b, `1` if b < a, otherwise `0`
     * @example
     *
     *      var cmp = R.comparator(function(a, b) {
     *        return a.age < b.age;
     *      });
     *      var people = [
     *        // ...
     *      ];
     *      R.sort(cmp, people);
     */
    var comparator = R.comparator = function comparator(pred) {
        return function(a, b) {
            return pred(a, b) ? -1 : pred(b, a) ? 1 : 0;
        };
    };


    /**
     * Returns a copy of the list, sorted according to the comparator function, which should accept two values at a
     * time and return a negative number if the first value is smaller, a positive number if it's larger, and zero
     * if they are equal.  Please note that this is a **copy** of the list.  It does not modify the original.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a,a -> Number) -> [a] -> [a]
     * @param {Function} comparator A sorting function :: a -> b -> Int
     * @param {Array} list The list to sort
     * @return {Array} a new array with its elements sorted by the comparator function.
     * @example
     *
     *      var diff = function(a, b) { return a - b; };
     *      R.sort(diff, [4,2,7,5]); //=> [2, 4, 5, 7]
     */
    R.sort = _curry2(function sort(comparator, list) {
        return clone(list).sort(comparator);
    });


    /**
     * Splits a list into sub-lists stored in an object, based on the result of calling a String-returning function
     * on each element, and grouping the results according to values returned.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> s) -> [a] -> {s: a}
     * @param {Function} fn Function :: a -> String
     * @param {Array} list The array to group
     * @return {Object} An object with the output of `fn` for keys, mapped to arrays of elements
     *         that produced that key when passed to `fn`.
     * @example
     *
     *     var byGrade = R.groupBy(function(student) {
     *       var score = student.score;
     *       return (score < 65) ? 'F' : (score < 70) ? 'D' :
     *              (score < 80) ? 'C' : (score < 90) ? 'B' : 'A';
     *     });
     *     var students = [{name: 'Abby', score: 84},
     *                     {name: 'Eddy', score: 58},
     *                     // ...
     *                     {name: 'Jack', score: 69}];
     *     byGrade(students);
     *     // {
     *     //   'A': [{name: 'Dianne', score: 99}],
     *     //   'B': [{name: 'Abby', score: 84}]
     *     //   // ...,
     *     //   'F': [{name: 'Eddy', score: 58}]
     *     // }
     */
    var groupBy = R.groupBy = _curry2(function groupBy(fn, list) {
        return reduce(function(acc, elt) {
            var key = fn(elt);
            acc[key] = _append(elt, acc[key] || (acc[key] = []));
            return acc;
        }, {}, list);
    });


    /**
     * Takes a predicate and a list and returns the pair of lists of
     * elements which do and do not satisfy the predicate, respectively.
     *
     * @func
     * @memberOf R
     * @category List
     * @sig (a -> Boolean) -> [a] -> [[a],[a]]
     * @param {Function} pred A predicate to determine which array the element belongs to.
     * @param {Array} list The array to partition.
     * @return {Array} A nested array, containing first an array of elements that satisfied the predicate,
     *                 and second an array of elements that did not satisfy.
     * @example
     *
     *      R.partition(R.contains('s'), ['sss', 'ttt', 'foo', 'bars']);
     *      //=> [ [ 'sss', 'bars' ],  [ 'ttt', 'foo' ] ]
     */
    R.partition = _curry2(function partition(pred, list) {
        return reduce(function(acc, elt) {
            acc[pred(elt) ? 0 : 1].push(elt);
            return acc;
        }, [[], []], list);
    });




    // Object Functions
    // ----------------
    //
    // These functions operate on plain Javascript object, adding simple functions to test properties on these
    // objects.  Many of these are of most use in conjunction with the list functions, operating on lists of
    // objects.

    // --------

    /**
     * Runs the given function with the supplied object, then returns the object.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig (a -> *) -> a -> a
     * @param {Function} fn The function to call with `x`. The return value of `fn` will be thrown away.
     * @param {*} x
     * @return {*} x
     * @example
     *
     *      var sayX = function(x) { console.log('x is ' + x); };
     *      R.tap(sayX, 100); //=> 100
     *      //-> 'x is 100')
     */
    R.tap = _curry2(function tap(fn, x) {
        fn(x);
        return x;
    });


    /**
     * Tests if two items are equal.  Equality is strict here, meaning reference equality for objects and
     * non-coercing equality for primitives.
     *
     * @func
     * @memberOf R
     * @category Relation
     * @sig a -> b -> Boolean
     * @param {*} a
     * @param {*} b
     * @return {Boolean}
     * @example
     *
     *      var o = {};
     *      R.eq(o, o); //=> true
     *      R.eq(o, {}); //=> false
     *      R.eq(1, 1); //=> true
     *      R.eq(1, '1'); //=> false
     */
    R.eq = _curry2(function eq(a, b) { return a === b; });


    /**
     * Returns a function that when supplied an object returns the indicated property of that object, if it exists.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig s -> {s: a} -> a
     * @param {String} p The property name
     * @param {Object} obj The object to query
     * @return {*} The value at obj.p
     * @example
     *
     *      R.prop('x', {x: 100}); //=> 100
     *      R.prop('x', {}); //=> undefined
     *
     *      var fifth = R.prop(4); // indexed from 0, remember
     *      fifth(['Bashful', 'Doc', 'Dopey', 'Grumpy', 'Happy', 'Sleepy', 'Sneezy']);
     *      //=> 'Happy'
     */
    var prop = R.prop = function prop(p, obj) {
        switch (arguments.length) {
            case 0: throw _noArgsException();
            case 1: return function _prop(obj) { return obj[p]; };
        }
        return obj[p];
    };

    /**
     * @func
     * @memberOf R
     * @category Object
     * @see R.prop
     */
    R.get = prop;


    /**
     * Returns the value at the specified property.
     * The only difference from `prop` is the parameter order.
     *
     * @func
     * @memberOf R
     * @see R.prop
     * @category Object
     * @sig {k: v} -> k -> v
     * @param {Object} obj The object to query
     * @param {String} p The property name
     * @return {*} The value at obj.p
     * @example
     *
     *      R.propOf({x: 100}, 'x'); //=> 100
     */
    R.propOf = flip(prop);


    /**
     * Acts as multiple `get`: array of keys in, array of values out. Preserves order.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig [k] -> {k: v} -> [v]
     * @param {Array} ps The property names to fetch
     * @param {Object} obj The object to query
     * @return {Array} The corresponding values or partially applied function
     * @example
     *
     *      R.props(['x', 'y'], {x: 1, y: 2}); //=> [1, 2]
     *      R.props(['c', 'a', 'b'], {b: 2, a: 1}); //=> [undefined, 1, 2]
     *
     *      var fullName = R.compose(R.join(' '), R.props(['first', 'last']));
     *      fullName({last: 'Bullet-Tooth', age: 33, first: 'Tony'}); //=> 'Tony Bullet-Tooth'
     */
    R.props = _curry2(function props(ps, obj) {
        var len = ps.length,
            out = new Array(len),
            idx = -1;

        while (++idx < len) {
            out[idx] = obj[ps[idx]];
        }

        return out;
    });


    /**
     * An internal reference to `Object.prototype.hasOwnProperty`
     * @private
     */
    var _hasOwnProperty = Object.prototype.hasOwnProperty;


    /**
     * If the given object has an own property with the specified name,
     * returns the value of that property.
     * Otherwise returns the provided default value.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig s -> v -> {s: x} -> x | v
     * @param {String} p The name of the property to return.
     * @param {*} val The default value.
     * @param {Object} obj The object to query.
     * @returns {*} The value of given property or default value.
     * @example
     *
     *      var alice = {
     *        name: 'ALICE',
     *        age: 101
     *      };
     *      var favorite = R.prop('favoriteLibrary');
     *      var favoriteWithDefault = R.propOr('favoriteLibrary', 'Ramda');
     *
     *      favorite(alice);  //=> undefined
     *      favoriteWithDefault(alice);  //=> 'Ramda'
     */
    R.propOr = _curry3(function propOr(p, val, obj) {
        return _hasOwnProperty.call(obj, p) ? obj[p] : val;
    });

    /**
     * Returns whether or not an object has an own property with
     * the specified name
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig s -> {s: x} -> Boolean
     * @param {String} prop The name of the property to check for.
     * @param {Object} obj The object to query.
     * @return {Boolean} Whether the property exists.
     * @example
     *
     *      var obj = {
     *        foo: 1,
     *        bar: 2,
     *      };
     *      R.has('foo', obj);  //=> true
     *
     *      var list = [{foo: 1}, {foo: 2}, {bar: 3}];
     *      R.filter(R.has('foo'), list);  //=> [{foo: 1}, {foo: 2}]
     */
    R.has = _curry2(function(prop, obj) {
        return _hasOwnProperty.call(obj, prop);
    });

    /**
     * Returns whether or not an object or its prototype chain has
     * a property with the specified name
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig s -> {s: x} -> Boolean
     * @param {String} prop The name of the property to check for.
     * @param {Object} obj The object to query.
     * @return {Boolean} Whether the property exists.
     * @example
     *
     *      function Rectangle(width, height) {
     *          this.width = width;
     *          this.height = height;
     *      }
     *      Rectangle.prototype.area = function() {
     *          return this.width * this.height;
     *      };
     *
     *      var square = new Rectangle(2, 2);
     *      R.hasIn('width', square);  //=> true
     *      R.hasIn('area', square);  //=> true
     */
    R.hasIn = _curry2(function(prop, obj) {
        return prop in obj;
    });

    /**
     * Calls the specified function on the supplied object. Any additional arguments
     * after `fn` and `obj` are passed in to `fn`. If no additional arguments are passed to `func`,
     * `fn` is invoked with no arguments.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig k -> {k : v} -> v(*)
     * @param {String} funcName The name of the property mapped to the function to invoke
     * @param {Object} obj The object
     * @return {*} The value of invoking `obj.fn`
     * @example
     *
     *      R.func('add', R, 1, 2); //=> 3
     *
     *      var obj = { f: function() { return 'f called'; } };
     *      R.func('f', obj); //=> 'f called'
     */
    R.func = function func(funcName, obj) {
        switch (arguments.length) {
            case 0: throw _noArgsException();
            case 1: return function(obj) { return obj[funcName].apply(obj, _slice(arguments, 1)); };
            default: return obj[funcName].apply(obj, _slice(arguments, 2));
        }
    };


    /**
     * Returns a function that always returns the given value.
     *
     * @func
     * @memberOf R
     * @category Function
     * @sig a -> (* -> a)
     * @param {*} val The value to wrap in a function
     * @return {Function} A Function :: * -> val
     * @example
     *
     *      var t = R.always('Tee');
     *      t(); //=> 'Tee'
     */
    var always = R.always = function always(val) {
        return function() {
            return val;
        };
    };


    /**
     * Creates a function that is bound to a context.
     * Note: `R.bind` does not provide the additional argument-binding capabilities of
     * [Function.prototype.bind](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind).
     *
     * @func
     * @memberOf R
     * @category Function
     * @category Object
     * @sig (* -> *) -> {*} -> (* -> *)
     * @param {Function} fn The function to bind to context
     * @param {Object} thisObj The context to bind `fn` to
     * @return {Function} A function that will execute in the context of `thisObj`
     */
    R.bind = _curry2(function bind(fn, thisObj) {
        return function() {
            return fn.apply(thisObj, arguments);
        };
    });

    /**
     * Returns a list containing the names of all the enumerable own
     * properties of the supplied object.
     * Note that the order of the output array is not guaranteed to be
     * consistent across different JS platforms.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> [k]
     * @param {Object} obj The object to extract properties from
     * @return {Array} An array of the object's own properties
     * @example
     *
     *      R.keys({a: 1, b: 2, c: 3}); //=> ['a', 'b', 'c']
     */
    var keys = R.keys = (function() {
        // cover IE < 9 keys issues
        var hasEnumBug = !({toString: null}).propertyIsEnumerable('toString');
        var nonEnumerableProps = ['constructor', 'valueOf', 'isPrototypeOf', 'toString',
                                  'propertyIsEnumerable', 'hasOwnProperty', 'toLocaleString'];

        return function keys(obj) {
            if (Object(obj) !== obj) {
                return [];
            }
            if (Object.keys) {
                return Object.keys(obj);
            }
            var prop, ks = [], nIdx;
            for (prop in obj) {
                if (_hasOwnProperty.call(obj, prop)) {
                    ks.push(prop);
                }
            }
            if (hasEnumBug) {
                nIdx = nonEnumerableProps.length;
                while (nIdx--) {
                    prop = nonEnumerableProps[nIdx];
                    if (_hasOwnProperty.call(obj, prop) && !_contains(prop, ks)) {
                        ks.push(prop);
                    }
                }
            }
            return ks;
        };
    }());


    /**
     * Returns a list containing the names of all the
     * properties of the supplied object, including prototype properties.
     * Note that the order of the output array is not guaranteed to be
     * consistent across different JS platforms.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> [k]
     * @param {Object} obj The object to extract properties from
     * @return {Array} An array of the object's own and prototype properties
     * @example
     *
     *      var F = function() { this.x = 'X'; };
     *      F.prototype.y = 'Y';
     *      var f = new F();
     *      R.keysIn(f); //=> ['x', 'y']
     */
    var keysIn = R.keysIn = function keysIn(obj) {
        var prop, ks = [];
        for (prop in obj) {
            ks.push(prop);
        }
        return ks;
    };


    /**
     * @private
     * @param {Function} fn The strategy for extracting keys from an object
     * @return {Function} A function that takes an object and returns an array of
     *                    key-value arrays.
     */
    function _pairWith(fn) {
        return function(obj) {
            return _map(function(key) { return [key, obj[key]]; }, fn(obj));
        };
    }


    /**
     * Converts an object into an array of key, value arrays.
     * Only the object's own properties are used.
     * Note that the order of the output array is not guaranteed to be
     * consistent across different JS platforms.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> [[k,v]]
     * @param {Object} obj The object to extract from
     * @return {Array} An array of key, value arrays from the object's own properties
     * @example
     *
     *      R.toPairs({a: 1, b: 2, c: 3}); //=> [['a', 1], ['b', 2], ['c', 3]]
     */
    R.toPairs = _pairWith(keys);


    /**
     * Converts an object into an array of key, value arrays.
     * The object's own properties and prototype properties are used.
     * Note that the order of the output array is not guaranteed to be
     * consistent across different JS platforms.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> [[k,v]]
     * @param {Object} obj The object to extract from
     * @return {Array} An array of key, value arrays from the object's own
     *         and prototype properties
     * @example
     *
     *      var F = function() { this.x = 'X'; };
     *      F.prototype.y = 'Y';
     *      var f = new F();
     *      R.toPairsIn(f); //=> [['x','X'], ['y','Y']]
     */
    R.toPairsIn = _pairWith(keysIn);


    /**
     * Returns a list of all the enumerable own properties of the supplied object.
     * Note that the order of the output array is not guaranteed across
     * different JS platforms.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> [v]
     * @param {Object} obj The object to extract values from
     * @return {Array} An array of the values of the object's own properties
     * @example
     *
     *      R.values({a: 1, b: 2, c: 3}); //=> [1, 2, 3]
     */
    R.values = function values(obj) {
        var props = keys(obj);
        var len = props.length;
        var vals = new Array(len);
        var idx = -1;
        while (++idx < len) {
            vals[idx] = obj[props[idx]];
        }
        return vals;
    };


    /**
     * Returns a list of all the properties, including prototype properties,
     * of the supplied object.
     * Note that the order of the output array is not guaranteed to be
     * consistent across different JS platforms.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> [v]
     * @param {Object} obj The object to extract values from
     * @return {Array} An array of the values of the object's own and prototype properties
     * @example
     *
     *      var F = function() { this.x = 'X'; };
     *      F.prototype.y = 'Y';
     *      var f = new F();
     *      R.valuesIn(f); //=> ['X', 'Y']
     */
    R.valuesIn = function valuesIn(obj) {
        var prop, vs = [];
        for (prop in obj) {
            vs.push(obj[prop]);
        }
        return vs;
    };


    /**
     * Internal helper function for making a partial copy of an object
     *
     * @private
     *
     */
    // TODO: document, even for internals...
    function _pickBy(test, obj) {
        var copy = {};
        var prop;
        var props = keysIn(obj);
        var len = props.length;
        var idx = -1;
        while (++idx < len) {
            prop = props[idx];
            if (test(obj[prop], prop, obj)) {
                copy[prop] = obj[prop];
            }
        }
        return copy;
    }


    /**
     * Returns a partial copy of an object containing only the keys specified.  If the key does not exist, the
     * property is ignored.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig [k] -> {k: v} -> {k: v}
     * @param {Array} names an array of String property names to copy onto a new object
     * @param {Object} obj The object to copy from
     * @return {Object} A new object with only properties from `names` on it.
     * @example
     *
     *      R.pick(['a', 'd'], {a: 1, b: 2, c: 3, d: 4}); //=> {a: 1, d: 4}
     *      R.pick(['a', 'e', 'f'], {a: 1, b: 2, c: 3, d: 4}); //=> {a: 1}
     */
    R.pick = _curry2(function pick(names, obj) {
        return _pickBy(function(val, key) {
            return _contains(key, names);
        }, obj);
    });


    /**
     * Returns a partial copy of an object omitting the keys specified.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig [k] -> {k: v} -> {k: v}
     * @param {Array} names an array of String property names to omit from the new object
     * @param {Object} obj The object to copy from
     * @return {Object} A new object with properties from `names` not on it.
     * @example
     *
     *      R.omit(['a', 'd'], {a: 1, b: 2, c: 3, d: 4}); //=> {b: 2, c: 3}
     */
    R.omit = _curry2(function omit(names, obj) {
        return _pickBy(function(val, key) {
            return !_contains(key, names);
        }, obj);
    });


    /**
     * Returns a partial copy of an object containing only the keys that
     * satisfy the supplied predicate.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig (v, k -> Boolean) -> {k: v} -> {k: v}
     * @param {Function} pred A predicate to determine whether or not a key
     *        should be included on the output object.
     * @param {Object} obj The object to copy from
     * @return {Object} A new object with only properties that satisfy `pred`
     *         on it.
     * @see R.pick
     * @example
     *
     *      var isUpperCase = function(val, key) { return key.toUpperCase() === key; }
     *      R.pickBy(isUpperCase, {a: 1, b: 2, A: 3, B: 4}); //=> {A: 3, B: 4}
     */
    R.pickBy = _curry2(_pickBy);


    /**
     * Internal implementation of `pickAll`
     *
     * @private
     * @see R.pickAll
     */
    // TODO: document, even for internals...
    function _pickAll(names, obj) {
        var copy = {};
        forEach(function(name) {
            copy[name] = obj[name];
        }, names);
        return copy;
    }


    /**
     * Similar to `pick` except that this one includes a `key: undefined` pair for properties that don't exist.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig [k] -> {k: v} -> {k: v}
     * @param {Array} names an array of String property names to copy onto a new object
     * @param {Object} obj The object to copy from
     * @return {Object} A new object with only properties from `names` on it.
     * @see R.pick
     * @example
     *
     *      R.pickAll(['a', 'd'], {a: 1, b: 2, c: 3, d: 4}); //=> {a: 1, d: 4}
     *      R.pickAll(['a', 'e', 'f'], {a: 1, b: 2, c: 3, d: 4}); //=> {a: 1, e: undefined, f: undefined}
     */
    var pickAll = R.pickAll = _curry2(_pickAll);


    /**
     * Assigns own enumerable properties of the other object to the destination
     * object preferring items in other.
     *
     * @private
     * @memberOf R
     * @category Object
     * @param {Object} destination The destination object.
     * @param {Object} other The other object to merge with destination.
     * @returns {Object} Returns the destination object.
     * @example
     *
     *      _extend({ 'name': 'fred', 'age': 10 }, { 'age': 40 });
     *      //=> { 'name': 'fred', 'age': 40 }
     */
    function _extend(destination, other) {
        var props = keys(other),
            idx = -1, length = props.length;
        while (++idx < length) {
            destination[props[idx]] = other[props[idx]];
        }
        return destination;
    }


    /**
     * Create a new object with the own properties of a
     * merged with the own properties of object b.
     * This function will *not* mutate passed-in objects.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> {k: v} -> {k: v}
     * @param {Object} a source object
     * @param {Object} b object with higher precedence in output
     * @returns {Object} Returns the destination object.
     * @example
     *
     *      R.mixin({ 'name': 'fred', 'age': 10 }, { 'age': 40 });
     *      //=> { 'name': 'fred', 'age': 40 }
     */
    R.mixin = _curry2(function mixin(a, b) {
        return _extend(_extend({}, a), b);
    });


    /**
     * Creates a shallow copy of an object's own properties.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {*} -> {*}
     * @param {Object} obj The object to clone
     * @returns {Object} A new object
     * @example
     *
     *     R.cloneObj({a: 1, b: 2, c: [1, 2, 3]}); // {a: 1, b: 2, c: [1, 2, 3]}
     */
    R.cloneObj = function(obj) {
        return _extend({}, obj);
    };


    /**
     * Reports whether two objects have the same value for the specified property.  Useful as a curried predicate.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig k -> {k: v} -> {k: v} -> Boolean
     * @param {String} prop The name of the property to compare
     * @param {Object} obj1
     * @param {Object} obj2
     * @return {Boolean}
     *
     * @example
     *
     *      var o1 = { a: 1, b: 2, c: 3, d: 4 };
     *      var o2 = { a: 10, b: 20, c: 3, d: 40 };
     *      R.eqProps('a', o1, o2); //=> false
     *      R.eqProps('c', o1, o2); //=> true
     */
    R.eqProps = _curry3(function eqProps(prop, obj1, obj2) {
        return obj1[prop] === obj2[prop];
    });


    /**
     * internal helper for `where`
     *
     * @private
     * @see R.where
     */
    function _satisfiesSpec(spec, parsedSpec, testObj) {
        if (spec === testObj) { return true; }
        if (testObj == null) { return false; }
        parsedSpec.fn = parsedSpec.fn || [];
        parsedSpec.obj = parsedSpec.obj || [];
        var key, val, idx = -1, fnLen = parsedSpec.fn.length, j = -1, objLen = parsedSpec.obj.length;
        while (++idx < fnLen) {
            key = parsedSpec.fn[idx];
            val = spec[key];
            if (!(key in testObj)) {
                return false;
            }
            if (!val(testObj[key], testObj)) {
                return false;
            }
        }
        while (++j < objLen) {
            key = parsedSpec.obj[j];
            if (spec[key] !== testObj[key]) {
                return false;
            }
        }
        return true;
    }


    /**
     * Takes a spec object and a test object and returns true if the test satisfies the spec.
     * Any property on the spec that is not a function is interpreted as an equality
     * relation.
     *
     * If the spec has a property mapped to a function, then `where` evaluates the function, passing in
     * the test object's value for the property in question, as well as the whole test object.
     *
     * `where` is well suited to declaratively expressing constraints for other functions, e.g.,
     * `filter`, `find`, `pickBy`, etc.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {k: v} -> {k: v} -> Boolean
     * @param {Object} spec
     * @param {Object} testObj
     * @return {Boolean}
     * @example
     *
     *      var spec = {x: 2};
     *      R.where(spec, {w: 10, x: 2, y: 300}); //=> true
     *      R.where(spec, {x: 1, y: 'moo', z: true}); //=> false
     *
     *      var spec2 = {x: function(val, obj) { return  val + obj.y > 10; }};
     *      R.where(spec2, {x: 2, y: 7}); //=> false
     *      R.where(spec2, {x: 3, y: 8}); //=> true
     *
     *      var xs = [{x: 2, y: 1}, {x: 10, y: 2}, {x: 8, y: 3}, {x: 10, y: 4}];
     *      R.filter(R.where({x: 10}), xs); // ==> [{x: 10, y: 2}, {x: 10, y: 4}]
     */
    R.where = function where(spec, testObj) {
        var parsedSpec = groupBy(function(key) {
            return typeof spec[key] === 'function' ? 'fn' : 'obj';
        }, keys(spec));

        switch (arguments.length) {
            case 0: throw _noArgsException();
            case 1:
                return function(testObj) {
                    return _satisfiesSpec(spec, parsedSpec, testObj);
                };
        }
        return _satisfiesSpec(spec, parsedSpec, testObj);
    };


    /**
     * Makes a shallow clone of an object, setting or overriding the specified
     * property with the given value.  Note that this copies and flattens
     * prototype properties onto the new object as well.  All non-primitive
     * properties are copied by reference.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig String -> a -> {k: v} -> {k: v}
     * @param {String} prop the property name to set
     * @param {*} val the new value
     * @param {Object} obj the object to clone
     * @return {Object} a new object similar to the original except for the specified property
     * @example
     *
     *      var obj1 = {a: 1, b: {c: 2, d: 3}, e: 4, f: 5};
     *      var obj2 = R.assoc('e', {x: 42}, obj1);
     *      //=>  {a: 1, b: {c: 2, d: 3}, e: {x: 42}, f: 5}
     *
     *      // And moreover, obj2.b is a reference to obj1.b
     *      // No unnecessary objects are created.
     */
    var assoc = R.assoc = _curry3(function(prop, val, obj) {
        // rather than `clone` to get prototype props too, even though they're flattened
        return _extend(fromPairs(_map(function(key) {
            return [key, obj[key]];
        }, keysIn(obj))), createMapEntry(prop, val));
    });


    /**
     * Makes a shallow clone of an object, setting or overriding the nodes
     * required to create the given path, and placing the specifiec value at the
     * tail end of that path.  Note that this copies and flattens prototype
     * properties onto the new object as well.  All non-primitive properties
     * are copied by reference.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig String -> a -> {k: v} -> {k: v}
     * @param {String} path the dot-delimited path to set
     * @param {*} val the new value
     * @param {Object} obj the object to clone
     * @return {Object} a new object similar to the original except along the specified path
     * @example
     *
     *      var obj1 = {a: {b: 1, c: 2, d: {e: 3}}, f: {g: {h: 4, i: 5, j: {k: 6, l: 7}}}, m: 8};
     *      var obj2 = R.assocPath('f.g.i', {x: 42}, obj1);
     *      //=> {a: {b: 1, c: 2, d: {e: 3}}, f: {g: {h: 4, i: {x: 42}, j: {k: 6, l: 7}}}, m: 8}
     */
    R.assocPath = (function() {
        // TODO: consider exposing this (with a better name.)
        var setParts = function(parts, val, obj) {
            // TODO: empty path
            if (parts.length === 1) {return assoc(parts[0], val, obj);}
            var current = obj[parts[0]];
            return assoc(parts[0], setParts(_slice(parts, 1), val, is(Object, current) ? current : {}), obj);
        };
        return function(path, val, obj) {
            var length = arguments.length;
            if (length === 0) {
                throw _noArgsException();
            }
            var parts = split('.', path);
            var fn = _curry2(function(val, obj) {
                return setParts(parts, val, obj);
            });
            switch (length) {
                case 1: return fn;
                case 2: return fn(val);
                default: return fn(val, obj);
            }
        };
    }());


    // Miscellaneous Functions
    // -----------------------
    //
    // A few functions in need of a good home.

    // --------

    /**
     * Expose the functions from ramda as properties of another object.
     * If the provided object is the global object then the ramda
     * functions become global functions.
     * Warning: This function *will* mutate the object provided.
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig -> {*} -> {*}
     * @param {Object} obj The object to attach ramda functions
     * @return {Object} a reference to the mutated object
     * @example
     *
     *      var x = {}
     *      R.installTo(x); // x now contains ramda functions
     *      R.installTo(this); // add ramda functions to `this` object
     */
    R.installTo = function(obj) {
        return _extend(obj, R);
    };


    /**
     * See if an object (`val`) is an instance of the supplied constructor.
     * This function will check up the inheritance chain, if any.
     *
     * @func
     * @memberOf R
     * @category type
     * @sig (* -> {*}) -> a -> Boolean
     * @param {Object} ctor A constructor
     * @param {*} val The value to test
     * @return {Boolean}
     * @example
     *
     *      R.is(Object, {}); //=> true
     *      R.is(Number, 1); //=> true
     *      R.is(Object, 1); //=> false
     *      R.is(String, 's'); //=> true
     *      R.is(String, new String('')); //=> true
     *      R.is(Object, new String('')); //=> true
     *      R.is(Object, 's'); //=> false
     *      R.is(Number, {}); //=> false
     */
    var is = R.is = _curry2(function is(Ctor, val) {
        return val != null && val.constructor === Ctor || val instanceof Ctor;
    });

    /**
     * Gives a single-word string description of the (native) type of a value, returning such
     * answers as 'Object', 'Number', 'Array', or 'Null'.  Does not attempt to distinguish user
     * Object types any further, reporting them all as 'Object'.
     *
     * @func
     * @memberOf R
     * @category type
     * @sig (* -> {*}) -> String
     * @param {*} val The value to test
     * @return {String}
     * @example
     *
     *      R.type({}); //=> "Object"
     *      R.type(1); //=> "Number"
     *      R.type(false); //=> "Boolean"
     *      R.type('s'); //=> "String"
     *      R.type(null); //=> "Null"
     *      R.type([]); //=> "Array"
     *      R.type(/[A-z]/); //=> "RegExp"
     */
    R.type = function type(val) {
        return val === null      ? 'Null'      :
               val === undefined ? 'Undefined' :
               toString.call(val).slice(8, -1);
    };

    /**
     * A function that always returns `0`. Any passed in parameters are ignored.
     *
     * @func
     * @memberOf R
     * @category function
     * @sig * -> 0
     * @see R.always
     * @return {Number} 0. Always zero.
     * @example
     *
     *      R.alwaysZero(); //=> 0
     */
    R.alwaysZero = always(0);


    /**
     * A function that always returns `false`. Any passed in parameters are ignored.
     *
     * @func
     * @memberOf R
     * @category function
     * @sig * -> false
     * @see R.always
     * @return {Boolean} false
     * @example
     *
     *      R.alwaysFalse(); //=> false
     */
    R.alwaysFalse = always(false);


    /**
     * A function that always returns `true`. Any passed in parameters are ignored.
     *
     * @func
     * @memberOf R
     * @category function
     * @sig * -> true
     * @see R.always
     * @return {Boolean} true
     * @example
     *
     *      R.alwaysTrue(); //=> true
     */
    R.alwaysTrue = always(true);



    // Logic Functions
    // ---------------
    //
    // These functions are very simple wrappers around the built-in logical operators, useful in building up
    // more complex functional forms.

    // --------

    /**
     *
     * A function wrapping calls to the two functions in an `&&` operation, returning `true` or `false`.  Note that
     * this is short-circuited, meaning that the second function will not be invoked if the first returns a false-y
     * value.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig (*... -> Boolean) -> (*... -> Boolean) -> (*... -> Boolean)
     * @param {Function} f a predicate
     * @param {Function} g another predicate
     * @return {Function} a function that applies its arguments to `f` and `g` and ANDs their outputs together.
     * @example
     *
     *      var gt10 = function(x) { return x > 10; };
     *      var even = function(x) { return x % 2 === 0 };
     *      var f = R.and(gt10, even);
     *      f(100); //=> true
     *      f(101); //=> false
     */
    R.and = _curry2(function and(f, g) {
        return function _and() {
            return f.apply(this, arguments) && g.apply(this, arguments);
        };
    });


    /**
     * A function wrapping calls to the two functions in an `||` operation, returning `true` or `false`.  Note that
     * this is short-circuited, meaning that the second function will not be invoked if the first returns a truth-y
     * value.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig (*... -> Boolean) -> (*... -> Boolean) -> (*... -> Boolean)
     * @param {Function} f a predicate
     * @param {Function} g another predicate
     * @return {Function} a function that applies its arguments to `f` and `g` and ORs their outputs together.
     * @example
     *
     *      var gt10 = function(x) { return x > 10; };
     *      var even = function(x) { return x % 2 === 0 };
     *      var f = R.or(gt10, even);
     *      f(101); //=> true
     *      f(8); //=> true
     */
    R.or = _curry2(function or(f, g) {
        return function _or() {
            return f.apply(this, arguments) || g.apply(this, arguments);
        };
    });


    /**
     * A function wrapping a call to the given function in a `!` operation.  It will return `true` when the
     * underlying function would return a false-y value, and `false` when it would return a truth-y one.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig (*... -> Boolean) -> (*... -> Boolean)
     * @param {Function} f a predicate
     * @return {Function} a function that applies its arguments to `f` and logically inverts its output.
     * @example
     *
     *      var gt10 = function(x) { return x > 10; };
     *      var f = R.not(gt10);
     *      f(11); //=> false
     *      f(9); //=> true
     */
    var not = R.not = function not(f) {
        return function() {return !f.apply(this, arguments);};
    };


    /**
     * Create a predicate wrapper which will call a pick function (all/any) for each predicate
     *
     * @private
     * @see R.every
     * @see R.some
     */
    // TODO: document, even for internals...
    function _predicateWrap(predPicker) {
        return function(preds /* , args */) {
            var predIterator = function() {
                var args = arguments;
                return predPicker(function(predicate) {
                    return predicate.apply(null, args);
                }, preds);
            };
            return arguments.length > 1 ?
                    // Call function immediately if given arguments
                    predIterator.apply(null, _slice(arguments, 1)) :
                    // Return a function which will call the predicates with the provided arguments
                    arity(max(pluck('length', preds)), predIterator);
        };
    }


    /**
     * Given a list of predicates, returns a new predicate that will be true exactly when all of them are.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig [(*... -> Boolean)] -> (*... -> Boolean)
     * @param {Array} list An array of predicate functions
     * @param {*} optional Any arguments to pass into the predicates
     * @return {Function} a function that applies its arguments to each of
     *         the predicates, returning `true` if all are satisfied.
     * @example
     *
     *      var gt10 = function(x) { return x > 10; };
     *      var even = function(x) { return x % 2 === 0};
     *      var f = R.allPredicates([gt10, even]);
     *      f(11); //=> false
     *      f(12); //=> true
     */
    R.allPredicates = _predicateWrap(every);


    /**
     * Given a list of predicates returns a new predicate that will be true exactly when any one of them is.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig [(*... -> Boolean)] -> (*... -> Boolean)
     * @param {Array} list An array of predicate functions
     * @param {*} optional Any arguments to pass into the predicates
     * @return {Function}  a function that applies its arguments to each of the predicates, returning
     *                   `true` if all are satisfied..
     * @example
     *
     *      var gt10 = function(x) { return x > 10; };
     *      var even = function(x) { return x % 2 === 0};
     *      var f = R.anyPredicates([gt10, even]);
     *      f(11); //=> true
     *      f(8); //=> true
     *      f(9); //=> false
     */
    R.anyPredicates = _predicateWrap(some);

    /**
     * Creates a function that will process either the `onTrue` or the `onFalse` function depending
     * upon the result of the `condition` predicate.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig (*... -> Boolean) -> (*... -> *) -> (*... -> *) -> (*... -> *)
     * @param {Function} condition A condition function
     * @param {Function} onTrue A predicate to invoke when the condition evaluates to a truthy value
     * @param {Function} onFalse A predicate to invoke when the condition evaluates to a falsy value
     * @returns {Function} a function that validates the arguments before executing "truthy"
     *                     predicate or the the "falsey" predicate.
     * @example
     *
     *      // Flatten all arrays in the list and return whatever is not an array
     *      var flattenArrays = R.map(R.ifElse(Array.isArray, R.flatten, R.identity));
     *
     *      flattenArrays([[0], [[10], [8]], 1234, {}]); //=> [[0], [10, 8], 1234, {}]
     *      flattenArrays([[[10], 123], [8, [10]], "hello"]); //=> [[10, 123], [8, 10], "hello"]
     */
    var ifElse = R.ifElse = _curry3(function ifElse(condition, onTrue, onFalse) {
        return function _ifElse() {
            return condition.apply(this, arguments) ? onTrue.apply(this, arguments) : onFalse.apply(this, arguments);
        };
    });

    /**
     * This function can safely be referenced as `R.if` in some environments
     * (e.g. Node.js) or when writing code in a language which transcompiles
     * to JavaScript. In such situations, `R.if` is the preferred name.
     *
     * @func
     * @memberOf R
     * @category Core
     * @see R.ifElse
     */
    R['if'] = ifElse;


    /**
     * Returns a function, `fn`, which encapsulates if/else-if/else logic.
     * Each argument to `R.cond` is a [predicate, transform] pair. All of
     * the arguments to `fn` are applied to each of the predicates in turn
     * until one returns a "truthy" value, at which point `fn` returns the
     * result of applying its arguments to the corresponding transformer.
     * If none of the predicates matches, `fn` returns undefined.
     *
     * @func
     * @memberOf R
     * @category logic
     * @sig [(*... -> Boolean),(*... -> *)]... -> (*... -> *)
     * @param {...Function} functions
     * @returns {Function}
     * @example
     *
     *      var fn = R.cond(
     *          [R.eq(0),      R.always('water freezes at 0°C')],
     *          [R.eq(100),    R.always('water boils at 100°C')],
     *          [R.alwaysTrue, function(temp) { return 'nothing special happens at ' + temp + '°C'; }]
     *      );
     *      fn(0); //=> 'water freezes at 0°C'
     *      fn(50); //=> 'nothing special happens at 50°C'
     *      fn(100); //=> 'water boils at 100°C'
     */
    R.cond = function cond() {
        var pairs = arguments;
        return function() {
            var idx = -1;
            while (++idx < pairs.length) {
                if (pairs[idx][0].apply(this, arguments)) {
                    return pairs[idx][1].apply(this, arguments);
                }
            }
        };
    };


    // Arithmetic Functions
    // --------------------
    //
    // These functions wrap up the certain core arithmetic operators

    // --------

    /**
     * Adds two numbers (or strings). Equivalent to `a + b` but curried.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Number
     * @sig String -> String -> String
     * @param {Number|String} a The first value.
     * @param {Number|String} b The second value.
     * @return {Number|String} The result of `a + b`.
     * @example
     *
     *      var increment = R.add(1);
     *      increment(10);   //=> 11
     *      R.add(2, 3);       //=>  5
     *      R.add(7)(10);      //=> 17
     */
    function _add(a, b) {
        return a + b;
    }
    R.add = _curry2(_add);


    /**
     * Multiplies two numbers. Equivalent to `a * b` but curried.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Number
     * @param {Number} a The first value.
     * @param {Number} b The second value.
     * @return {Number} The result of `a * b`.
     * @example
     *
     *      var double = R.multiply(2);
     *      var triple = R.multiply(3);
     *      double(3);       //=>  6
     *      triple(4);       //=> 12
     *      R.multiply(2, 5);  //=> 10
     */
    function _multiply(a, b) {
        return a * b;
    }
    R.multiply = _curry2(_multiply);


    /**
     * Subtracts two numbers. Equivalent to `a - b` but curried.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Number
     * @param {Number} a The first value.
     * @param {Number} b The second value.
     * @return {Number} The result of `a - b`.
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @example
     *
     *      R.subtract(10, 8); //=> 2
     *
     *      var minus5 = R.subtract(__, 5); // '__' stands for any `undefined` value
     *      minus5(17); //=> 12
     *
     *      // note: In this example, `_`  is just an `undefined` value.  You could use `void 0` instead
     *      var complementaryAngle = R.subtract(90);
     *      complementaryAngle(30); //=> 60
     *      complementaryAngle(72); //=> 18
     */
    R.subtract = op(function subtract(a, b) { return a - b; });


    /**
     * Divides two numbers. Equivalent to `a / b`.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Number
     * @param {Number} a The first value.
     * @param {Number} b The second value.
     * @return {Number} The result of `a / b`.
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @example
     *
     *      R.divide(71, 100); //=> 0.71
     *
     *      // note: In this example, `__`  is just an `undefined` value.  You could use `void 0` instead
     *      var half = R.divide(__, 2);
     *      half(42); //=> 21
     *
     *      var reciprocal = R.divide(1);
     *      reciprocal(4);   //=> 0.25
     */
    R.divide = op(function divide(a, b) { return a / b; });


    /**
     * Divides the second parameter by the first and returns the remainder.
     * Note that this functions preserves the JavaScript-style behavior for
     * modulo. For mathematical modulo see `mathMod`
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Number
     * @param {Number} a The value to the divide.
     * @param {Number} b The pseudo-modulus
     * @return {Number} The result of `b % a`.
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @see R.mathMod
     * @example
     *
     *      R.modulo(17, 3); //=> 2
     *      // JS behavior:
     *      R.modulo(-17, 3); //=> -2
     *      R.modulo(17, -3); //=> 2
     *
     *      var isOdd = R.modulo(__, 2);
     *      isOdd(42); //=> 0
     *      isOdd(21); //=> 1
     */
    R.modulo = op(function modulo(a, b) { return a % b; });


    /**
     * Determine if the passed argument is an integer.
     *
     * @private
     * @param {*} n
     * @category type
     * @return {Boolean}
     */
    // TODO: document, even for internals...
    var _isInteger = Number.isInteger || function isInteger(n) {
        return (n << 0) === n;
    };


    /**
     * mathMod behaves like the modulo operator should mathematically, unlike the `%`
     * operator (and by extension, R.modulo). So while "-17 % 5" is -2,
     * mathMod(-17, 5) is 3. mathMod requires Integer arguments, and returns NaN
     * when the modulus is zero or negative.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Number
     * @param {Number} m The dividend.
     * @param {Number} p the modulus.
     * @return {Number} The result of `b mod a`.
     * @see R.moduloBy
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @example
     *
     *      R.mathMod(-17, 5);  //=> 3
     *      R.mathMod(17, 5);   //=> 2
     *      R.mathMod(17, -5);  //=> NaN
     *      R.mathMod(17, 0);   //=> NaN
     *      R.mathMod(17.2, 5); //=> NaN
     *      R.mathMod(17, 5.3); //=> NaN
     *
     *      var clock = R.mathMod(__, 12);
     *      clock(15); //=> 3
     *      clock(24); //=> 0
     *
     *      // note: In this example, `_`  is just an `undefined` value.  You could use `void 0` instead
     *      var seventeenMod = R.mathMod(17);
     *      seventeenMod(3);  //=> 2
     *      seventeenMod(4);  //=> 1
     *      seventeenMod(10); //=> 7
     */
    R.mathMod = op(function mathMod(m, p) {
        if (!_isInteger(m)) { return NaN; }
        if (!_isInteger(p) || p < 1) { return NaN; }
        return ((m % p) + p) % p;
    });


    /**
     * Adds together all the elements of a list.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig [Number] -> Number
     * @param {Array} list An array of numbers
     * @return {Number} The sum of all the numbers in the list.
     * @see reduce
     * @example
     *
     *      R.sum([2,4,6,8,100,1]); //=> 121
     */
    R.sum = reduce(_add, 0);


    /**
     * Multiplies together all the elements of a list.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig [Number] -> Number
     * @param {Array} list An array of numbers
     * @return {Number} The product of all the numbers in the list.
     * @see reduce
     * @example
     *
     *      R.product([2,4,6,8,100,1]); //=> 38400
     */
    R.product = reduce(_multiply, 1);


    /**
     * Returns true if the first parameter is less than the second.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Boolean
     * @param {Number} a
     * @param {Number} b
     * @return {Boolean} a < b
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @example
     *
     *      R.lt(2, 6); //=> true
     *      R.lt(2, 0); //=> false
     *      R.lt(2, 2); //=> false
     *      R.lt(5)(10); //=> true
     *      R.lt(__, 5)(10); //=> false // right-sectioned currying
     */
    function lt(a, b) { return a < b; }
    R.lt = op(lt);


    /**
     * Returns true if the first parameter is less than or equal to the second.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Boolean
     * @param {Number} a
     * @param {Number} b
     * @return {Boolean} a <= b
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @example
     *
     *      R.lte(2, 6); //=> true
     *      R.lte(2, 0); //=> false
     *      R.lte(2, 2); //=> true
     *      R.lte(__, 2)(1); //=> true
     *      R.lte(2)(10); //=> true
     *      R.lte(__)(5, 4) // => true
     */
    R.lte = op(function lte(a, b) { return a <= b; });


    /**
     * Returns true if the first parameter is greater than the second.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Boolean
     * @param {Number} a
     * @param {Number} b
     * @return {Boolean} a > b
     * @note Operator: Since this is a non-commutative infix operator converted to prefix, it can
     *                 be curried right by explicitly passing `undefined` for its first argument.
     * @example
     *
     *      R.gt(2, 6); //=> false
     *      R.gt(2, 0); //=> true
     *      R.gt(2, 2); //=> false
     *      R.gt(__, 2)(10); //=> true
     *      R.gt(2)(10); //=> false
     *      R.lte(__)(4, 5) // => true
     */
    function gt(a, b) { return a > b; }
    R.gt = op(gt);


    /**
     * Returns true if the first parameter is greater than or equal to the second.
     *
     * @func
     * @memberOf R
     * @category math
     * @sig Number -> Number -> Boolean
     * @param {Number} a
     * @param {Number} b
     * @return {Boolean} a >= b
     * @note Operator: this is right-curried by default, but can be called via sections
     * @example
     *
     *      R.gte(2, 6); //=> false
     *      R.gte(2, 0); //=> true
     *      R.gte(2, 2); //=> true
     *      R.gte(__, 6)(2); //=> false
     *      R.gte(2)(0); //=> true
     *      R.gte(__)(1, 2); //=> true
     */
    R.gte = op(function gte(a, b) { return a >= b; });


    /**
     * Create a function which takes a a list
     * and determines the winning value by a compatator. Used internally
     * by `R.max` and `R.min`
     *
     * @private
     * @param {Function} compatator a function to compare two items
     * @param {*} intialVal, default value if nothing else wins
     * @category math
     * @return {Function}
     */
    function _createMaxMin(comparator, initialVal) {
        return function(list) {
            if (arguments.length === 0) {
                throw _noArgsException();
            }
            var idx = -1, winner = initialVal, computed;
            while (++idx < list.length) {
                computed = +list[idx];
                if (comparator(computed, winner)) {
                    winner = computed;
                }
            }
            return winner;
        };
    }

    /**
     * Create a function which takes a comparator function and a list
     * and determines the winning value by a compatator. Used internally
     * by `R.maxBy` and `R.minBy`
     *
     * @private
     * @param {Function} compatator a function to compare two items
     * @category math
     * @return {Function}
     */
    function _createMaxMinBy(comparator) {
        return function(valueComputer, list) {
            if (!(list && list.length > 0)) {
                return;
            }
            var idx = 0,
                winner = list[idx],
                computedWinner = valueComputer(winner),
                computedCurrent;
            while (++idx < list.length) {
                computedCurrent = valueComputer(list[idx]);
                if (comparator(computedCurrent, computedWinner)) {
                    computedWinner = computedCurrent;
                    winner = list[idx];
                }
            }
            return winner;
        };
    }

    /**
     * Determines the largest of a list of numbers (or elements that can be cast to numbers)
     *
     * @func
     * @memberOf R
     * @category math
     * @sig [Number] -> Number
     * @see R.maxBy
     * @param {Array} list A list of numbers
     * @return {Number} The greatest number in the list
     * @example
     *
     *      R.max([7, 3, 9, 2, 4, 9, 3]); //=> 9
     */
    var max = R.max = _createMaxMin(gt, -Infinity);


    /**
     * Determines the largest of a list of items as determined by pairwise comparisons from the supplied comparator
     *
     * @func
     * @memberOf R
     * @category math
     * @sig (a -> Number) -> [a] -> a
     * @param {Function} keyFn A comparator function for elements in the list
     * @param {Array} list A list of comparable elements
     * @return {*} The greatest element in the list. `undefined` if the list is empty.
     * @see R.max
     * @example
     *
     *      function cmp(obj) { return obj.x; }
     *      var a = {x: 1}, b = {x: 2}, c = {x: 3};
     *      R.maxBy(cmp, [a, b, c]); //=> {x: 3}
     */
    R.maxBy = _curry2(_createMaxMinBy(gt));


    /**
     * Determines the smallest of a list of numbers (or elements that can be cast to numbers)
     *
     * @func
     * @memberOf R
     * @category math
     * @sig [Number] -> Number
     * @param {Array} list A list of numbers
     * @return {Number} The greatest number in the list
     * @see R.minBy
     * @example
     *
     *      R.min([7, 3, 9, 2, 4, 9, 3]); //=> 2
     */
    R.min = _createMaxMin(lt, Infinity);


    /**
     * Determines the smallest of a list of items as determined by pairwise comparisons from the supplied comparator
     *
     * @func
     * @memberOf R
     * @category math
     * @sig (a -> Number) -> [a] -> a
     * @param {Function} keyFn A comparator function for elements in the list
     * @param {Array} list A list of comparable elements
     * @see R.min
     * @return {*} The greatest element in the list. `undefined` if the list is empty.
     * @example
     *
     *      function cmp(obj) { return obj.x; }
     *      var a = {x: 1}, b = {x: 2}, c = {x: 3};
     *      R.minBy(cmp, [a, b, c]); //=> {x: 1}
     */
    R.minBy = _curry2(_createMaxMinBy(lt));



    // String Functions
    // ----------------
    //
    // Much of the String.prototype API exposed as simple functions.

    // --------

    /**
     * returns a subset of a string between one index and another.
     *
     * @func
     * @memberOf R
     * @category string
     * @sig Number -> Number -> String -> String
     * @param {Number} indexA An integer between 0 and the length of the string.
     * @param {Number} indexB An integer between 0 and the length of the string.
     * @param {String} str The string to extract from
     * @return {String} the extracted substring
     * @see R.invokerN
     * @example
     *
     *      R.substring(2, 5, 'abcdefghijklm'); //=> 'cde'
     */
    var substring = R.substring = invokerN(2, 'substring');


    /**
     * The trailing substring of a String starting with the nth character:
     *
     * @func
     * @memberOf R
     * @category string
     * @sig Number -> String -> String
     * @param {Number} indexA An integer between 0 and the length of the string.
     * @param {String} str The string to extract from
     * @return {String} the extracted substring
     * @see R.invokerN
     * @example
     *
     *      R.substringFrom(8, 'abcdefghijklm'); //=> 'ijklm'
     */
    R.substringFrom = flip(substring)(void 0);


    /**
     * The leading substring of a String ending before the nth character:
     *
     * @func
     * @memberOf R
     * @category string
     * @sig Number -> String -> String
     * @param {Number} indexA An integer between 0 and the length of the string.
     * @param {String} str The string to extract from
     * @return {String} The extracted substring
     * @see R.invokerN
     * @example
     *
     *      R.substringTo(8, 'abcdefghijklm'); //=> 'abcdefgh'
     */
    R.substringTo = substring(0);


    /**
     * The character at the nth position in a String:
     *
     * @func
     * @memberOf R
     * @category string
     * @sig Number -> String -> String
     * @param {Number} index An integer between 0 and the length of the string.
     * @param {String} str The string to extract a char from
     * @return {String} the character at `index` of `str`
     * @see R.invokerN
     * @example
     *
     *      R.charAt(8, 'abcdefghijklm'); //=> 'i'
     */
    R.charAt = invokerN(1, 'charAt');


    /**
     * The ascii code of the character at the nth position in a String:
     *
     * @func
     * @memberOf R
     * @category string
     * @sig Number -> String -> Number
     * @param {Number} index An integer between 0 and the length of the string.
     * @param {String} str The string to extract a charCode from
     * @return {Number} the code of the character at `index` of `str`
     * @see R.invokerN
     * @example
     *
     *      R.charCodeAt(8, 'abcdefghijklm'); //=> 105
     *      // (... 'a' ~ 97, 'b' ~ 98, ... 'i' ~ 105)
     */
    R.charCodeAt = invokerN(1, 'charCodeAt');


    /**
     * Tests a regular expression against a String
     *
     * @func
     * @memberOf R
     * @category string
     * @sig RegExp -> String -> [String] | null
     * @param {RegExp} rx A regular expression.
     * @param {String} str The string to match against
     * @return {Array} The list of matches, or null if no matches found
     * @see R.invokerN
     * @example
     *
     *      R.match(/([a-z]a)/g, 'bananas'); //=> ['ba', 'na', 'na']
     */
    R.match = invokerN(1, 'match');


    /**
     * Replace a substring or regex match in a string with a replacement.
     *
     * @func
     * @memberOf R
     * @category string
     * @sig RegExp|String -> String -> String -> String
     * @param {RegExp|String} pattern A regular expression or a substring to match.
     * @param {String} replacement The string to replace the matches with.
     * @param {String} str The String to do the search and replacement in.
     * @return {String} A string with all the matches replaced.
     * @example
     *
     *      R.replace(/\d+/g, 'number', '1 2 three'); //=> 'number number three'
     *
     *      var replaceSemicolon = R.replace(';');
     *      var removeSemicolon = replaceSemicolon('');
     *      removeSemicolon('return 42;'); //=> 'return 42'
     */
    R.replace = _curry3(function replace(regex, replacement, str) {
        return str.replace(regex, replacement);
    });


    /**
     * Finds the first index of a substring in a string, returning -1 if it's not present
     *
     * @func
     * @memberOf R
     * @category string
     * @sig String -> String -> Number
     * @param {String} c A string to find.
     * @param {String} str The string to search in
     * @return {Number} The first index of `c` or -1 if not found
     * @see R.invokerN
     * @example
     *
     *      R.strIndexOf('c', 'abcdefg'); //=> 2
     */
    R.strIndexOf = _curry2(function strIndexOf(c, str) {
        return str.indexOf(c);
    });


    /**
     *
     * Finds the last index of a substring in a string, returning -1 if it's not present
     *
     * @func
     * @memberOf R
     * @category string
     * @sig String -> String -> Number
     * @param {String} c A string to find.
     * @param {String} str The string to search in
     * @return {Number} The last index of `c` or -1 if not found
     * @see R.invokerN
     * @example
     *
     *      R.strLastIndexOf('a', 'banana split'); //=> 5
     */
    R.strLastIndexOf = _curry2(function(c, str) {
        return str.lastIndexOf(c);
    });


    /**
     * The upper case version of a string.
     *
     * @func
     * @memberOf R
     * @category string
     * @sig String -> String
     * @param {String} str The string to upper case.
     * @return {String} The upper case version of `str`.
     * @example
     *
     *      R.toUpperCase('abc'); //=> 'ABC'
     */
    R.toUpperCase = invokerN(0, 'toUpperCase');


    /**
     * The lower case version of a string.
     *
     * @func
     * @memberOf R
     * @category string
     * @sig String -> String
     * @param {String} str The string to lower case.
     * @return {String} The lower case version of `str`.
     * @example
     *
     *      R.toLowerCase('XYZ'); //=> 'xyz'
     */
    R.toLowerCase = invokerN(0, 'toLowerCase');


    /**
     * Removes whitespace from both ends of the string.
     *
     * @func
     * @memberOf R
     * @category string
     * @sig String -> String
     * @param {String} str The string to trim.
     * @returns {String} Trimmed version of `str`.
     * @example
     *
     *      R.trim('   xyz  '); //=> 'xyz'
     *      R.map(R.trim, R.split(',', 'x, y, z')); //=> ['x', 'y', 'z']
     */
    R.trim = (function() {
        var ws = '\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u180E\u2000\u2001\u2002\u2003' +
            '\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028' +
            '\u2029\uFEFF';
        var zeroWidth = '\u200b';
        var hasProtoTrim = (typeof String.prototype.trim === 'function');
        if (!hasProtoTrim || (ws.trim() || !zeroWidth.trim())) {
            return function trim(str) {
                var beginRx = new RegExp('^[' + ws + '][' + ws + ']*');
                var endRx = new RegExp('[' + ws + '][' + ws + ']*$');
                return str.replace(beginRx, '').replace(endRx, '');
            };
        } else {
            return function trim(str) {
                return str.trim();
            };
        }
    }());


    /**
     * Splits a string into an array of strings based on the given
     * separator.
     *
     * @func
     * @memberOf R
     * @category string
     * @sig String -> String -> [String]
     * @param {String} sep The separator string.
     * @param {String} str The string to separate into an array.
     * @return {Array} The array of strings from `str` separated by `str`.
     * @example
     *
     *      var pathComponents = R.split('/');
     *      R.tail(pathComponents('/usr/local/bin/node')); //=> ['usr', 'local', 'bin', 'node']
     *
     *      R.split('.', 'a.b.c.xyz.d'); //=> ['a', 'b', 'c', 'xyz', 'd']
     */
    var split = R.split = invokerN(1, 'split');


    /**
     * internal path function
     * Takes an array, paths, indicating the deep set of keys
     * to find.
     *
     * @private
     * @memberOf R
     * @category object
     * @param {Array} paths An array of strings to map to object properties
     * @param {Object} obj The object to find the path in
     * @return {Array} The value at the end of the path or `undefined`.
     * @example
     *
     *      _path(['a', 'b'], {a: {b: 2}}); //=> 2
     */
    function _path(paths, obj) {
        var idx = -1, length = paths.length, val;
        if (obj == null) { return; }
        val = obj;
        while (val != null && ++idx < length) {
            val = val[paths[idx]];
        }
        return val;
    }


    /**
     * Retrieve a nested path on an object separated by the specified
     * separator value.
     *
     * @func
     * @memberOf R
     * @category object
     * @sig String -> String -> {*} -> *
     * @param {String} sep The separator to use in `path`.
     * @param {String} path The path to use.
     * @return {*} The data at `path`.
     * @example
     *
     *      R.pathOn('/', 'a/b/c', {a: {b: {c: 3}}}); //=> 3
     */
    var pathOn = R.pathOn = _curry3(function pathOn(sep, str, obj) {
        return _path(str.split(sep), obj);
    });


    /**
     * Retrieve a nested path on an object separated by periods
     *
     * @func
     * @memberOf R
     * @category object
     * @sig String -> {*} -> *
     * @param {String} path The dot path to use.
     * @return {*} The data at `path`.
     * @example
     *
     *      R.path('a.b', {a: {b: 2}}); //=> 2
     */
    R.path = pathOn('.');


    /**
     * Determines whether a nested path on an object, seperated by periods,
     * has a specific value according to strict equality ('==='). Most
     * likely used to filter a list:
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig String -> v -> {k: v} -> Boolean
     * @param {String} path The path of the nested property to use
     * @param {*} val The value to compare the nested property with
     * @param {Object} obj The object to check the nested property in
     * @return {Boolean} `true` if the value equals the nested object property,
     *     `false` otherwise.
     * @example
     *
     *     var user1 = { address: { zipCode: 90210 } };
     *     var user2 = { address: { zipCode: 55555 } };
     *     var user3 = { name: 'Bob' };
     *     var users = [ user1, user2, user3 ]
     *     var isFamous = R.pathEq('address.zipCode', 90210);
     *     R.filter(isFamous, users); //=> [ user1 ]
     */
    R.pathEq = _curry3(function(path, val, obj) {
        return _path(path.split('.'), obj) === val;
    });


    // Data Analysis and Grouping Functions
    // ------------------------------------
    //
    // Functions performing SQL-like actions on lists of objects.  These do
    // not have any SQL-like optimizations performed on them, however.

    // --------

    /**
     * Reasonable analog to SQL `select` statement.
     *
     * @func
     * @memberOf R
     * @category object
     * @category relation
     * @sig [k] -> [{k: v}] -> [{k: v}]
     * @param {Array} props The property names to project
     * @param {Array} objs The objects to query
     * @return {Array} An array of objects with just the `props` properties.
     * @example
     *
     *      var abby = {name: 'Abby', age: 7, hair: 'blond', grade: 2};
     *      var fred = {name: 'Fred', age: 12, hair: 'brown', grade: 7};
     *      var kids = [abby, fred];
     *      R.project(['name', 'grade'], kids); //=> [{name: 'Abby', grade: 2}, {name: 'Fred', grade: 7}]
     */
    R.project = useWith(_map, pickAll, identity); // passing `identity` gives correct arity


    /**
     * Determines whether the given property of an object has a specific
     * value according to strict equality (`===`).  Most likely used to
     * filter a list:
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig k -> v -> {k: v} -> Boolean
     * @param {Number|String} name The property name (or index) to use.
     * @param {*} val The value to compare the property with.
     * @return {Boolean} `true` if the properties are equal, `false` otherwise.
     * @example
     *
     *      var abby = {name: 'Abby', age: 7, hair: 'blond'};
     *      var fred = {name: 'Fred', age: 12, hair: 'brown'};
     *      var rusty = {name: 'Rusty', age: 10, hair: 'brown'};
     *      var alois = {name: 'Alois', age: 15, disposition: 'surly'};
     *      var kids = [abby, fred, rusty, alois];
     *      var hasBrownHair = R.propEq('hair', 'brown');
     *      R.filter(hasBrownHair, kids); //=> [fred, rusty]
     */
    R.propEq = _curry3(function propEq(name, val, obj) {
        return obj[name] === val;
    });


    /**
     * Combines two lists into a set (i.e. no duplicates) composed of the
     * elements of each list.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig [a] -> [a] -> [a]
     * @param {Array} as The first list.
     * @param {Array} bs The second list.
     * @return {Array} The first and second lists concatenated, with
     * duplicates removed.
     * @example
     *
     *      R.union([1, 2, 3], [2, 3, 4]); //=> [1, 2, 3, 4]
     */
    R.union = compose(uniq, _concat);


    /**
     * Combines two lists into a set (i.e. no duplicates) composed of the elements of each list.  Duplication is
     * determined according to the value returned by applying the supplied predicate to two list elements.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig (a,a -> Boolean) -> [a] -> [a] -> [a]
     * @param {Function} pred A predicate used to test whether two items are equal.
     * @param {Array} list1 The first list.
     * @param {Array} list2 The second list.
     * @return {Array} The first and second lists concatenated, with
     *         duplicates removed.
     * @see R.union
     * @example
     *
     *      function cmp(x, y) { return x.a === y.a; }
     *      var l1 = [{a: 1}, {a: 2}];
     *      var l2 = [{a: 1}, {a: 4}];
     *      R.unionWith(cmp, l1, l2); //=> [{a: 1}, {a: 2}, {a: 4}]
     */
    R.unionWith = _curry3(function unionWith(pred, list1, list2) {
        return uniqWith(pred, _concat(list1, list2));
    });


    /**
     * Finds the set (i.e. no duplicates) of all elements in the first list not contained in the second list.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig [a] -> [a] -> [a]
     * @param {Array} list1 The first list.
     * @param {Array} list2 The second list.
     * @return {Array} The elements in `list1` that are not in `list2`
     * @see R.differenceWith
     * @example
     *
     *      R.difference([1,2,3,4], [7,6,5,4,3]); //=> [1,2]
     *      R.difference([7,6,5,4,3], [1,2,3,4]); //=> [7,6,5]
     */
    R.difference = _curry2(function difference(first, second) {
        var out = [];
        var idx = -1;
        var firstLen = first.length;
        while (++idx < firstLen) {
            if (!_contains(first[idx], second) && !_contains(first[idx], out)) {
                out.push(first[idx]);
            }
        }
        return out;
    });


    /**
     * Finds the set (i.e. no duplicates) of all elements in the first list not contained in the second list.
     * Duplication is determined according to the value returned by applying the supplied predicate to two list
     * elements.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig (a,a -> Boolean) -> [a] -> [a] -> [a]
     * @param {Function} pred A predicate used to test whether two items are equal.
     * @param {Array} list1 The first list.
     * @param {Array} list2 The second list.
     * @see R.difference
     * @return {Array} The elements in `list1` that are not in `list2`
     * @example
     *
     *      function cmp(x, y) { return x.a === y.a; }
     *      var l1 = [{a: 1}, {a: 2}, {a: 3}];
     *      var l2 = [{a: 3}, {a: 4}];
     *      R.differenceWith(cmp, l1, l2); //=> [{a: 1}, {a: 2}]
     *
     */
    R.differenceWith = _curry3(function differenceWith(pred, first, second) {
        var out = [];
        var idx = -1;
        var firstLen = first.length;
        var containsPred = containsWith(pred);
        while (++idx < firstLen) {
            if (!containsPred(first[idx], second) && !containsPred(first[idx], out)) {
                out.push(first[idx]);
            }
        }
        return out;
    });


    /**
     * Combines two lists into a set (i.e. no duplicates) composed of those elements common to both lists.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig [a] -> [a] -> [a]
     * @param {Array} list1 The first list.
     * @param {Array} list2 The second list.
     * @see R.intersectionWith
     * @return {Array} The list of elements found in both `list1` and `list2`
     * @example
     *
     *      R.intersection([1,2,3,4], [7,6,5,4,3]); //=> [4, 3]
     */
    R.intersection = _curry2(function intersection(list1, list2) {
        return uniq(_filter(flip(_contains)(list1), list2));
    });


    /**
     * Combines two lists into a set (i.e. no duplicates) composed of those
     * elements common to both lists.  Duplication is determined according
     * to the value returned by applying the supplied predicate to two list
     * elements.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig (a,a -> Boolean) -> [a] -> [a] -> [a]
     * @param {Function} pred A predicate function that determines whether
     *        the two supplied elements are equal.
     * @param {Array} list1 One list of items to compare
     * @param {Array} list2 A second list of items to compare
     * @see R.intersection
     * @return {Array} A new list containing those elements common to both lists.
     * @example
     *
     *      var buffaloSpringfield = [
     *        {id: 824, name: 'Richie Furay'},
     *        {id: 956, name: 'Dewey Martin'},
     *        {id: 313, name: 'Bruce Palmer'},
     *        {id: 456, name: 'Stephen Stills'},
     *        {id: 177, name: 'Neil Young'}
     *      ];
     *      var csny = [
     *        {id: 204, name: 'David Crosby'},
     *        {id: 456, name: 'Stephen Stills'},
     *        {id: 539, name: 'Graham Nash'},
     *        {id: 177, name: 'Neil Young'}
     *      ];
     *
     *      var sameId = function(o1, o2) {return o1.id === o2.id;};
     *
     *      R.intersectionWith(sameId, buffaloSpringfield, csny);
     *      //=> [{id: 456, name: 'Stephen Stills'}, {id: 177, name: 'Neil Young'}]
     */
    R.intersectionWith = _curry3(function intersectionWith(pred, list1, list2) {
        var results = [], idx = -1;
        while (++idx < list1.length) {
            if (_containsWith(pred, list1[idx], list2)) {
                results[results.length] = list1[idx];
            }
        }
        return uniqWith(pred, results);
    });


    /**
     * Creates a new list whose elements each have two properties: `val` is
     * the value of the corresponding item in the list supplied, and `key`
     * is the result of applying the supplied function to that item.
     *
     * @private
     * @func
     * @memberOf R
     * @category relation
     * @param {Function} fn An arbitrary unary function returning a potential
     *        object key.  Signature: Any -> String
     * @param {Array} list The list of items to process
     * @return {Array} A new list with the described structure.
     * @example
     *
     *      var people = [
     *         {first: 'Fred', last: 'Flintstone', age: 23},
     *         {first: 'Betty', last: 'Rubble', age: 21},
     *         {first: 'George', last: 'Jetson', age: 29}
     *      ];
     *
     *      var fullName = function(p) {return p.first + ' ' + p.last;};
     *
     *      _keyValue(fullName, people); //=>
     *      // [
     *      //     {
     *      //         key: 'Fred Flintstone',
     *      //         val: {first: 'Fred', last: 'Flintstone', age: 23}
     *      //     }, {
     *      //         key: 'Betty Rubble',
     *      //         val: {first: 'Betty', last: 'Rubble', age: 21}
     *      //    }, {
     *      //        key: 'George Jetson',
     *      //        val: {first: 'George', last: 'Jetson', age: 29}
     *      //    }
     *      // ];
     */
    function _keyValue(fn, list) { // TODO: Should this be made public?
        return _map(function(item) {return {key: fn(item), val: item};}, list);
    }

    /**
     * Compare two items from a list generated from the `_keyValue`
     * function. Used internally by sortBy.
     *
     * @private
     * @func
     * @category relation
     * @param {*} a
     * @param {*} b
     */
    var _compareKeys = comparator(function(a, b) {
        return a.key < b.key;
    });


    /**
     * Sorts the list according to a key generated by the supplied function.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig (a -> String) -> [a] -> [a]
     * @param {Function} fn The function mapping `list` items to keys.
     * @param {Array} list The list to sort.
     * @return {Array} A new list sorted by the keys generated by `fn`.
     * @example
     *
     *      var sortByFirstItem = R.sortBy(prop(0));
     *      var sortByNameCaseInsensitive = R.sortBy(compose(R.toLowerCase, prop('name')));
     *      var pairs = [[-1, 1], [-2, 2], [-3, 3]];
     *      sortByFirstItem(pairs); //=> [[-3, 3], [-2, 2], [-1, 1]]
     *      var alice = {
     *         name: 'ALICE',
     *         age: 101
     *      };
     *      var bob = {
     *         name: 'Bob',
     *        age: -10
     *      };
     *      var clara = {
     *        name: 'clara',
     *        age: 314.159
     *      };
     *      var people = [clara, bob, alice];
     *      sortByNameCaseInsensitive(people); //=> [alice, bob, clara]
     */
    R.sortBy = _curry2(function sortBy(fn, list) {
        return pluck('val', _keyValue(fn, list).sort(_compareKeys));
    });


    /**
     * Counts the elements of a list according to how many match each value
     * of a key generated by the supplied function. Returns an object
     * mapping the keys produced by `fn` to the number of occurrences in
     * the list. Note that all keys are coerced to strings because of how
     * JavaScript objects work.
     *
     * @func
     * @memberOf R
     * @category relation
     * @sig (a -> String) -> [a] -> {*}
     * @param {Function} fn The function used to map values to keys.
     * @param {Array} list The list to count elements from.
     * @return {Object} An object mapping keys to number of occurrences in the list.
     * @example
     *
     *      var numbers = [1.0, 1.1, 1.2, 2.0, 3.0, 2.2];
     *      var letters = R.split('', 'abcABCaaaBBc');
     *      R.countBy(Math.floor)(numbers);    //=> {'1': 3, '2': 2, '3': 1}
     *      R.countBy(R.toLowerCase)(letters);   //=> {'a': 5, 'b': 4, 'c': 3}
     */
    R.countBy = _curry2(function countBy(fn, list) {
        return reduce(function(counts, obj) {
            counts[obj.key] = (counts[obj.key] || 0) + 1;
            return counts;
        }, {}, _keyValue(fn, list));
    });


    /**
     * @private
     * @param {Function} fn The strategy for extracting function names from an object
     * @return {Function} A function that takes an object and returns an array of function names
     *
     */
    function _functionsWith(fn) {
        return function(obj) {
            return _filter(function(key) { return typeof obj[key] === 'function'; }, fn(obj));
        };
    }


    /**
     * Returns a list of function names of object's own functions
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {*} -> [String]
     * @param {Object} obj The objects with functions in it
     * @return {Array} returns a list of the object's own properties that map to functions
     * @example
     *
     *      R.functions(R); // returns list of ramda's own function names
     *
     *      var F = function() { this.x = function(){}; this.y = 1; }
     *      F.prototype.z = function() {};
     *      F.prototype.a = 100;
     *      R.functions(new F()); //=> ["x"]
     */
    R.functions = _functionsWith(keys);


    /**
     * Returns a list of function names of object's own and prototype functions
     *
     * @func
     * @memberOf R
     * @category Object
     * @sig {*} -> [String]
     * @param {Object} obj The objects with functions in it
     * @return {Array} returns a list of the object's own properties and prototype
     *                 properties that map to functions
     * @example
     *
     *      R.functionsIn(R); // returns list of ramda's own and prototype function names
     *
     *      var F = function() { this.x = function(){}; this.y = 1; }
     *      F.prototype.z = function() {};
     *      F.prototype.a = 100;
     *      R.functionsIn(new F()); //=> ["x", "z"]
     */
    R.functionsIn = _functionsWith(keysIn);


    // All the functional goodness, wrapped in a nice little package, just for you!
    return R;
}));

},{}],8:[function(require,module,exports){
var R = require('ramda');
var lex = require('./lex');


function ParseError(message) {
  if (!(this instanceof ParseError)) {
    throw new Error('Error throwing parse error -- pleas use the "new" ' +
      ' keyword. The parse error was:' + message);
  }
  this.toString = function() {
    return message;
  };
}


var parseTokens;  // implemented later; declared here because we recurse to it


var astNode = function(nodeType, children, options) {
  children = children || [];
  options = options || {};
  var template = options.template || '#';
  delete options.template;
  return {
    id: options.id || undefined,
    type: 'ASTNode',
    node: nodeType,
    template: template,
    children: children,
    options: options
  };
};


var parenDepthMod = function(token) {
  return (token.value === '(') ? +1 : -1;
};


var pullSubExpressions = function(tokens) {
  var token,
      parenDepth = 0,
      subExprTokens,
      subAST,
      outputTokens = [],
      openTempl;

  for (var i = 0; i < tokens.length; i++) {
    token = tokens[i];
    if (parenDepth === 0) {
      if (token.token === 'paren') {
        if (token.value === ')') { throw new ParseError('Unexpected close paren ")"'); }
        parenDepth += 1;
        subExprTokens = [];
        openTempl = token.repr;
      } else {
        outputTokens.push(token);
      }
    } else {
      if (token.token === 'paren') {
        parenDepth += parenDepthMod(token);
        if (parenDepth === 0) {
          subAST = parseTokens(subExprTokens);
          subAST.template = openTempl + subAST.template + token.repr;
          outputTokens.push(subAST);
        } else {
          subExprTokens.push(token);
        }
      } else {
        subExprTokens.push(token);
      }
    }
  }
  if (parenDepth !== 0) { throw new ParseError('Unclosed paren'); }
  return outputTokens;
};


var stepTrios = function(puller) {
  // steps right to left

  var getTrio = function(leftovers, tokens) {
    return [
      leftovers.pop() || tokens.pop(),
      leftovers.pop() || tokens.pop(),
      leftovers.pop() || tokens.pop()
    ].reverse();
  };

  return function(tokens) {
    var pulled = [[], null],
        output = [],
        trio;
    while (true) {
      trio = getTrio(pulled[0], tokens);
      if (!trio[1]) {
        if (trio[2]) { output.unshift(trio[2]); }
        break;
      }
      pulled = puller.apply(null, trio);
      if (pulled[1] !== null) {
        output.unshift(pulled[1]);
      }
    }
    return output;
  };
};


var pullSpaces = stepTrios(function(tL, t, tR) {
  tR = R.cloneObj(tR);
  var templProp;

  if (tR.type === 'token' && tR.token === 'space') {
    // the very first (right-most) token could be whitespace
    t = R.cloneObj(t);
    templProp = t.type === 'token' ? 'repr' : 'template';
    t[templProp] = t[templProp] + tR.repr;
    return [[tL, t], null];
  }
  if (t.type === 'token' && t.token === 'space') {
    templProp = tR.type === 'token' ? 'repr' : 'template';
    tR[templProp] = t.repr + tR[templProp];
    return [[tL], tR];
  } else {
    return [[tL, t], tR];
  }
});


var pullOps = function(symbol, ary, funcName, options) {
  var arys = {
    unary: function(tL, t, tR) {
      var node = astNode('func', [tR],
        { key: funcName, template: t.repr + '#' });
      if (options.binarify &&
          tL &&  // it's not the first token
          !(tL.type === 'token' && tL.token === 'operator') &&  // thing before isn't an op
          !(tL.type === 'astNode' && tL.node === 'func')) {  // thing before isn't an op
        var injectedToken = lex.token('operator', options.binarify);
        injectedToken.repr = '';
        return [[tL, injectedToken, node], null];
      }
      return [[tL, node], null];
    },
    binary: function(tL, t, tR) {
      var node = astNode('func', [tL, tR],
        { key: funcName, template: '#' + t.repr + '#' });
      return [[node], null];
    },
    nary: function(tL, t, tR) {
      if (tR.type === 'ASTNode' && tR.node === 'func' && tR.options.key === funcName) {
        tR.children.unshift(tL);
        tR.template = '#' + t.repr + tR.template;
        return [[tR], null];
      }
      return arys.binary(tL, t, tR);
    }
  };

  return stepTrios(function(tL, t, tR) {
    if (t.type === 'token' && t.token === 'operator' && t.value === symbol) {
      return arys[ary](tL, t, tR);
    }
    return [[tL, t], tR];
  });
};


var pullFunctions = stepTrios(function(tL, t, tR) {
  // find [name, expr]s, and swap as fn(key=name, children=expr.children)
  if (t.token === 'name' && tR.node === 'expr') {
    return [[tL], astNode('func', tR.children, {key: t.value,
      template: t.repr + tR.template})];
  }
  return [[tL, t], tR];
});


var validateHasValue = function(tokens) {
  var hasValue = R.reduce(function(foundValue, token) {
    if (R.contains(token.token, ['literal', 'name']) || token.node === 'expr') {
      return true;
    } else {
      return foundValue;
    }
  }, false);
  if (!hasValue(tokens)) {
    throw new ParseError('Expression has no value ' + JSON.stringify(tokens));
  }
  return tokens;
};


var pullValues = R.map(function(token) {
  if (token.type === 'token') {
    if (token.token === 'name') {
      return astNode('name', [],
        { key: token.value, template: token.repr });
    } else if (token.token === 'literal') {
      return astNode('literal', [],
        { value: parseFloat(token.value), template: token.repr });
    }
  }
  return token;
});


var validateOperators = function(tokens) {
  var first = tokens[0],
      last = tokens[tokens.length - 1];
  if (first.token === 'operator' && first.value !== '-') {
    throw new ParseError('non-unary leading operator: ' + first.value);
  }
  if (last.token === 'operator') {
    throw new ParseError('trailing operator: ' + last.value);
  }
  return tokens;
};


var validateOneValue = function(nodes) {
  if (nodes.children.length !== 1) {
    throw new ParseError('The expression must resolve to exactly one value');
  }
  return nodes;
};


var stampIds = function(rootNode) {
  var i = 0;
  (function stamper(node) {
    if (node.id) { throw new Error('node already has an id?'); }
    node.id = i++;
    R.forEach(stamper, node.children);
  })(rootNode);
  return rootNode;
};


parseTokens = R.pipe(
  pullSubExpressions,
  validateHasValue,
  pullSpaces,
  pullFunctions,
  pullValues,
  validateOperators,
  pullOps('^', 'binary', 'pow'),
  pullOps('-', 'unary', 'neg', {binarify: '+'}),
  pullOps('*', 'nary', 'product'),
  pullOps('/', 'binary', 'div'),
  pullOps('%', 'binary', 'mod'),
  pullOps('+', 'nary', 'sum'),
  pullOps('<', 'binary', 'lessThan'),
  pullOps('>', 'binary', 'greaterThan'),
  R.curryN(2, astNode)('expr')
);

var parse = R.pipe(
  lex,
  parseTokens,
  validateOneValue,
  stampIds
);


parse.ParseError = ParseError;
parse.astNode = astNode;
parse.lex = lex;
parse.parseTokens = parseTokens;


module.exports = parse;

},{"./lex":6,"ramda":7}],9:[function(require,module,exports){
/* Get a function yielding an array of computed values for each node in the
 * AST, indexed by AST node id */

var R = require('ramda');
var parse = require('./parse');
var astFunc = require('./func').fromAST;


var _values = function(AST) {
  var funcs = [];
  (function collectFuncs(node) {
    funcs[node.id] = astFunc(node);
    node.children.forEach(collectFuncs);
  })(AST);
  return function(ctx) {
    return funcs.map(function(func) {
      return func(ctx);
    });
  };
};


var values = R.pipe(parse, _values);
values.fromAST = _values;
module.exports = values;

},{"./func":5,"./parse":8,"ramda":7}],10:[function(require,module,exports){
'use strict';

/**
 * Representation of a single EventEmitter function.
 *
 * @param {Function} fn Event handler to be called.
 * @param {Mixed} context Context for function execution.
 * @param {Boolean} once Only emit once
 * @api private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Minimal EventEmitter interface that is molded against the Node.js
 * EventEmitter interface.
 *
 * @constructor
 * @api public
 */
function EventEmitter() { /* Nothing to set */ }

/**
 * Holds the assigned EventEmitters by name.
 *
 * @type {Object}
 * @private
 */
EventEmitter.prototype._events = undefined;

/**
 * Return a list of assigned event listeners.
 *
 * @param {String} event The events that should be listed.
 * @returns {Array}
 * @api public
 */
EventEmitter.prototype.listeners = function listeners(event) {
  if (!this._events || !this._events[event]) return [];
  if (this._events[event].fn) return [this._events[event].fn];

  for (var i = 0, l = this._events[event].length, ee = new Array(l); i < l; i++) {
    ee[i] = this._events[event][i].fn;
  }

  return ee;
};

/**
 * Emit an event to all registered event listeners.
 *
 * @param {String} event The name of the event.
 * @returns {Boolean} Indication if we've emitted an event.
 * @api public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  if (!this._events || !this._events[event]) return false;

  var listeners = this._events[event]
    , len = arguments.length
    , args
    , i;

  if ('function' === typeof listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Register a new EventListener for the given event.
 *
 * @param {String} event Name of the event.
 * @param {Functon} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  var listener = new EE(fn, context || this);

  if (!this._events) this._events = {};
  if (!this._events[event]) this._events[event] = listener;
  else {
    if (!this._events[event].fn) this._events[event].push(listener);
    else this._events[event] = [
      this._events[event], listener
    ];
  }

  return this;
};

/**
 * Add an EventListener that's only called once.
 *
 * @param {String} event Name of the event.
 * @param {Function} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  var listener = new EE(fn, context || this, true);

  if (!this._events) this._events = {};
  if (!this._events[event]) this._events[event] = listener;
  else {
    if (!this._events[event].fn) this._events[event].push(listener);
    else this._events[event] = [
      this._events[event], listener
    ];
  }

  return this;
};

/**
 * Remove event listeners.
 *
 * @param {String} event The event we want to remove.
 * @param {Function} fn The listener that we need to find.
 * @param {Boolean} once Only remove once listeners.
 * @api public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, once) {
  if (!this._events || !this._events[event]) return this;

  var listeners = this._events[event]
    , events = [];

  if (fn) {
    if (listeners.fn && (listeners.fn !== fn || (once && !listeners.once))) {
      events.push(listeners);
    }
    if (!listeners.fn) for (var i = 0, length = listeners.length; i < length; i++) {
      if (listeners[i].fn !== fn || (once && !listeners[i].once)) {
        events.push(listeners[i]);
      }
    }
  }

  //
  // Reset the array, or remove it completely if we have no more listeners.
  //
  if (events.length) {
    this._events[event] = events.length === 1 ? events[0] : events;
  } else {
    delete this._events[event];
  }

  return this;
};

/**
 * Remove all listeners or only the listeners for the specified event.
 *
 * @param {String} event The event want to remove all listeners for.
 * @api public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  if (!this._events) return this;

  if (event) delete this._events[event];
  else this._events = {};

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// This function doesn't apply anymore.
//
EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this;
};

//
// Expose the module.
//
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.EventEmitter2 = EventEmitter;
EventEmitter.EventEmitter3 = EventEmitter;

//
// Expose the module.
//
module.exports = EventEmitter;

},{}],11:[function(require,module,exports){
/**
 * A module of methods that you want to include in all actions.
 * This module is consumed by `createAction`.
 */
module.exports = {
};

},{}],12:[function(require,module,exports){
exports.createdStores = [];

exports.createdActions = [];

exports.reset = function() {
    while(exports.createdStores.length) {
        exports.createdStores.pop();
    }
    while(exports.createdActions.length) {
        exports.createdActions.pop();
    }
};

},{}],13:[function(require,module,exports){
var _ = require('./utils'),
    maker = require('./joins').instanceJoinCreator;

/**
 * A module of methods related to listening.
 */
module.exports = {

    /**
     * An internal utility function used by `validateListening`
     *
     * @param {Action|Store} listenable The listenable we want to search for
     * @returns {Boolean} The result of a recursive search among `this.subscriptions`
     */
    hasListener: function(listenable) {
        var i = 0, j, listener, listenables;
        for (;i < (this.subscriptions||[]).length; ++i) {
            listenables = [].concat(this.subscriptions[i].listenable);
            for (j = 0; j < listenables.length; j++){
                listener = listenables[j];
                if (listener === listenable || listener.hasListener && listener.hasListener(listenable)) {
                    return true;
                }
            }
        }
        return false;
    },

    /**
     * A convenience method that listens to all listenables in the given object.
     *
     * @param {Object} listenables An object of listenables. Keys will be used as callback method names.
     */
    listenToMany: function(listenables){
        for(var key in listenables){
            var cbname = _.callbackName(key),
                localname = this[cbname] ? cbname : this[key] ? key : undefined;
            if (localname){
                this.listenTo(listenables[key],localname,this[cbname+"Default"]||this[localname+"Default"]||localname);
            }
        }
    },

    /**
     * Checks if the current context can listen to the supplied listenable
     *
     * @param {Action|Store} listenable An Action or Store that should be
     *  listened to.
     * @returns {String|Undefined} An error message, or undefined if there was no problem.
     */
    validateListening: function(listenable){
        if (listenable === this) {
            return "Listener is not able to listen to itself";
        }
        if (!_.isFunction(listenable.listen)) {
            return listenable + " is missing a listen method";
        }
        if (listenable.hasListener && listenable.hasListener(this)) {
            return "Listener cannot listen to this listenable because of circular loop";
        }
    },

    /**
     * Sets up a subscription to the given listenable for the context object
     *
     * @param {Action|Store} listenable An Action or Store that should be
     *  listened to.
     * @param {Function|String} callback The callback to register as event handler
     * @param {Function|String} defaultCallback The callback to register as default handler
     * @returns {Object} A subscription obj where `stop` is an unsub function and `listenable` is the object being listened to
     */
    listenTo: function(listenable, callback, defaultCallback) {
        var desub, unsubscriber, subscriptionobj, subs = this.subscriptions = this.subscriptions || [];
        _.throwIf(this.validateListening(listenable));
        this.fetchInitialState(listenable, defaultCallback);
        desub = listenable.listen(this[callback]||callback, this);
        unsubscriber = function() {
            var index = subs.indexOf(subscriptionobj);
            _.throwIf(index === -1,'Tried to remove listen already gone from subscriptions list!');
            subs.splice(index, 1);
            desub();
        };
        subscriptionobj = {
            stop: unsubscriber,
            listenable: listenable
        };
        subs.push(subscriptionobj);
        return subscriptionobj;
    },

    /**
     * Stops listening to a single listenable
     *
     * @param {Action|Store} listenable The action or store we no longer want to listen to
     * @returns {Boolean} True if a subscription was found and removed, otherwise false.
     */
    stopListeningTo: function(listenable){
        var sub, i = 0, subs = this.subscriptions || [];
        for(;i < subs.length; i++){
            sub = subs[i];
            if (sub.listenable === listenable){
                sub.stop();
                _.throwIf(subs.indexOf(sub)!==-1,'Failed to remove listen from subscriptions list!');
                return true;
            }
        }
        return false;
    },

    /**
     * Stops all subscriptions and empties subscriptions array
     */
    stopListeningToAll: function(){
        var remaining, subs = this.subscriptions || [];
        while((remaining=subs.length)){
            subs[0].stop();
            _.throwIf(subs.length!==remaining-1,'Failed to remove listen from subscriptions list!');
        }
    },

    /**
     * Used in `listenTo`. Fetches initial data from a publisher if it has a `getInitialState` method.
     * @param {Action|Store} listenable The publisher we want to get initial state from
     * @param {Function|String} defaultCallback The method to receive the data
     */
    fetchInitialState: function (listenable, defaultCallback) {
        defaultCallback = (defaultCallback && this[defaultCallback]) || defaultCallback;
        var me = this;
        if (_.isFunction(defaultCallback) && _.isFunction(listenable.getInitialState)) {
            data = listenable.getInitialState();
            if (data && _.isFunction(data.then)) {
                data.then(function() {
                    defaultCallback.apply(me, arguments);
                });
            } else {
                defaultCallback.call(this, data);
            }
        }
    },

    /**
     * The callback will be called once all listenables have triggered at least once.
     * It will be invoked with the last emission from each listenable.
     * @param {...Publishers} publishers Publishers that should be tracked.
     * @param {Function|String} callback The method to call when all publishers have emitted
     * @returns {Object} A subscription obj where `stop` is an unsub function and `listenable` is an array of listenables
     */
    joinTrailing: maker("last"),

    /**
     * The callback will be called once all listenables have triggered at least once.
     * It will be invoked with the first emission from each listenable.
     * @param {...Publishers} publishers Publishers that should be tracked.
     * @param {Function|String} callback The method to call when all publishers have emitted
     * @returns {Object} A subscription obj where `stop` is an unsub function and `listenable` is an array of listenables
     */
    joinLeading: maker("first"),

    /**
     * The callback will be called once all listenables have triggered at least once.
     * It will be invoked with all emission from each listenable.
     * @param {...Publishers} publishers Publishers that should be tracked.
     * @param {Function|String} callback The method to call when all publishers have emitted
     * @returns {Object} A subscription obj where `stop` is an unsub function and `listenable` is an array of listenables
     */
    joinConcat: maker("all"),

    /**
     * The callback will be called once all listenables have triggered.
     * If a callback triggers twice before that happens, an error is thrown.
     * @param {...Publishers} publishers Publishers that should be tracked.
     * @param {Function|String} callback The method to call when all publishers have emitted
     * @returns {Object} A subscription obj where `stop` is an unsub function and `listenable` is an array of listenables
     */
    joinStrict: maker("strict"),
};

},{"./joins":22,"./utils":25}],14:[function(require,module,exports){
var _ = require('./utils'),
    ListenerMethods = require('./ListenerMethods');

/**
 * A module meant to be consumed as a mixin by a React component. Supplies the methods from
 * `ListenerMethods` mixin and takes care of teardown of subscriptions.
 * Note that if you're using the `connect` mixin you don't need this mixin, as connect will
 * import everything this mixin contains!
 */
module.exports = _.extend({

    /**
     * Cleans up all listener previously registered.
     */
    componentWillUnmount: ListenerMethods.stopListeningToAll

}, ListenerMethods);

},{"./ListenerMethods":13,"./utils":25}],15:[function(require,module,exports){
var _ = require('./utils');

/**
 * A module of methods for object that you want to be able to listen to.
 * This module is consumed by `createStore` and `createAction`
 */
module.exports = {

    /**
     * Hook used by the publisher that is invoked before emitting
     * and before `shouldEmit`. The arguments are the ones that the action
     * is invoked with. If this function returns something other than
     * undefined, that will be passed on as arguments for shouldEmit and
     * emission.
     */
    preEmit: function() {},

    /**
     * Hook used by the publisher after `preEmit` to determine if the
     * event should be emitted with given arguments. This may be overridden
     * in your application, default implementation always returns true.
     *
     * @returns {Boolean} true if event should be emitted
     */
    shouldEmit: function() { return true; },

    /**
     * Subscribes the given callback for action triggered
     *
     * @param {Function} callback The callback to register as event handler
     * @param {Mixed} [optional] bindContext The context to bind the callback with
     * @returns {Function} Callback that unsubscribes the registered event handler
     */
    listen: function(callback, bindContext) {
        var eventHandler = function(args) {
            callback.apply(bindContext, args);
        }, me = this;
        this.emitter.addListener(this.eventLabel, eventHandler);
        return function() {
            me.emitter.removeListener(me.eventLabel, eventHandler);
        };
    },

    /**
     * Publishes an event using `this.emitter` (if `shouldEmit` agrees)
     */
    trigger: function() {
        var args = arguments,
            pre = this.preEmit.apply(this, args);
        args = pre === undefined ? args : _.isArguments(pre) ? pre : [].concat(pre);
        if (this.shouldEmit.apply(this, args)) {
            this.emitter.emit(this.eventLabel, args);
        }
    },

    /**
     * Tries to publish the event on the next tick
     */
    triggerAsync: function(){
        var args = arguments,me = this;
        _.nextTick(function() {
            me.trigger.apply(me, args);
        });
    }
};

},{"./utils":25}],16:[function(require,module,exports){
/**
 * A module of methods that you want to include in all stores.
 * This module is consumed by `createStore`.
 */
module.exports = {
};

},{}],17:[function(require,module,exports){
module.exports = function(store, definition) {
  for (var name in definition) {
    var property = definition[name];

    if (typeof property !== 'function' || !definition.hasOwnProperty(name)) {
      continue;
    }

    store[name] = property.bind(store);
  }

  return store;
};

},{}],18:[function(require,module,exports){
var Reflux = require('../src'),
    _ = require('./utils');

module.exports = function(listenable,key){
    return {
        getInitialState: function(){
            if (!_.isFunction(listenable.getInitialState)) {
                return {};
            } else if (key === undefined) {
                return listenable.getInitialState();
            } else {
                return _.object([key],[listenable.getInitialState()]);
            }
        },
        componentDidMount: function(){
            var warned = false;
            for(var m in Reflux.ListenerMethods){
                if (this[m] && typeof console && typeof console.warn === "function" && !warned ){
                    console.warn(
                        "Component using Reflux.connect already had property '"+m+"'. "+
                        "Either you had your own property with that name which was now overridden, "+
                        "or you combined connect with ListenerMixin which is unnecessary as connect "+
                        "will include the ListenerMixin methods automatically."
                    );
                    warned = true;
                }
                this[m] = Reflux.ListenerMethods[m];
            }
            var me = this, cb = (key === undefined ? this.setState : function(v){me.setState(_.object([key],[v]));});
            this.listenTo(listenable,cb);
        },
        componentWillUnmount: Reflux.ListenerMixin.componentWillUnmount
    };
};

},{"../src":21,"./utils":25}],19:[function(require,module,exports){
var _ = require('./utils'),
    Reflux = require('../src'),
    Keep = require('./Keep'),
    allowed = {preEmit:1,shouldEmit:1};

/**
 * Creates an action functor object. It is mixed in with functions
 * from the `PublisherMethods` mixin. `preEmit` and `shouldEmit` may
 * be overridden in the definition object.
 *
 * @param {Object} definition The action object definition
 */
module.exports = function(definition) {

    definition = definition || {};

    for(var a in Reflux.ActionMethods){
        if (!allowed[a] && Reflux.PublisherMethods[a]) {
            throw new Error("Cannot override API method " + a +
                " in Reflux.ActionMethods. Use another method name or override it on Reflux.PublisherMethods instead."
            );
        }
    }

    for(var d in definition){
        if (!allowed[d] && Reflux.PublisherMethods[d]) {
            throw new Error("Cannot override API method " + d +
                " in action creation. Use another method name or override it on Reflux.PublisherMethods instead."
            );
        }
    }

    var context = _.extend({
        eventLabel: "action",
        emitter: new _.EventEmitter(),
        _isAction: true
    }, Reflux.PublisherMethods, Reflux.ActionMethods, definition);

    var functor = function() {
        functor[functor.sync?"trigger":"triggerAsync"].apply(functor, arguments);
    };

    _.extend(functor,context);

    Keep.createdActions.push(functor);

    return functor;

};

},{"../src":21,"./Keep":12,"./utils":25}],20:[function(require,module,exports){
var _ = require('./utils'),
    Reflux = require('../src'),
    Keep = require('./Keep'),
    allowed = {preEmit:1,shouldEmit:1},
    bindMethods = require('./bindMethods');

/**
 * Creates an event emitting Data Store. It is mixed in with functions
 * from the `ListenerMethods` and `PublisherMethods` mixins. `preEmit`
 * and `shouldEmit` may be overridden in the definition object.
 *
 * @param {Object} definition The data store object definition
 * @returns {Store} A data store instance
 */
module.exports = function(definition) {

    definition = definition || {};

    for(var a in Reflux.StoreMethods){
        if (!allowed[a] && (Reflux.PublisherMethods[a] || Reflux.ListenerMethods[a])){
            throw new Error("Cannot override API method " + a + 
                " in Reflux.StoreMethods. Use another method name or override it on Reflux.PublisherMethods / Reflux.ListenerMethods instead."
            );
        }
    }

    for(var d in definition){
        if (!allowed[d] && (Reflux.PublisherMethods[d] || Reflux.ListenerMethods[d])){
            throw new Error("Cannot override API method " + d + 
                " in store creation. Use another method name or override it on Reflux.PublisherMethods / Reflux.ListenerMethods instead."
            );
        }
    }

    function Store() {
        var i=0, arr;
        this.subscriptions = [];
        this.emitter = new _.EventEmitter();
        this.eventLabel = "change";
        if (this.init && _.isFunction(this.init)) {
            this.init();
        }
        if (this.listenables){
            arr = [].concat(this.listenables);
            for(;i < arr.length;i++){
                this.listenToMany(arr[i]);
            }
        }
    }

    _.extend(Store.prototype, Reflux.ListenerMethods, Reflux.PublisherMethods, Reflux.StoreMethods, definition);

    var store = new Store();
    bindMethods(store, definition);
    Keep.createdStores.push(store);

    return store;
};

},{"../src":21,"./Keep":12,"./bindMethods":17,"./utils":25}],21:[function(require,module,exports){
exports.ActionMethods = require('./ActionMethods');

exports.ListenerMethods = require('./ListenerMethods');

exports.PublisherMethods = require('./PublisherMethods');

exports.StoreMethods = require('./StoreMethods');

exports.createAction = require('./createAction');

exports.createStore = require('./createStore');

exports.connect = require('./connect');

exports.ListenerMixin = require('./ListenerMixin');

exports.listenTo = require('./listenTo');

exports.listenToMany = require('./listenToMany');


var maker = require('./joins').staticJoinCreator;

exports.joinTrailing = exports.all = maker("last"); // Reflux.all alias for backward compatibility

exports.joinLeading = maker("first");

exports.joinStrict = maker("strict");

exports.joinConcat = maker("all");


/**
 * Convenience function for creating a set of actions
 *
 * @param actionNames the names for the actions to be created
 * @returns an object with actions of corresponding action names
 */
exports.createActions = function(actionNames) {
    var i = 0, actions = {};
    for (; i < actionNames.length; i++) {
        actions[actionNames[i]] = exports.createAction();
    }
    return actions;
};

/**
 * Sets the eventmitter that Reflux uses
 */
exports.setEventEmitter = function(ctx) {
    var _ = require('./utils');
    _.EventEmitter = ctx;
};

/**
 * Sets the method used for deferring actions and stores
 */
exports.nextTick = function(nextTick) {
    var _ = require('./utils');
    _.nextTick = nextTick;
};

/**
 * Provides the set of created actions and stores for introspection
 */
exports.__keep = require('./Keep');

/**
 * Warn if Function.prototype.bind not available
 */
if (!Function.prototype.bind) {
  console.error(
    'Function.prototype.bind not available. ' +
    'ES5 shim required. ' +
    'https://github.com/spoike/refluxjs#es5'
  );
}

},{"./ActionMethods":11,"./Keep":12,"./ListenerMethods":13,"./ListenerMixin":14,"./PublisherMethods":15,"./StoreMethods":16,"./connect":18,"./createAction":19,"./createStore":20,"./joins":22,"./listenTo":23,"./listenToMany":24,"./utils":25}],22:[function(require,module,exports){
/**
 * Internal module used to create static and instance join methods
 */

var slice = Array.prototype.slice,
    _ = require("./utils"),
    createStore = require("./createStore"),
    strategyMethodNames = {
        strict: "joinStrict",
        first: "joinLeading",
        last: "joinTrailing",
        all: "joinConcat"
    };

/**
 * Used in `index.js` to create the static join methods
 * @param {String} strategy Which strategy to use when tracking listenable trigger arguments
 * @returns {Function} A static function which returns a store with a join listen on the given listenables using the given strategy
 */
exports.staticJoinCreator = function(strategy){
    return function(/* listenables... */) {
        var listenables = slice.call(arguments);
        return createStore({
            init: function(){
                this[strategyMethodNames[strategy]].apply(this,listenables.concat("triggerAsync"));
            }
        });
    };
};

/**
 * Used in `ListenerMethods.js` to create the instance join methods
 * @param {String} strategy Which strategy to use when tracking listenable trigger arguments
 * @returns {Function} An instance method which sets up a join listen on the given listenables using the given strategy
 */
exports.instanceJoinCreator = function(strategy){
    return function(/* listenables..., callback*/){
        _.throwIf(arguments.length < 3,'Cannot create a join with less than 2 listenables!');
        var listenables = slice.call(arguments),
            callback = listenables.pop(),
            numberOfListenables = listenables.length,
            join = {
                numberOfListenables: numberOfListenables,
                callback: this[callback]||callback,
                listener: this,
                strategy: strategy
            }, i, cancels = [], subobj;
        for (i = 0; i < numberOfListenables; i++) {
            _.throwIf(this.validateListening(listenables[i]));
        }
        for (i = 0; i < numberOfListenables; i++) {
            cancels.push(listenables[i].listen(newListener(i,join),this));
        }
        reset(join);
        subobj = {listenable: listenables};
        subobj.stop = makeStopper(subobj,cancels,this);
        this.subscriptions = (this.subscriptions || []).concat(subobj);
        return subobj;
    };
};

// ---- internal join functions ----

function makeStopper(subobj,cancels,context){
    return function() {
        var i, subs = context.subscriptions;
            index = (subs ? subs.indexOf(subobj) : -1);
        _.throwIf(index === -1,'Tried to remove join already gone from subscriptions list!');
        for(i=0;i < cancels.length; i++){
            cancels[i]();
        }
        subs.splice(index, 1);
    };
}

function reset(join) {
    join.listenablesEmitted = new Array(join.numberOfListenables);
    join.args = new Array(join.numberOfListenables);
}

function newListener(i,join) {
    return function() {
        var callargs = slice.call(arguments);
        if (join.listenablesEmitted[i]){
            switch(join.strategy){
                case "strict": throw new Error("Strict join failed because listener triggered twice.");
                case "last": join.args[i] = callargs; break;
                case "all": join.args[i].push(callargs);
            }
        } else {
            join.listenablesEmitted[i] = true;
            join.args[i] = (join.strategy==="all"?[callargs]:callargs);
        }
        emitIfAllListenablesEmitted(join);
    };
}

function emitIfAllListenablesEmitted(join) {
    for (var i = 0; i < join.numberOfListenables; i++) {
        if (!join.listenablesEmitted[i]) {
            return;
        }
    }
    join.callback.apply(join.listener,join.args);
    reset(join);
}

},{"./createStore":20,"./utils":25}],23:[function(require,module,exports){
var Reflux = require('../src');


/**
 * A mixin factory for a React component. Meant as a more convenient way of using the `ListenerMixin`,
 * without having to manually set listeners in the `componentDidMount` method.
 *
 * @param {Action|Store} listenable An Action or Store that should be
 *  listened to.
 * @param {Function|String} callback The callback to register as event handler
 * @param {Function|String} defaultCallback The callback to register as default handler
 * @returns {Object} An object to be used as a mixin, which sets up the listener for the given listenable.
 */
module.exports = function(listenable,callback,initial){
    return {
        /**
         * Set up the mixin before the initial rendering occurs. Import methods from `ListenerMethods`
         * and then make the call to `listenTo` with the arguments provided to the factory function
         */
        componentDidMount: function() {
            for(var m in Reflux.ListenerMethods){
                if (this[m] !== Reflux.ListenerMethods[m]){
                    if (this[m]){
                        throw "Can't have other property '"+m+"' when using Reflux.listenTo!";
                    }
                    this[m] = Reflux.ListenerMethods[m];
                }
            }
            this.listenTo(listenable,callback,initial);
        },
        /**
         * Cleans up all listener previously registered.
         */
        componentWillUnmount: Reflux.ListenerMethods.stopListeningToAll
    };
};

},{"../src":21}],24:[function(require,module,exports){
var Reflux = require('../src');

/**
 * A mixin factory for a React component. Meant as a more convenient way of using the `listenerMixin`,
 * without having to manually set listeners in the `componentDidMount` method. This version is used
 * to automatically set up a `listenToMany` call.
 *
 * @param {Object} listenables An object of listenables
 * @returns {Object} An object to be used as a mixin, which sets up the listeners for the given listenables.
 */
module.exports = function(listenables){
    return {
        /**
         * Set up the mixin before the initial rendering occurs. Import methods from `ListenerMethods`
         * and then make the call to `listenTo` with the arguments provided to the factory function
         */
        componentDidMount: function() {
            for(var m in Reflux.ListenerMethods){
                if (this[m] !== Reflux.ListenerMethods[m]){
                    if (this[m]){
                        throw "Can't have other property '"+m+"' when using Reflux.listenToMany!";
                    }
                    this[m] = Reflux.ListenerMethods[m];
                }
            }
            this.listenToMany(listenables);
        },
        /**
         * Cleans up all listener previously registered.
         */
        componentWillUnmount: Reflux.ListenerMethods.stopListeningToAll
    };
};

},{"../src":21}],25:[function(require,module,exports){
/*
 * isObject, extend, isFunction, isArguments are taken from undescore/lodash in
 * order to remove the dependency
 */
var isObject = exports.isObject = function(obj) {
    var type = typeof obj;
    return type === 'function' || type === 'object' && !!obj;
};

exports.extend = function(obj) {
    if (!isObject(obj)) {
        return obj;
    }
    var source, prop;
    for (var i = 1, length = arguments.length; i < length; i++) {
        source = arguments[i];
        for (prop in source) {
            obj[prop] = source[prop];
        }
    }
    return obj;
};

exports.isFunction = function(value) {
    return typeof value === 'function';
};

exports.EventEmitter = require('eventemitter3');

exports.nextTick = function(callback) {
    setTimeout(callback, 0);
};

exports.callbackName = function(string){
    return "on"+string.charAt(0).toUpperCase()+string.slice(1);
};

exports.object = function(keys,vals){
    var o={}, i=0;
    for(;i<keys.length;i++){
        o[keys[i]] = vals[i];
    }
    return o;
};

exports.isArguments = function(value) {
    return value && typeof value == 'object' && typeof value.length == 'number' &&
      (toString.call(value) === '[object Arguments]' || (hasOwnProperty.call(value, 'callee' && !propertyIsEnumerable.call(value, 'callee')))) || false;
};

exports.throwIf = function(val,msg){
    if (val){
        throw Error(msg||val);
    }
};

},{"eventemitter3":10}],26:[function(require,module,exports){
(function (process){
(function (global, undefined) {
    "use strict";

    if (global.setImmediate) {
        return;
    }

    var nextHandle = 1; // Spec says greater than zero
    var tasksByHandle = {};
    var currentlyRunningATask = false;
    var doc = global.document;
    var setImmediate;

    function addFromSetImmediateArguments(args) {
        tasksByHandle[nextHandle] = partiallyApplied.apply(undefined, args);
        return nextHandle++;
    }

    // This function accepts the same arguments as setImmediate, but
    // returns a function that requires no arguments.
    function partiallyApplied(handler) {
        var args = [].slice.call(arguments, 1);
        return function() {
            if (typeof handler === "function") {
                handler.apply(undefined, args);
            } else {
                (new Function("" + handler))();
            }
        };
    }

    function runIfPresent(handle) {
        // From the spec: "Wait until any invocations of this algorithm started before this one have completed."
        // So if we're currently running a task, we'll need to delay this invocation.
        if (currentlyRunningATask) {
            // Delay by doing a setTimeout. setImmediate was tried instead, but in Firefox 7 it generated a
            // "too much recursion" error.
            setTimeout(partiallyApplied(runIfPresent, handle), 0);
        } else {
            var task = tasksByHandle[handle];
            if (task) {
                currentlyRunningATask = true;
                try {
                    task();
                } finally {
                    clearImmediate(handle);
                    currentlyRunningATask = false;
                }
            }
        }
    }

    function clearImmediate(handle) {
        delete tasksByHandle[handle];
    }

    function installNextTickImplementation() {
        setImmediate = function() {
            var handle = addFromSetImmediateArguments(arguments);
            process.nextTick(partiallyApplied(runIfPresent, handle));
            return handle;
        };
    }

    function canUsePostMessage() {
        // The test against `importScripts` prevents this implementation from being installed inside a web worker,
        // where `global.postMessage` means something completely different and can't be used for this purpose.
        if (global.postMessage && !global.importScripts) {
            var postMessageIsAsynchronous = true;
            var oldOnMessage = global.onmessage;
            global.onmessage = function() {
                postMessageIsAsynchronous = false;
            };
            global.postMessage("", "*");
            global.onmessage = oldOnMessage;
            return postMessageIsAsynchronous;
        }
    }

    function installPostMessageImplementation() {
        // Installs an event handler on `global` for the `message` event: see
        // * https://developer.mozilla.org/en/DOM/window.postMessage
        // * http://www.whatwg.org/specs/web-apps/current-work/multipage/comms.html#crossDocumentMessages

        var messagePrefix = "setImmediate$" + Math.random() + "$";
        var onGlobalMessage = function(event) {
            if (event.source === global &&
                typeof event.data === "string" &&
                event.data.indexOf(messagePrefix) === 0) {
                runIfPresent(+event.data.slice(messagePrefix.length));
            }
        };

        if (global.addEventListener) {
            global.addEventListener("message", onGlobalMessage, false);
        } else {
            global.attachEvent("onmessage", onGlobalMessage);
        }

        setImmediate = function() {
            var handle = addFromSetImmediateArguments(arguments);
            global.postMessage(messagePrefix + handle, "*");
            return handle;
        };
    }

    function installMessageChannelImplementation() {
        var channel = new MessageChannel();
        channel.port1.onmessage = function(event) {
            var handle = event.data;
            runIfPresent(handle);
        };

        setImmediate = function() {
            var handle = addFromSetImmediateArguments(arguments);
            channel.port2.postMessage(handle);
            return handle;
        };
    }

    function installReadyStateChangeImplementation() {
        var html = doc.documentElement;
        setImmediate = function() {
            var handle = addFromSetImmediateArguments(arguments);
            // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
            // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
            var script = doc.createElement("script");
            script.onreadystatechange = function () {
                runIfPresent(handle);
                script.onreadystatechange = null;
                html.removeChild(script);
                script = null;
            };
            html.appendChild(script);
            return handle;
        };
    }

    function installSetTimeoutImplementation() {
        setImmediate = function() {
            var handle = addFromSetImmediateArguments(arguments);
            setTimeout(partiallyApplied(runIfPresent, handle), 0);
            return handle;
        };
    }

    // If supported, we should attach to the prototype of global, since that is where setTimeout et al. live.
    var attachTo = Object.getPrototypeOf && Object.getPrototypeOf(global);
    attachTo = attachTo && attachTo.setTimeout ? attachTo : global;

    // Don't get fooled by e.g. browserify environments.
    if ({}.toString.call(global.process) === "[object process]") {
        // For Node.js before 0.9
        installNextTickImplementation();

    } else if (canUsePostMessage()) {
        // For non-IE10 modern browsers
        installPostMessageImplementation();

    } else if (global.MessageChannel) {
        // For web workers, where supported
        installMessageChannelImplementation();

    } else if (doc && "onreadystatechange" in doc.createElement("script")) {
        // For IE 6–8
        installReadyStateChangeImplementation();

    } else {
        // For older browsers
        installSetTimeoutImplementation();
    }

    attachTo.setImmediate = setImmediate;
    attachTo.clearImmediate = clearImmediate;
}(new Function("return this")()));

}).call(this,require("NPEqJt"))
},{"NPEqJt":27}],27:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}]},{},[1])