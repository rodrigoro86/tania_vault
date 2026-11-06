/**
 * ToolFrame.tsx — mostra a página de uma tool dentro de um iframe:
 * rota /t/:id/:pagina → /tools/:id/ui/:pagina (servido pelo backend da tool).
 * Ids fora de ID_OK não viram URL: mostra "Página inválida."
 */
import { useParams } from 'react-router-dom';
import { ID_OK, useTools } from '../tools';

export default function ToolFrame() {
  const { id, pagina } = useParams();
  const tools = useTools();

  if (!id || !pagina || !ID_OK.test(id) || !ID_OK.test(pagina)) {
    return <p className="muted">Página inválida.</p>;
  }

  const tool = tools.find((t) => t.id === id);
  const page = tool?.manifest?.paginas.find((p) => p.id === pagina);

  return (
    <iframe
      className="tool-frame"
      src={`/tools/${id}/ui/${pagina}`}
      title={page?.titulo ?? id}
    />
  );
}
