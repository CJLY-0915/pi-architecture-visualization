'use strict';

// The single total order over strings used by every sorted collection.
//
// `<`/`>` on primitives compares code units, so the order is locale- and
// platform-independent and the same model always yields the same byte order.
// Callers must not substitute `localeCompare`, which is not deterministic
// across hosts and would break reproducible output.

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

module.exports = { compareStrings };
