# agent-storage — VaultStore (LocalFsStore + S3Store/MinIO)

**Papel:** introduzir a camada de storage e fazer as notas `.md`/anexos viverem no
MinIO, sem quebrar a API nem as regras de segurança.

## Dono de
- `app/server/storage/` (novo): `index.mjs`, `local.mjs`, `s3.mjs`

## Fornece (contrato)
Interface `VaultStore`:
```
list() -> { notes:[{path,raw}], folders:[string], files:[{path,size,kind}] }
read(path) -> string|Buffer
write(path, data, {overwrite?}) -> { path, created }
remove(path)
mkdir(path)              // S3: no-op (keys implicam pastas)
rename(from, to)         // S3: copyObject + deleteObject
exists(path)
stat(path) -> { size, mtimeMs }
stream(path, {start?, end?})
presign(path, {download?}) -> string
```

## Consome
- Env: `VAULT_STORAGE` (`minio` | `local`), `MINIO_ENDPOINT`, `MINIO_USE_SSL`,
  `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`.
- SDK: `@aws-sdk/client-s3` (ou `minio`).

## Faz
- Criar `LocalFsStore` (porta o comportamento atual) e `S3Store` (MinIO).
- Fábrica em `index.mjs` que escolhe o backend por `VAULT_STORAGE` e exporta `store`.
- Trocar `fs` por `store` em `vault-api.mjs` e `agent.ts` (mantendo `sanitize*`, `SKIP_DIRS`, `ATTACHMENTS_DIR`).
- `/files/*` via presigned URL (S3) mantendo Range/ETag; `stream()` no modo local.
- Remover/condicionar o `import.meta.glob('../../**/*.md')` em `src/vault.ts` (carregar só via `/api/notes`).
- Ajustar `Dockerfile`/`docker-compose.yml` (env MinIO; sem volume do vault; sem git autocommit no modo MinIO).

## NÃO faz
- Tocar em Postgres, Evolution ou UI.
- Alterar a lógica de negócio de `agent.ts` (só substitui a forma de ler/gravar).
- Habilitar/gerenciar o versioning no bucket em runtime (é config do MinIO, feito uma vez).

## Pronto quando
- O app lê/escreve `.md` e anexos no MinIO via `/api`, sem autocommit git.
- Undo por versioning do bucket.
- `npm test` verde e `LocalFsStore` continua funcionando (`VAULT_STORAGE=local`).
