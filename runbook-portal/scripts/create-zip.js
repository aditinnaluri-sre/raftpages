const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = process.cwd();
const stage = path.join(process.env.TEMP || '/tmp', 'runbook-prod-stage');
const appStage = path.join(stage, 'runbook-portal');

if (fs.existsSync(stage)) {
  fs.rmSync(stage, { recursive: true, force: true });
}
fs.mkdirSync(appStage, { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(sPath, dPath);
    } else {
      fs.copyFileSync(sPath, dPath);
    }
  }
}

console.log('Copying frontend & scripts...');
copyDir(path.join(root, 'src'), path.join(appStage, 'src'));
copyDir(path.join(root, 'public'), path.join(appStage, 'public'));
copyDir(path.join(root, 'scripts'), path.join(appStage, 'scripts'));

console.log('Copying backend server...');
const backendStage = path.join(appStage, 'backend');
fs.mkdirSync(backendStage, { recursive: true });
fs.copyFileSync(path.join(root, 'backend', 'server.js'), path.join(backendStage, 'server.js'));
fs.copyFileSync(path.join(root, 'backend', 'package.json'), path.join(backendStage, 'package.json'));

const rootFiles = ['.env.example', 'index.html', 'package-lock.json', 'package.json', 'pnpm-workspace.yaml', 'postcss.config.js', 'README.md', 'start.sh', 'tailwind.config.js', 'vite.config.js'];
for (const f of rootFiles) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) {
    fs.copyFileSync(p, path.join(appStage, f));
  }
}

const z1 = path.join(root, 'runbook-portal-production.zip');
const z2 = path.join(root, 'floder_name.zip');
const z3 = path.join(root, 'folder_name.zip');

[z1, z2, z3].forEach((z) => {
  if (fs.existsSync(z)) fs.unlinkSync(z);
});

console.log('Creating zip files...');
execSync(`powershell -Command "Compress-Archive -Path '${appStage}\\*' -DestinationPath '${z1}'"`);
fs.copyFileSync(z1, z2);
fs.copyFileSync(z1, z3);

fs.rmSync(stage, { recursive: true, force: true });
console.log('Done!');
