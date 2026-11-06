/**
 * main.tsx — entrada das páginas da tool ClickUp (tarefas, painel, card),
 * montadas dentro do iframe do front (rota /t/clickup/<pagina> → /tools/clickup/ui/<pagina>).
 * A página vem do caminho: .../ui/<pagina>; o card recebe o id em ?valor=.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import '../../../src/styles.css';
import { reloadVault } from '../../../src/vault';
import { ClickUpCard, TasksPage } from './Tasks';
import { ClickUpDashboardPage } from './Dashboard';

/** 'tarefas' | 'painel' | 'card' a partir de location.pathname (termina em /ui/<pagina>) */
function paginaDoCaminho(): string {
  const match = /\/ui\/([^/]+)$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : '';
}

async function main() {
  document.body.classList.add('tool-embed');
  const pagina = paginaDoCaminho();

  let conteudo: React.ReactNode;
  if (pagina === 'tarefas') {
    // a tela liga cada tarefa à nota do vault (frontmatter clickup:): precisa das notas carregadas
    await reloadVault();
    conteudo = <TasksPage />;
  } else if (pagina === 'painel') {
    conteudo = <ClickUpDashboardPage />;
  } else if (pagina === 'card') {
    const valor = new URLSearchParams(location.search).get('valor') ?? '';
    conteudo = valor ? <ClickUpCard id={valor} /> : <p className="muted">Sem tarefa.</p>;
  } else {
    conteudo = <p>Página não encontrada.</p>;
  }

  createRoot(document.getElementById('root')!).render(<HashRouter>{conteudo}</HashRouter>);
}

void main().catch((err) => {
  console.error('tool clickup: páginas não montadas:', err);
  const root = document.getElementById('root');
  if (root) root.innerHTML = '<p class="flash">Não foi possível carregar a página.</p>';
});
