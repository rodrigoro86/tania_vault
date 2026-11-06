/**
 * s3.mjs — VaultStore sobre bucket S3 compatível: RustFS/MinIO (VAULT_STORAGE=rustfs).
 * "pastas" são prefixes; rename = copy+delete; mkdir grava um marcador oculto.
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NOTE_EXT, SKIP_DIRS, fileType } from './constants.mjs';

/** RUSTFS_* é o nome atual; MINIO_* continua valendo (shortcut: fallback até renomear o .env de produção, depois remova) */
const env = (name) => process.env[`RUSTFS_${name}`] || process.env[`MINIO_${name}`];

/** S3 não tem pasta vazia: este objeto mantém o prefixo; list() não o mostra (sem extensão conhecida) */
const FOLDER_MARKER = '.keep';

/** aceita "https://host/", "host:9000" e RUSTFS_USE_SSL booleano/string */
function parseEndpoint(raw, useSsl) {
  let s = String(raw || '').trim();
  const flag = typeof useSsl === 'string' ? useSsl.toLowerCase() : useSsl;
  let ssl = flag === true || flag === 1 || flag === '1' || flag === 'true' || flag === 'yes';
  if (/^https:\/\//i.test(s)) {
    ssl = true;
    s = s.slice(8);
  } else if (/^http:\/\//i.test(s)) {
    ssl = false;
    s = s.slice(7);
  }
  s = s.replace(/\/+$/, '');
  return { endpoint: `${ssl ? 'https' : 'http'}://${s}`, ssl };
}

export class S3Store {
  /** 'local' | 's3' — usado pela API para decidir redirect/exclusão */
  kind = 's3';

  constructor(opts = {}) {
    const bucket = opts.bucket || env('BUCKET');
    if (!bucket) throw new Error('S3Store: RUSTFS_BUCKET não definido');
    const accessKeyId = opts.accessKeyId || env('ACCESS_KEY');
    const secretAccessKey = opts.secretAccessKey || env('SECRET_KEY');
    const ep = parseEndpoint(opts.endpoint || env('ENDPOINT'), opts.useSsl ?? env('USE_SSL'));
    this.bucket = bucket;
    this.label = `s3://${bucket} (${ep.endpoint})`;
    const region = env('REGION') || 'us-east-1';
    const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
    this.client = new S3Client({ region, endpoint: ep.endpoint, forcePathStyle: true, credentials });
    // endpoint público só para URLs assinadas (o browser não resolve "rustfs:9000")
    const pub = env('PUBLIC_ENDPOINT') ? parseEndpoint(env('PUBLIC_ENDPOINT'), true) : null;
    this.publicClient = pub ? new S3Client({ region, endpoint: pub.endpoint, forcePathStyle: true, credentials }) : this.client;
  }

  /** lista todas as chaves (paginado) */
  async listKeys(prefix = '') {
    const out = [];
    let token;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async list() {
    const objs = await this.listKeys('');
    const notes = [];
    const files = [];
    const folders = new Set();

    for (const { key, size } of objs) {
      const parts = key.split('/');
      const top = parts[0];
      if (SKIP_DIRS.has(top) || top.startsWith('.')) continue;
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
      const name = parts[parts.length - 1];
      if (NOTE_EXT.test(name)) {
        let raw = '';
        try {
          raw = await this.readText(key);
        } catch {
          raw = '';
        }
        notes.push({ path: key, raw });
      } else if (fileType(name)) {
        files.push({ path: key, size, kind: fileType(name).kind });
      }
    }

    return {
      notes: notes.sort((a, b) => a.path.localeCompare(b.path)),
      folders: [...folders].sort((a, b) => a.localeCompare(b)),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  async readText(rel) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: rel }));
    return out.Body.transformToString('utf-8');
  }

  async read(rel) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: rel }));
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async writeText(rel, text) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: rel, Body: text, ContentType: 'text/markdown; charset=utf-8' }),
    );
  }

  async write(rel, data) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: rel, Body: data }));
  }

  async remove(rel) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: rel }));
  }

  async mkdir(rel) {
    await this.write(`${rel}/${FOLDER_MARKER}`, '');
  }

  async copyObject(from, to) {
    const source = `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: source, Key: to }));
  }

  async rename(from, to) {
    if (await this.exists(from)) {
      await this.copyObject(from, to);
      await this.remove(from);
      return;
    }
    // pasta: move todos os objetos sob o prefixo
    const keys = await this.listKeys(`${from}/`);
    for (const { key } of keys) {
      await this.copyObject(key, `${to}/${key.slice(from.length + 1)}`);
      await this.remove(key);
    }
  }

  async exists(rel) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: rel }));
      return true;
    } catch (err) {
      const status = err?.$metadata?.httpStatusCode;
      if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return false;
      throw err;
    }
  }

  async dirExists(rel) {
    const r = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${rel}/`, MaxKeys: 1 }),
    );
    return (r.KeyCount ?? 0) > 0;
  }

  async isEmptyDir(rel) {
    const r = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${rel}/`, MaxKeys: 2 }),
    );
    return !(r.Contents ?? []).some((o) => o.Key !== `${rel}/${FOLDER_MARKER}`);
  }

  async removeDir(rel) {
    const keys = await this.listKeys(`${rel}/`);
    for (const { key } of keys) await this.remove(key);
  }

  async stat(rel) {
    const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: rel }));
    return { size: out.ContentLength ?? 0, mtimeMs: out.LastModified ? out.LastModified.getTime() : Date.now() };
  }

  async readStream(rel, { start, end } = {}) {
    const opts = { Bucket: this.bucket, Key: rel };
    if (start !== undefined || end !== undefined) opts.Range = `bytes=${start ?? 0}-${end ?? ''}`;
    const out = await this.client.send(new GetObjectCommand(opts));
    return out.Body;
  }

  async presign(rel, { download = false } = {}) {
    const name = rel.split('/').pop() || rel;
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: rel,
      ...(download ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
    });
    return getSignedUrl(this.publicClient, cmd, { expiresIn: Number(env('PRESIGN_TTL') || 300) });
  }
}
