/**
 * autoUpdate.ts — recarrega a aba quando sai build novo. A navegação é por
 * #/rotas e não pede nada ao servidor, então uma aba aberta ficaria na versão
 * antiga para sempre. Compara o bundle carregado com o do index.html atual.
 */
const INTERVALO = 5 * 60 * 1000;

/** formulário aberto ou campo preenchido: recarregar perderia o rascunho */
function digitando(): boolean {
  if (document.querySelector('dialog[open], [contenteditable="true"]')) return true;
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].some(
    (el) => el.value && !['checkbox', 'radio', 'file', 'hidden'].includes(el.type),
  );
}

async function verificar(bundle: string) {
  if (digitando()) return; // tenta de novo na próxima verificação
  try {
    const res = await fetch('/', { cache: 'no-store' });
    const html = await res.text();
    // a tela de login não tem #root: sessão expirada não é versão nova
    if (res.ok && html.includes('id="root"') && !html.includes(bundle)) location.reload();
  } catch {
    /* offline: segue na versão atual */
  }
}

export function iniciarAutoUpdate() {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src;
  if (!src) return;
  const bundle = new URL(src).pathname;
  setInterval(() => void verificar(bundle), INTERVALO);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void verificar(bundle);
  });
}
