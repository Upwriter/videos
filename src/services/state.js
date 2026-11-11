// Persistência local: <pasta destino>/project_state.json + data/last_project.json (último projeto aberto).
const fs = require('fs');
const path = require('path');
const config = require('../config');

const STATE_FILE = 'project_state.json';
const lastFile = () => path.join(config.dataDir, 'last_project.json');

function statePath(dir) {
  return path.join(dir, STATE_FILE);
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function load(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function save(state) {
  state.updatedAt = new Date().toISOString();
  writeAtomic(statePath(state.settings.outputDir), state);
}

function setLast(dir) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  writeAtomic(lastFile(), { outputDir: dir });
}

function getLast() {
  try {
    return JSON.parse(fs.readFileSync(lastFile(), 'utf8')).outputDir || null;
  } catch {
    return null;
  }
}

module.exports = { load, save, setLast, getLast, statePath, STATE_FILE };
