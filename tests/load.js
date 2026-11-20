// Loads the browser modules into Node in the same order index.html does.
const path = require('path');
for (const f of ['params', 'fec', 'dsp', 'modulator', 'image', 'receiver', 'sim']) require(path.join(__dirname, '..', 'js', f + '.js'));
module.exports = globalThis.Modem;
