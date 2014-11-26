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
  return 18 * Math.log(num + 1);
}


(function() {
  var inputEl,
      domAstEl,
      exprAST,
      valuer,
      barElIDMap = [];
  crel(document.getElementById('expression'),
    inputEl = crel('input'),
    // jscs:disable disallowQuotedKeysInObjects
    domAstEl = crel('pre', {'class': 'expr'})
    // jscs:enable disallowQuotedKeysInObjects
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
      console.log('bid', barElIDMap);
      css(barElIDMap[i], {height: logify(val) + 'px'});
    });
  }


  function updateASTOnInput(e) { updateAST(e.currentTarget.value); }
  inputEl.addEventListener('keyup', updateASTOnInput);

})();
