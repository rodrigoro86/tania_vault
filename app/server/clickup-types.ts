/**
 * clickup-types.ts — formas normalizadas das tarefas do ClickUp, sem nada do
 * Node: importadas pelo servidor (clickup.ts) e pelo front (import type), então
 * mudou aqui, os dois lados checam juntos.
 */
export interface Person {
  id: number;
  name: string;
  initials: string;
  color: string;
  avatar: string | null;
}

export interface Task {
  id: string;
  name: string;
  url: string;
  status: string;
  statusColor: string;
  closed: boolean;
  priority: string | null;
  due: string | null; // AAAA-MM-DD
  overdue: boolean;
  updated: string | null;
  assignees: Person[];
  listId: string;
  list: string;
  folderId: string;
  folder: string;
  spaceId: string;
  space: string;
  tags: string[];
  parent: string | null;
}

/** pasta do ClickUp ("projeto", ex.: Projeto Core) com as listas dentro (clientes/frentes) */
export interface Folder {
  id: string;
  name: string;
  spaceId: string;
  lists: { id: string; name: string }[];
}

/** linha de uma barra do painel (por pessoa ou por projeto) */
export interface DashboardGroup {
  name: string;
  open: number;
  overdue: number;
}

/** painel (dashboard): contagem de cards ABERTOS (status não fechado) */
export interface Dashboard {
  team: string;
  me: Person;
  /** data de referência da contagem (UTC, YYYY-MM-DD) */
  date: string;
  open: number;
  overdue: number;
  dueToday: number;
  /** abertos com prazo nos próximos 7 dias (exclui hoje e atrasados) */
  dueSoon: number;
  noDue: number;
  noAssignee: number;
  people: DashboardGroup[];
  projects: DashboardGroup[];
  truncated: boolean;
}


export interface TaskDetail extends Task {
  description: string;
}
