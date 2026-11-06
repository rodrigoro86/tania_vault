import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// VAULT_AUTH (login do dev server) pode vir de app/.env; o Vite só expõe VITE_*
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* sem .env: usa só o env do processo */
}
// import dinâmico: vault-api lê VAULT_ROOT do env na carga do módulo, depois do .env
const { vaultApiPlugin } = await import('./server/vault-api.mjs');

// versão do front: fonte única é o package.json (ver CHANGELOG.md)
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
// commit do build (rodapé): diz exatamente qual código está no ar; sem git -> "dev"
let commit = 'dev';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* build fora de um clone git */
}

// O vault é o "root" real dos dados: as notas ficam uma pasta acima do front.
export default defineConfig({
  root: path.resolve(__dirname),
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  // BACKEND_URL definido: API/login vêm do backend (Rust); senão, API embutida no Vite (Node)
  plugins: process.env.BACKEND_URL ? [] : [vaultApiPlugin()],
  server: process.env.BACKEND_URL
    ? { proxy: Object.fromEntries(['/api', '/files', '/login', '/logout'].map((p) => [p, process.env.BACKEND_URL!])) }
    : undefined,
  // anexos já entram no bundle via import.meta.glob (vault.ts) — publicDir
  // duplicaria cada pdf/pptx/mp4 em dist/; por isso foi removido (review 2026-10-22)
  // permite que o glob de anexos (pdf, pptx, vídeo…) seja tratado como asset
  assetsInclude: [
    '**/*.pdf',
    '**/*.pptx',
    '**/*.docx',
    '**/*.xlsx',
    '**/*.csv',
    '**/*.mp4',
    '**/*.mp3',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.gif',
    '**/*.webp',
    '**/*.svg',
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // páginas da tool (iframe): cada html vira dist/tools/clickup/ui/<pagina>.html
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'clickup-tarefas': path.resolve(__dirname, 'tools/clickup/ui/tarefas.html'),
        'clickup-painel': path.resolve(__dirname, 'tools/clickup/ui/painel.html'),
        'clickup-card': path.resolve(__dirname, 'tools/clickup/ui/card.html'),
      },
    },
  },
});
