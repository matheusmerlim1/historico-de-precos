# Histórico de preço

Página pública: **https://matheusmerlim1.github.io/historico-de-precos/**

Cole o link de um produto da Amazon (amazon.com.br) ou do Mercado Livre e veja como o preço mudou
ao longo do tempo: menor, maior, média, último preço e um gráfico.

## Como funciona

A página é estática (GitHub Pages) e não precisa de chave nem de login. Os preços ficam em `dados/`:

- `dados/indice.json`: lista dos produtos acompanhados;
- `dados/produtos/<loja>_<código>.json`: o histórico de cada produto.

Quem grava esses arquivos é o robô (`robo/atualizar.ts`), rodando no GitHub Actions
(`.github/workflows/historico.yml`):

1. **Pedido**: quando a página não conhece o produto, ela abre uma issue com o link. O robô lê as
   cópias antigas da página do produto no Internet Archive, lê o preço de hoje na loja, grava os
   dados, responde na issue e a fecha.
2. **Conferência diária** (9h17 UTC): o robô passa pelos produtos e acrescenta o preço do dia e mais
   algumas cópias antigas.

O navegador não consegue ler o Internet Archive direto (ele não libera acesso de outros sites), por
isso o trabalho fica com o robô.

## Rodar o robô no PC

Node 22 ou mais novo, sem instalar nada:

```
node --experimental-strip-types robo/atualizar.ts https://www.amazon.com.br/dp/B0CQD9VK7X
node --experimental-strip-types robo/atualizar.ts --todos
```

## Origem

`robo/motor.ts`, `historico-tela.js` e `historico-tela.css` são cópias dos arquivos do app
**Comparador de Promoções do Telegram** (repositório privado), cuja aba "Histórico de preço" é a
versão privada desta página: ela também usa as mensagens dos grupos de promoção do Telegram, que
exigem login. Os testes do motor estão lá (`npm test`).
