var parseEcho = require('expression-compiler/echo');
var parseToFunc = require('expression-compiler/func');
var Reflux = require('reflux');


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


module.exports = {
  extend: extend,
  emptyEl: emptyEl,
  afterIf: afterIf,
  cleanExpr: cleanExpr,
  parseNumba: parseNumba,
  walkAst: walkAst,
  style: style,
  shallowEq: shallowEq,
  logify: logify
};
