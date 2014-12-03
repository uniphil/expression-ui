require('es5-shim');  // patches globals
require('setimmediate');  // attaches to the global
var crel = require('crel');
var Reflux = require('reflux');
var MainComponent = require('./components').Main;


// config for reflux... would be nice if this didn't mutate global reflux...
Reflux.nextTick(window.setImmediate);


crel(document.getElementById('expression'), new MainComponent().render());
