---
type: task-board
schemaVersion: 1
id: entrega-markdown
title: Entrega do portal
statuses:
  - id: todo
    title: A fazer
    done: false
  - id: doing
    title: Em andamento
    done: false
  - id: done
    title: Concluída
    done: true
delimiter: entrega-v1
tasks:
  - id: avaliar
    title: Avaliar a entrega
    status: doing
    dependsOn: [preparar]
    git:
      branch: feature/portal
      commit: c0ffee1
    subtasks:
      - id: testar
        title: Testar navegação
        status: done
        dependsOn: []
      - id: revisar
        title: Revisar resultados
        status: todo
        dependsOn: [testar]
        git:
          branch: review/portal
  - id: preparar
    title: Preparar ambiente
    status: todo
    dependsOn: []
    subtasks: []
  - id: prototipo
    title: Publicar protótipo
    status: done
    dependsOn: []
    archived: true
    subtasks: []
---
<!-- task-board:entrega-v1:avaliar -->
## Avaliar a entrega

Confira [[Contexto]] e a imagem.

![Esboço do portal](portal.png)

```mermaid
flowchart LR
    Teste --> Revisao[Revisão]
```
<!-- task-board:entrega-v1:testar -->
### Testar navegação

> [!tip] Roteiro
> Teste os links do menu em uma janela estreita.

![[Contexto]]
<!-- task-board:entrega-v1:revisar -->
### Revisar resultados

Compare a saída com o arquivo de referência.

```text
status: aprovado
```
<!-- task-board:entrega-v1:preparar -->
## Preparar ambiente

Crie o ambiente de teste.
<!-- task-board:entrega-v1:prototipo -->
## Publicar protótipo

Protótipo entregue.
