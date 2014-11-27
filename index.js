var crel = require('crel');
var parse = require('expression-compiler/parse');
var values = require('expression-compiler/values');


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


function astToDom(node, barElIDMap) {
  barElIDMap = barElIDMap || [];
  return [crel('span',
    {'class': ['expr-node', 'expr-' + node.node].join(' ')},
    node.template.split('#').reduce(function(pieces, nextPiece, idx) {
      pieces.push(nextPiece);
      if (idx <= node.children.length - 1) {
        pieces.push(astToDom(node.children[idx], barElIDMap)[0]);
      }
      return pieces;
    }, [barElIDMap[node.id] = crel('span', {'class': 'bar'})])
  ), barElIDMap];
}


function emptyEl(el) {
  while (el.firstChild) { el.removeChild(el.firstChild); }
}


function css(el, styles) {
  el.setAttribute('style', Object.keys(styles).map(function(key) {
    return [key, styles[key]].join(':');
  }).join(';'));
}


function logify(num) {
  // return 18 * Math.log(Math.abs(num) + 1);
  return 32 * Math.abs(num);
}


function ctxValue(options) {
  options = extend({type: 'const', value: 1}, options || {});
  return {
    type: options.type,
    value: options.value,
    min: options.min || Math.min(options.value, 0),
    max: options.max || Math.max(options.value, 10)
  };
}


function updateContext(prev, newAST) {
  var newContext = {};
  (function walk(node) {
    if (node.node === 'name') {  // it's a variable or const name
      var name = node.options.key;
      if (!newContext[name]) {  // we don't have it yet
        newContext[name] = prev[name] || ctxValue();
      }
    }
    node.children.forEach(walk);
  })(newAST);
  return newContext;
}


function getContext(metaContext) {
  return Object.keys(metaContext)
    .map(function(key) { return [key, metaContext[key].value]; })
    .reduce(function(ctx, thisCtx) {
      ctx[thisCtx[0]] = thisCtx[1];
      return ctx;
    }, {});
}


function rangeNorm(context, value) {
  return (value - context.min) / (context.max - context.min);
}
function unrange(context, value) {
  return value * (context.max - context.min) + context.min;
}


(function() {
  var inputEl,
      domAstEl,
      ctxEl,
      exprAST,
      valuer,
      metaContext = {},
      barElIDMap = [];
  crel(document.getElementById('expression'),
    domAstEl = crel('div', {'class': 'expr'}),
    inputEl = crel('input', {'class': 'expr-input expr-input-expression'}),
    ctxEl = crel('div')
  );


  function updateAST(str) {
    exprAST = parse(str);
    valuer = values.fromAST(exprAST);
    renderDOMAST(exprAST);
    metaContext = updateContext(metaContext, exprAST);
    renderContext(metaContext);
    scaleBars(getContext(metaContext));
  }


  function renderDOMAST(ast) {
    var parts = astToDom(ast);
    emptyEl(domAstEl);
    crel(domAstEl, parts[0]);
    barElIDMap = parts[1];
  }


  function renderChoice(ctxKey, group, key, name, selected) {
    var groupKey = [group, key].join('-'),
        inputAttrs = {
      'type': 'radio',
      'id': groupKey,
      'name': group,
      'data-key': key,
      'data-ctx': ctxKey
    };
    if (selected === key) { inputAttrs.checked = true; }
    return crel('span', {'class': 'expr-choice'},
      crel('input', inputAttrs),
      crel('label', {'for': groupKey}, name));
  }


  function renderContextInput(key, context, id) {
    if (context.type === 'const') {
      return crel('input', {
        'id': id,
        'class': 'expr-input expr-input-const',
        'value': context.value,
        'data-name': key
      });
    } else {
      return crel('span',
        crel('label',
          'min:',
          crel('input', {
            'class': 'expr-input expr-input-range-bound',
            'value': context.min,
            'data-name': key,
            'data-bound': 'min'
          })),
        crel('input', {
          'id': id,
          'type': 'range',
          'class': 'expr-input expr-input-range',
          'value': rangeNorm(context, context.value),
          'min': 0,
          'max': 1,
          'step': 0.001,
          'data-name': key
        }),
        crel('label',
          'max:',
          crel('input', {
            'class': 'expr-input expr-input-range-bound',
            'value': context.max,
            'data-name': key,
            'data-bound': 'max'
          })));
    }
  }


  function renderContext(metaContext) {
    var ctxId,
        context;
    emptyEl(ctxEl);
    crel(ctxEl, {'class': 'expr-consts'},
      crel('ul', Object.keys(metaContext).map(function(key) {
        context = metaContext[key];
        ctxId = 'ctx-' + key;
        return crel('li',
          crel('label', {'for': ctxId}, key, ' = '),
          crel('span',
            renderChoice(key, ctxId + '-type', 'const', 'const', context.type),
            renderChoice(key, ctxId + '-type', 'range', 'variable', context.type)),
          renderContextInput(key, context, ctxId));
      })));
  }


  function scaleBars(ctx) {
    valuer(ctx).forEach(function(val, i) {
      css(barElIDMap[i], {height: logify(val) + 'px'});
      barElIDMap[i].classList[val < 0 ? 'add' : 'remove']('negative');
    });
  }


  function persist() {
    var state = {
      expr: inputEl.value,
      ctx: metaContext
    };
    window.removeEventListener('hashchange', updateOnHash, false);
    window.location.hash = encodeURIComponent(JSON.stringify(state));
    window.setTimeout(function() { // reattach later so it doesn't fire now...
      window.addEventListener('hashchange', updateOnHash, false);
    }, 0);
  }
  function unpersist(state) {
    inputEl.value = state.expr;
    metaContext = state.ctx;
    updateAST(state.expr);
  }


  function updateOnHash() {
    if (window.location.hash.slice(1)) {
      try {
        var state = JSON.parse(decodeURIComponent(window.location.hash.slice(1)));
        unpersist(state);
      } catch (e) {
        console.error('could not load stat from url hash');
      }
    }
  }


  function updateOnInput(e) {
    var str = e.currentTarget.value;
    updateAST(str);
    persist();
  }


  function updateConst(input, val) {
    metaContext[input.dataset.name].value = val;
    scaleBars(getContext(metaContext));
  }


  function updateRangeBound(input, val) {
    var ctx = metaContext[input.dataset.name],
        data = input.dataset;
    ctx[data.bound] = val;
    ctx.value = Math[data.bound === 'min' ? 'max' : 'min'](ctx.value, ctx[data.bound]);
    scaleBars(getContext(metaContext));
  }


  function updateOnCtxInput(e) {
    var input = e.target,
        val = parseFloat(input.value);
    input.classList[isNaN(val) ? 'add' : 'remove']('err');  // warn for NaN
    if (input.classList.contains('expr-input-const')) {
      updateConst(input, val);
    }
  }


  function updateOnCtxChange(e) {
    var input = e.target;
    if (input.classList.contains('expr-input-range-bound')) {
      updateRangeBound(input, parseFloat(input.value));
      persist();
    } else if (input.getAttribute('type') === 'radio') {
      var ctxKey = input.dataset.ctx;
      metaContext[ctxKey] = ctxValue(extend(metaContext[ctxKey], { type: input.dataset.key }));
      persist();
    } else if (input.classList.contains('expr-input-range')) {
      persist();
    } else {
      return;
    }
    renderContext(metaContext);  // maybe be more targeted?
  }


  function updateOnCtxSliderDrag(e) {
    var input = e.target;
    if (input.getAttribute('type') !== 'range') { return; }
    var ctx = metaContext[input.dataset.name];
    ctx.value = unrange(ctx, input.value);
    scaleBars(getContext(metaContext));
  }


  inputEl.addEventListener('keyup', updateOnInput, false);
  ctxEl.addEventListener('keyup', updateOnCtxInput, false);  // TODO: use change as well
  ctxEl.addEventListener('change', updateOnCtxChange, false);
  ctxEl.addEventListener('input', updateOnCtxSliderDrag, false);  // TODO: change, etc.
  window.addEventListener('hashchange', updateOnHash, false);
  updateOnHash();  // force one on pageload;

})();
