# RainbowChat - Premium

Extensão que altera a cor e mostra o tempo (em minutos) desde a última mensagem nas abas de ticket abertas no Zendesk.

## Compatibilidade

- Manifest V3
- Firefox (Add-ons/AMO): este repositório já inclui `browser_specific_settings.gecko.id` no `manifest.json`.

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

