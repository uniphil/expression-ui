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
  return 18 * Math.log(Math.abs(num) + 1);
}


function mute(el, ev, listener, fn, thisArg, args) {
  el.removeEventListener(ev, listener, false);
  console.log('removed???');
  fn.apply(thisArg, args);
  console.log('readding...');
  function faker() {}
  el.addEventListener(ev, faker, false);
  el.removeEventListener(ev, faker, false);
  console.log('readding...');
  el.addEventListener(ev, listener, false);
}


(function() {
  var inputEl,
      domAstEl,
      exprAST,
      valuer,
      barElIDMap = [];
  crel(document.getElementById('expression'),
    // jscs:disable disallowQuotedKeysInObjects
    domAstEl = crel('pre', {'class': 'expr'}),
    // jscs:enable disallowQuotedKeysInObjects
    inputEl = crel('input')
  );


  function updateAST(str) {
    exprAST = parse(str);
    valuer = values.fromAST(exprAST);
    renderDOMAST(exprAST);
    scaleBars();
  }


  function renderDOMAST(ast) {
    var parts = astToDom(ast);
    emptyEl(domAstEl);
    crel(domAstEl, parts[0]);
    barElIDMap = parts[1];
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
  inputEl.addEventListener('keyup', updateOnInput, false);
  window.addEventListener('hashchange', updateOnHash, false);
  updateOnHash();  // force one on pageload;

})();
