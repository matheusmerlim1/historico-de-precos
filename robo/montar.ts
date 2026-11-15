// Monta o histórico de um produto: loja do link (cópias antigas + preço de hoje) e as outras lojas
// (Buscapé hoje + cópias antigas), somando ao que já estava salvo. Usado pelo robô diário
// (robo/atualizar.ts) e pelo servidor da página (servidor/worker.ts).
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
  aoAvancar?: (etapa: string) => void;
}

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

  avisar('Lendo o preço de hoje na loja...');
  const hoje = await lerPrecoAtual(produto);
  if (!hoje.ponto) avisos.push('A loja não mostrou o preço de hoje (às vezes ela pede captcha).');

  avisar('Procurando cópias antigas da página no Internet Archive...');
  const arquivo = await buscarHistoricoArquivado(produto, {
    jaLidas: new Set(antes?.copiasLidas ?? []),
    maximoDeCopias: opcoes.copias,
    ...(opcoes.pausaMs != null ? { pausaMs: opcoes.pausaMs } : {}),
    aoAvancar: (lidas, total) => avisar(`Lendo cópias antigas da página: ${lidas} de ${total}...`),
  });
  if (arquivo.bloqueado) avisos.push('O Internet Archive pediu uma pausa; o resto das cópias antigas fica para depois.');
  if (arquivo.totalDeCopias === 0 && !arquivo.bloqueado && !antes?.copiasLidas?.length) {
    avisos.push('O Internet Archive não tem cópias desta página; o histórico desta loja cresce com a conferência diária.');
  }

  const titulo = hoje.titulo ?? antes?.titulo ?? arquivo.titulo ?? null;

  let comparador = antes?.comparador ?? null;
  let outras: PontoDePreco[] = [];
  let lidasComparador: string[] = [];
  if (titulo && opcoes.copiasComparador >= 0) {
    avisar('Procurando o mesmo produto em outras lojas...');
    const r = await buscarOutrasLojas(produto, titulo, {
      pagina: comparador,
      jaLidas: new Set(antes?.copiasComparadorLidas ?? []),
      maximoDeCopias: opcoes.copiasComparador,
      ...(opcoes.pausaMs != null ? { pausaMs: opcoes.pausaMs } : {}),
      aoAvancar: (lidas, total) => avisar(`Lendo preços antigos das outras lojas: ${lidas} de ${total}...`),
    });
    comparador = r.pagina;
    outras = r.pontos;
    lidasComparador = r.lidas;
    if (!r.pagina) avisos.push('Não achei este mesmo produto (mesmo modelo e capacidade) em outras lojas.');
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
