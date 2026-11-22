# Formato de boards v1

Grave um board inteiro em um único arquivo UTF-8 com extensão `.md` ou `.json`. O plugin reconhece o valor `task-board` no campo `type`. Use `schemaVersion: 1` em novos arquivos. Para atualizar um board existente, preserve os IDs, leia a versão atual do arquivo e faça uma gravação única.

## Campos comuns

| Objeto | Campos obrigatórios | Campos opcionais |
| --- | --- | --- |
| Board | `type` igual a `task-board`, `schemaVersion` igual a `1`, `id`, `title`, `statuses`, `tasks` | |
| Status | `id`, `title`, `done` booleano | |
| Tarefa | `id`, `title`, `description`, `status`, `dependsOn`, `subtasks` | `archived` booleano, `git` |
| Subtarefa | `id`, `title`, `description`, `status`, `dependsOn` | `git` |
| Git | | `branch` e `commit` como strings independentes |

- Use IDs que correspondam a `^[a-z0-9][a-z0-9-]*$`. O ID do board deve ser único no cofre, inclusive entre formatos. Cada board tem um conjunto de IDs de status e outro para todos os itens. Ao copiar um board como novo arquivo, atribua um novo ID ao board.
- Títulos, branch e commit são textos de uma linha. Em JSON, use `""` para uma descrição vazia. Use `[]` para listas vazias. Omitir `archived` equivale a `false`.
- `statuses` tem ao menos um elemento. Sua ordem define as colunas do Kanban. `status` referencia um ID dessa lista. Um status com `done: true` satisfaz dependências que apontam para itens naquele status.
- `dependsOn` contém IDs de itens sem repetições. Uma tarefa pode depender de outras tarefas do board. Uma subtarefa pode depender de uma tarefa do board ou de uma subtarefa irmã. Referências a si mesmo, referências inexistentes e ciclos são inválidos.
- `subtasks` é a lista de filhos diretos. O pai da subtarefa é a tarefa que contém essa lista. Ao arquivar o pai, os filhos também saem das visualizações. Ao excluir um item, remova das listas `dependsOn` os IDs excluídos.
- Um link tem o formato `obsidian://trama-tasks-boards-kanban?vault=NOME&board=ID_DO_BOARD&item=ID_DO_ITEM`. Codifique os parâmetros como componentes de URL. O ID do board permite resolver seu caminho atual, inclusive para itens arquivados. O Trama também aceita links de versões anteriores no formato `obsidian://task-board`.

## JSON

Preencha `description` em cada item com o texto Markdown, escapado como string JSON. Links e imagens relativos são resolvidos a partir da pasta do board. Use o [JSON Schema v1](board.schema.json) para validar os campos e o validador do plugin para verificar as referências e os ciclos.

O [board completo em JSON](examples/board-json.json) inclui todos os tipos de item.

## Markdown

O frontmatter YAML, delimitado por linhas `---`, contém os campos comuns, com três ajustes.

1. Omita `description` em todas as tarefas e subtarefas.
2. Adicione `delimiter` na raiz. Use uma string de letras minúsculas, dígitos e hífens, de preferência um UUID. Escolha um valor cujo prefixo `<!-- task-board:DELIMITADOR:` esteja ausente de todas as descrições.
3. Escreva uma seção por item no corpo, começando imediatamente após o frontmatter. Uma seção é formada pela linha `<!-- task-board:DELIMITADOR:ID -->`, um cabeçalho `## Título` para tarefa ou `### Título` para subtarefa, uma linha em branco, o Markdown integral da descrição e uma quebra de linha estrutural. Coloque o próximo marcador na linha seguinte. Use a mesma quebra de linha do fechamento do frontmatter para a quebra estrutural.

O cabeçalho no corpo é uma cópia para leitura como nota. Ao alterar o título, atualize `title` no frontmatter e o cabeçalho da seção. A hierarquia e a ordem do board vêm do frontmatter. Cada ID precisa ter exatamente um marcador. Em boards sem itens, encerre o arquivo depois do frontmatter.

O [board completo em Markdown](examples/board-md.md) usa as mesmas tarefas do exemplo em JSON. Os exemplos têm IDs de board diferentes para poderem coexistir no mesmo cofre. Copie a pasta de exemplos inteira para incluir `Contexto.md` e `portal.png`.
