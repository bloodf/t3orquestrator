import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withLock } from './lock.mjs';

const isMissing = (e) => e && e.code === 'ENOENT';
const rand = () => randomBytes(8).toString('hex');

function serialize(value, indent) {
  const s = JSON.stringify(value, null, indent);
  if (s === undefined) throw new Error('value is not JSON-serializable');
  return s;
}

export async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e.message}`);
  }
}

export async function writeJsonAtomic(file, value) {
  const text = `${serialize(value, 2)}\n`;
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${rand()}.tmp`);
  try {
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

const parseRecord = (text) => {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false; // a torn write is expected here, not an error
  }
};

// Make the file end on a record boundary: cut a torn tail, or just terminate a complete one.
async function repairTail(file) {
  let size;
  try {
    size = (await fs.stat(file)).size;
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
  if (size === 0) return false;
  const buf = await fs.readFile(file);
  if (buf[buf.length - 1] === 10) return false;
  const start = buf.lastIndexOf(10) + 1;
  if (parseRecord(buf.subarray(start).toString('utf8'))) {
    await fs.appendFile(file, '\n');
    return false;
  }
  await fs.truncate(file, start);
  return true;
}

export async function appendLine(file, value) {
  const s = serialize(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withLock(`${file}.lock`, async () => {
    const repaired = await repairTail(file);
    await fs.appendFile(file, `${s}\n`);
    return { repaired };
  });
}

export async function readLines(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  const lines = text.split('\n');
  const tail = lines.pop(); // unterminated final segment: keep it only if it is a whole record
  if (parseRecord(tail)) lines.push(tail);
  const out = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`corrupt line ${i + 1} in ${file}: ${e.message}`);
    }
  });
  return out;
}
