var crel = require('crel');
var parse = require('expression-compiler/parse');
var values = require('expression-compiler/values');



function astToDom(node, barElIDMap) {
  // jscs:disable disallowQuotedKeysInObjects
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
  // jscs:enable disallowQuotedKeysInObjects
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


function ctxConst() {
  return {
    type: 'const',
    value: 1
  };
}


function updateContext(prev, newAST) {
  var newContext = {};
  (function walk(node) {
    if (node.node === 'name') {  // it's a variable or const name
      var name = node.options.key;
      if (!newContext[name]) {  // we don't have it yet
        newContext[name] = prev[name] || ctxConst();
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


(function() {
  var inputEl,
      domAstEl,
      ctxEl,
      exprAST,
      valuer,
      metaContext = {},
      barElIDMap = [];
  crel(document.getElementById('expression'),
    // jscs:disable disallowQuotedKeysInObjects
    domAstEl = crel('div', {'class': 'expr'}),
    inputEl = crel('input', {'class': 'expr-input expr-input-expression'}),
    ctxEl = crel('div')
    // jscs:enable disallowQuotedKeysInObjects
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


  function renderContext(metaContext) {
    // jscs:disable disallowQuotedKeysInObjects
    emptyEl(ctxEl);
    crel(ctxEl, {'class': 'expr-consts'},
      crel('ul', Object.keys(metaContext).map(function(key) {
        return crel('li',
          crel('label',
            key + ' = ',
            crel('input', {
              'class': 'expr-input expr-input-const',
              'value': metaContext[key].value,
              'data-name': key
            })
          )
        );
      }))
    );
    // jscs:enable disallowQuotedKeysInObjects
  }


  function scaleBars(ctx) {
    valuer(ctx).forEach(function(val, i) {
      css(barElIDMap[i], {height: logify(val) + 'px'});
      barElIDMap[i].classList[val < 0 ? 'add' : 'remove']('negative');
    });
  }


  function updateOnHash() {
    var str = window.location.hash.slice(1);  // remove '#';
    inputEl.value = str;
    updateAST(str);
  }


  function updateOnInput(e) {
    var str = e.currentTarget.value;
    updateAST(str);
    window.removeEventListener('hashchange', updateOnHash, false);
    window.location.hash = str;
    window.setTimeout(function() {
      // reattach later so it doesn't fire now...
      window.addEventListener('hashchange', updateOnHash, false);
    }, 0);
  }


  function updateOnConstInput(e) {
    var constInput = e.target,
        newValue = parseFloat(constInput.value);
    constInput.classList[isNaN(newValue) ? 'add' : 'remove']('err');  // warn for NaN
    window.ci = constInput;
    metaContext[constInput.dataset.name].value = newValue;
    scaleBars(getContext(metaContext));
  }

  inputEl.addEventListener('keyup', updateOnInput, false);
  ctxEl.addEventListener('keyup', updateOnConstInput, false);
  window.addEventListener('hashchange', updateOnHash, false);
  updateOnHash();  // force one on pageload;

})();
