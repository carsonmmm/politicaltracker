// Runs the app against the fake upstream (obviously fake "Test Candidate" data)
// so every screen can be seen without network access or API keys.
//   npm run demo   ->  http://localhost:8081
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midterm-demo-'));
const up = 'http://localhost:9090';
const kids = [];
const run = (args, env = {}) => {
  const c = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  kids.push(c);
  c.on('exit', (code) => { if (code) { console.error(`${args[0]} exited with ${code}`); stop(); } });
};
const stop = () => { kids.forEach((k) => k.kill()); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run(['test/mock-upstream.js']);
setTimeout(() => {
  run(['server/index.js'], {
    PORT: '8081',
    DATA_DIR: dataDir,
    ADMIN_TOKEN: 'demo',
    CANDIDATES_FILE: path.join(root, 'test/fixtures/fake-candidates.json'),
    MEASURES_FILE: path.join(root, 'test/fixtures/fake-measures.json'),
    DATAVERSE_BASE: `${up}/dataverse`,
    VOTEVIEW_BASE: `${up}/voteview`,
    CONGRESS_BASE: `${up}/congress`,
    HOUSE_CLERK_BASE: `${up}/clerk`,
    SENATE_EFD_BASE: `${up}/efd`,
    KALSHI_BASE: `${up}/kalshi`,
    POLYMARKET_BASE: `${up}/poly`,
    POLYMARKET_CLOB: `${up}/clob`,
    AP_BASE: `${up}/ap`,
    AP_API_KEY: 'fake',
    FEC_BASE: `${up}/fec`,
    FEC_API_KEY: 'fake',
  });
  console.log('\nDEMO with FAKE data: open http://localhost:8081  (admin password: demo)\n');
}, 800);
