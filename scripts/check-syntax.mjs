import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const directory of ['.', 'scripts', 'tests']) {
  for (const file of readdirSync(directory).filter(name => /\.(?:mjs|js)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('All application, Worker, scripts and test modules passed syntax checks.');
