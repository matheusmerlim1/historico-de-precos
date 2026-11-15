// Monta o histórico de um produto: loja do link (cópias antigas + preço de hoje) e as outras lojas
// (Buscapé hoje + cópias antigas), somando ao que já estava salvo. Usado pelo robô diário
// (robo/atualizar.ts) e pelo servidor da página (servidor/api.ts).
//
// Com `prazoMs` (servidor: a função tem 60 s), faz primeiro o que é rápido e mais útil (preço de
// hoje na loja do link e nas outras lojas) e usa o tempo que sobrar nas cópias antigas; cada pedido
// tem limite de tempo, e o que não couber fica para a próxima consulta ou para o robô diário.
import {
  buscarHistoricoArquivado,
  buscarOutrasLojas,
  juntarPontos,
  lerPrecoAtual,
  resumir,
} from './motor.ts';
import type { PaginaComparador, PontoDePreco, ProdutoLink, Resumo } from './motor.ts';

export interface ArquivoProduto {
  produto: ProdutoLink;
  titulo: string | null;
  criadoEm: string;
  atualizadoEm: string;
  copiasLidas: string[];
  copiasRestantes: number;
  comparador?: PaginaComparador | null;
  copiasComparadorLidas?: string[];
  pontos: PontoDePreco[];
  resumo: Resumo;
}

export interface OpcoesMontagem {
  copias: number;
  copiasComparador: number;
  pausaMs?: number;
  /** Tempo total disponível, em ms (sem limite quando ausente). */
  prazoMs?: number;
  aoAvancar?: (etapa: string) => void;
}

type Buscar = (url: string, init?: RequestInit) => Promise<Response>;

const FOLGA_FINAL_MS = 6000;
const LIMITE_POR_PEDIDO_MS = 15000;

function principais(pontos: PontoDePreco[]): PontoDePreco[] {
  return pontos.filter((p) => !p.loja);
}

export async function montarHistorico(
  produto: ProdutoLink,
  antes: ArquivoProduto | null,
  opcoes: OpcoesMontagem,
): Promise<{ dados: ArquivoProduto; avisos: string[] }> {
  const avisar = opcoes.aoAvancar ?? (() => {});
  const avisos: string[] = [];
  const agora = new Date().toISOString();
  const fim = opcoes.prazoMs != null ? Date.now() + opcoes.prazoMs - FOLGA_FINAL_MS : Infinity;
  const restante = () => fim - Date.now();
  const semTempo = () => restante() < 2500;

  // Cada pedido espera no máximo 15 s, e nunca além do prazo da consulta.
  const buscar: Buscar = (url, init) => {
    const limite = Math.min(LIMITE_POR_PEDIDO_MS, restante());
    if (limite < 1000) return Promise.reject(new Error('sem tempo'));
    return fetch(url, { ...init, signal: AbortSignal.timeout(limite) });
  };
  const pausa = opcoes.pausaMs != null ? { pausaMs: opcoes.pausaMs } : {};

  avisar('Lendo o preço de hoje na loja...');
  const hoje = await lerPrecoAtual(produto, buscar);
  if (!hoje.ponto) avisos.push('A loja não mostrou o preço de hoje (às vezes ela pede captcha).');

  let titulo = hoje.titulo ?? antes?.titulo ?? null;
  let comparador = antes?.comparador ?? null;
  const outras: PontoDePreco[] = [];
  const lidasComparador: string[] = [];

  // Outras lojas hoje: rápido (busca + uma página do Buscapé), antes das cópias antigas.
  const procurarOutras = async (copias: number) => {
    if (!titulo || opcoes.copiasComparador < 0 || semTempo()) return;
    const r = await buscarOutrasLojas(produto, titulo, {
      buscar,
      pagina: comparador,
      jaLidas: new Set([...(antes?.copiasComparadorLidas ?? []), ...lidasComparador]),
      maximoDeCopias: copias,
      parar: semTempo,
      ...pausa,
      aoAvancar: (lidas, total) => avisar(`Lendo preços antigos das outras lojas: ${lidas} de ${total}...`),
    });
    if (r.pagina) comparador = r.pagina;
    outras.push(...r.pontos);
    lidasComparador.push(...r.lidas);
  };
  if (titulo) {
    avisar('Procurando o mesmo produto em outras lojas...');
    await procurarOutras(0);
  }

  avisar('Procurando cópias antigas da página no Internet Archive...');
  const arquivo = await buscarHistoricoArquivado(produto, {
    buscar,
    jaLidas: new Set(antes?.copiasLidas ?? []),
    maximoDeCopias: opcoes.copias,
    parar: semTempo,
    ...pausa,
    aoAvancar: (lidas, total) => avisar(`Lendo cópias antigas da página: ${lidas} de ${total}...`),
  });
  if (arquivo.bloqueado) avisos.push('O Internet Archive pediu uma pausa; o resto das cópias antigas fica para depois.');
  if (arquivo.totalDeCopias === 0 && !arquivo.bloqueado && !semTempo() && !antes?.copiasLidas?.length) {
    avisos.push('O Internet Archive não tem cópias desta página; o histórico desta loja cresce com a conferência diária.');
  }

  if (!titulo && arquivo.titulo) {
    titulo = arquivo.titulo;
    avisar('Procurando o mesmo produto em outras lojas...');
    await procurarOutras(0);
  }
  if (opcoes.copiasComparador > 0 && comparador) await procurarOutras(opcoes.copiasComparador);
  if (titulo && !comparador && !semTempo()) {
    avisos.push('Não achei este mesmo produto (mesmo modelo e capacidade) em outras lojas.');
  }
  if (semTempo() && opcoes.prazoMs != null) {
    avisos.push('O Internet Archive estava lento; mostrei o que deu tempo de ler. Consulte de novo mais tarde para ver mais.');
  }

  const pontos = juntarPontos(antes?.pontos ?? [], arquivo.pontos, hoje.ponto ? [hoje.ponto] : [], outras);
  const dados: ArquivoProduto = {
    produto,
    titulo,
    criadoEm: antes?.criadoEm ?? agora,
    atualizadoEm: agora,
    copiasLidas: [...new Set([...(antes?.copiasLidas ?? []), ...arquivo.lidas])].sort(),
    copiasRestantes: arquivo.faltam,
    comparador,
    copiasComparadorLidas: [...new Set([...(antes?.copiasComparadorLidas ?? []), ...lidasComparador])].sort(),
    pontos,
    // O resumo (menor, maior, média, veredito) é da loja do link; as outras lojas têm a tabela própria.
    resumo: resumir(principais(pontos)),
  };
  return { dados, avisos };
}
