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


module.exports = {
  extend: extend,
  emptyEl: emptyEl
};
