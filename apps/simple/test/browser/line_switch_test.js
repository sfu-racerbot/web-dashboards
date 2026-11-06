'use strict';
const assert = require('assert');
const apex = require('../../web/apex.js');
// oracle: the node's refusal must reach the user unchanged as plain text.
assert.strictEqual(apex.lineSwitchResult({ok: false, reason: 'release LB'}),
  'Line switch refused: release LB');
assert.strictEqual(apex.lineSwitchResult({ok: true}),
  'Line validated and queued. Release LB, then press LB while stopped to apply.');
assert.strictEqual(apex.lineSwitchResult({ok: false}),
  'Line switch refused: rejected by the node');
console.log('3 checks passed');
