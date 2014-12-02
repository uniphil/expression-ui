var crel = require('crel');
var Reflux = require('reflux');
var util = require('./util');


var ComponentMethods = (function() {
  function modEventListeners(action) {
    return function() {
      var eventDef,
          eventEl;
      Object.keys(this.eventEls).forEach(function(k) {
        eventDef = this.eventEls[k];
        eventEl = eventDef.el;
        if (!eventEl) { return; }
        Object.keys(eventDef)
          .filter(function(k) { return k !== 'el'; })
          .forEach(function(eventName) {
            eventEl[action](eventName, eventDef[eventName].bind(this), false);
          }, this);
      }, this);
    };
  }
  return {
    removeListeners: modEventListeners('removeEventListener'),
    bindListeners: modEventListeners('addEventListener')
  };
})();


module.exports = function(definition) {

  definition = util.extend(definition);

  function Component(tagName, tagOptions) {
    this.el = crel(tagName || 'div', tagOptions || {});
    this.subscriptions = [];
    this.eventEls = this.eventEls || {};

    Object.keys(definition).forEach(function(k) {
      if (typeof definition[k] === 'function') { this[k] = definition[k].bind(this); }
    });

    var definitionRender = definition.render || function() {};
    this.render = function() {
      this.removeListeners();
      util.emptyEl(this.el);
      crel(this.el, definitionRender.apply(this, arguments));
      this.bindListeners();
      return this.el;
    };

    if (this.init && typeof this.init === 'function') { this.init(); }
  }

  util.extend(Component.prototype, Reflux.ListenerMethods, ComponentMethods, definition);

  return Component;
};
