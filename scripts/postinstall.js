const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '../node_modules/nth-check/package.json');
if (!fs.existsSync(pkgPath)) process.exit(0);

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.files && pkg.files.some((f) => f.includes('**'))) {
  pkg.files = ['lib'];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
  console.log('postinstall: patched nth-check files field for electron-builder compatibility');
}
