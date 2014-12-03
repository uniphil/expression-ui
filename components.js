var values = require('expression-compiler/values');
var crel = require('crel');
var createComponent = require('./create-component');
var actions = require('./actions');
var stores = require('./stores');
var u = require('./util');


var SLIDER_STEPS = 200;


function rangeNorm(context, value) {
  return (value - context.min) / (context.max - context.min) * SLIDER_STEPS;
}
function unrange(context, value) {
  return value / SLIDER_STEPS * (context.max - context.min) + context.min;
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


var BarsComponent = createComponent({
  init: function() {
    this.listenTo(stores.expressionStore, this.render);
    this.listenTo(u.afterIf(stores.expressionStore, stores.contextStore), this.scaleBars);
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
      logified = u.logify(values[id]);
      u.style(bar, {
        'top': (values[id] > 0 ? (280 - logified) : 280) + 'px',
        'height': logified + 'px'
      });
    });
  },
  render: function(expr) {
    var container = u.style(crel('span', {'class': 'expr-bars'}),
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
    this.listenTo(stores.expressionStore, this.render);
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
    actions.exprActions.change(e.target.value);
    this.updateWidth(e.target.value);
  },
  updateWidth: function(newText) {
    this.widthMeasureEl.textContent = newText;
    var exprWidth = this.widthMeasureEl.offsetWidth,
        widgetWidth = Math.max(456, exprWidth + 32);
    u.style(this.container, {
      'width': widgetWidth + 'px'
    });
    actions.exprActions.changeWidth(exprWidth, widgetWidth);
  },
  render: function() {
    return (this.container = crel('div', {'class': 'expr-input'},
      this.highlighter.render(),
      this.eventEls.input.el = crel('input', {
        'class': 'expr-input-textinput',
        'spellcheck': 'false'}),
      u.style(crel('span',
        this.widthMeasureEl = crel('span', {'class': 'expr-input-highlighted'})), {
        'position': 'absolute',
        'left': '-99999em'
      })));
  }
});


var ContextWidgetComponent = createComponent({
  init: function() {
    this.listenTo(stores.contextStore, this.contextUpdate);
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
    var newValue = u.parseNumba(e.target.value);
    this.maybeChange({value: newValue});
    this.pushSlider(u.parseNumba(e.target.value));
  },
  changeType: function(e) {
    this.maybeChange({type: e.target.value});
  },
  changeMin: function(e) {
    this.maybeChange({min: u.parseNumba(e.target.value)});
  },
  changeMax: function(e) {
    this.maybeChange({max: u.parseNumba(e.target.value)});
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
    if (u.shallowEq(change, this.lastChange)) { return; }
    this.lastChange = change;
    actions.actions.contextChange(this.name, change);
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
          'id': id
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
    this.listenTo(stores.contextStore, this.updateContext);
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


module.exports = {
  Main: MainComponent
};
