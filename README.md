# RainbowChat - Premium

Extensão que altera a cor e mostra o tempo (em minutos) desde a última mensagem nas abas de ticket abertas no Zendesk.

## Compatibilidade

- Manifest V3
- Firefox (Add-ons/AMO): este repositório inclui `browser_specific_settings.gecko.id` e `browser_specific_settings.gecko.data_collection_permissions` no `manifest.json` (exigido para novas submissões no AMO desde 2025-11-03).
- Observação: `data_collection_permissions` pode causar erro de instalação em versões antigas do Firefox; por isso o `strict_min_version` está em `128.0`.

## Como usar (Firefox)

1. Abra `about:debugging#/runtime/this-firefox`
2. Clique em **Load Temporary Add-on...**
3. Selecione o arquivo `manifest.json` deste diretório
4. Acesse: `https://blingcenterhelp.zendesk.com/agent/*`

## Build (para upload no AMO)

Pré-requisitos:
- `zip`
- `node`

Execute:

```bash
./build
```

Saídas:
- `dist/rainbowchat-premium-<versao>.xpi`
- `dist/rainbowchat-premium-<versao>-source.zip`
