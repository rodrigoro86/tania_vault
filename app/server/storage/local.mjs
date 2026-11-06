/**
 * local.mjs — VaultStore sobre o filesystem (dev / fallback / VAULT_STORAGE=local).
 * Interface (todas async):
 *   list() · readText/read · writeText/write · remove · mkdir · rename
 *   exists · dirExists · isEmptyDir · removeDir · stat · readStream · presign
 */
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { NOTE_EXT, SKIP_DIRS, fileType } from './constants.mjs';

export class LocalFsStore {
  /** 'local' | 's3' — usado pela API para decidir redirect/exclusão */
  kind = 'local';

  constructor(root) {
    this.root = path.resolve(root || process.env.VAULT_ROOT || process.cwd());
    this.label = this.root;
  }

  abs(rel) {
    return path.normalize(path.join(this.root, rel));
  }

  async list() {
    const notes = [];
    const folders = [];
    const files = [];

    async function walk(dir, rel) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          folders.push(childRel);
          await walk(path.join(dir, entry.name), childRel);
        } else if (entry.name.startsWith('.')) {
          continue;
        } else if (NOTE_EXT.test(entry.name)) {
          const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
          notes.push({ path: childRel, raw });
        } else if (fileType(entry.name)) {
          const st = await fs.stat(path.join(dir, entry.name));
          files.push({ path: childRel, size: st.size, kind: fileType(entry.name).kind });
        }
      }
    }

    await walk(this.root, '');
    notes.sort((a, b) => a.path.localeCompare(b.path));
    folders.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { notes, folders, files };
  }

  async readText(rel) {
    return fs.readFile(this.abs(rel), 'utf8');
  }

  async read(rel) {
    return fs.readFile(this.abs(rel));
  }

  async writeText(rel, text) {
    await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fs.writeFile(this.abs(rel), text, 'utf8');
  }

  async write(rel, data) {
    await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fs.writeFile(this.abs(rel), data);
  }

  async remove(rel) {
    await fs.unlink(this.abs(rel));
  }

  async mkdir(rel) {
    await fs.mkdir(this.abs(rel), { recursive: true });
  }

  async rename(from, to) {
    await fs.mkdir(path.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }

  async exists(rel) {
    return existsSync(this.abs(rel));
  }

  async dirExists(rel) {
    try {
      return (await fs.stat(this.abs(rel))).isDirectory();
    } catch {
      return false;
    }
  }

  async isEmptyDir(rel) {
    try {
      return (await fs.readdir(this.abs(rel))).length === 0;
    } catch {
      return true;
    }
  }

  async removeDir(rel) {
    await fs.rm(this.abs(rel), { recursive: true, force: true });
  }

  async listKeys(prefix = '') {
    const out = [];
    const base = this.abs(prefix);
    const root = this.root;
    async function walk(dir) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
    await walk(base);
    return out;
  }

  async stat(rel) {
    const st = await fs.stat(this.abs(rel));
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  async readStream(rel, { start, end } = {}) {
    return createReadStream(this.abs(rel), { start, end });
  }

  /** local não precisa de URL assinada: /files/ streama direto */
  async presign() {
    return null;
  }
}
