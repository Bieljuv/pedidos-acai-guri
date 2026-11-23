const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const icons = fs.readFileSync(path.join(root, 'public/icons.js'), 'utf8');
const ids = [...icons.matchAll(/id="i-([a-z0-9-]+)"/g)].map(m => m[1]);
const consumers = [
  'public/index.html', 'public/painel.html', 'public/motoboy.html',
  'public/loja.js', 'public/painel.js', 'public/motoboy.js',
];
const blob = consumers.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const unused = ids.filter(id => {
  const re = new RegExp('(i-' + id + '(?![a-z0-9-])|[\\\'"]' + id + '[\\\'"])');
  return !re.test(blob);
});
console.log('total symbols:', ids.length);
console.log('unused:', unused.join(', ') || '(none)');
let bytes = 0;
for (const id of unused) {
  const m = icons.match(new RegExp('<symbol id="i-' + id + '"[\\s\\S]*?</symbol>'));
  if (m) bytes += m[0].length;
  console.log(id, m ? m[0].length : 0, 'chars');
}
console.log('unused chars:', bytes, 'of', icons.length);
