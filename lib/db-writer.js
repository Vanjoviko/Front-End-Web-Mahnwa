'use strict';
// Antrean tulis serial untuk db.json (NFR-07): tidak pernah dua tulis bersamaan, tmp unik + rename,
// dan save() yang menumpuk saat satu tulis berjalan digabung menjadi satu tulis akhir (state terbaru).
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createDbWriter(file) {
  let running = null, pending = null, latest = null;
  const stats = {writes: 0, requests: 0, concurrentPeak: 0};
  let active = 0;
  async function writeOnce(db) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    active++; stats.concurrentPeak = Math.max(stats.concurrentPeak, active);
    try {
      await fs.writeFile(tmp, JSON.stringify(db, null, 2));
      await fs.rename(tmp, file);
      stats.writes++;
    } catch (error) {
      await fs.rm(tmp, {force: true}).catch(() => {});
      throw error;
    } finally { active--; }
  }
  function save(db) {
    stats.requests++;
    latest = db;
    if (!running) {
      running = (async () => { try { await writeOnce(latest); } finally { running = null; } })();
      return running;
    }
    if (!pending) {
      pending = running.catch(() => {}).then(() => { // tulis berikutnya memuat state paling baru
        pending = null;
        running = (async () => { try { await writeOnce(latest); } finally { running = null; } })();
        return running;
      });
    }
    return pending;
  }
  return {save, stats};
}

module.exports = {createDbWriter};
