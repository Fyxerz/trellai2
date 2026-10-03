# Trellai 2

Un tablero kanban para pasarle features a Claude. Tú escribes y decides; los agentes preparan, programan en paralelo y te dejan el diff listo para revisar.

```
Backlog → Plan → Preparation → Doing → To Review → Merged
          (tú)   (Claude pregunta  (agentes en   (tú)     (git merge)
                  o pasa sola)      paralelo)
```

## Arrancar

```bash
npm install
npm start            # → http://localhost:4317
```

Para desarrollar el propio Trellai: `npm run dev` (UI en http://localhost:5317 con recarga en caliente).

Usa tu sesión de Claude Code: si `claude` funciona en tu terminal, Trellai también funciona. También puedes usar `ANTHROPIC_API_KEY`.

## Cómo funciona

| Columna | Qué pasa |
|---|---|
| **Backlog** | Ideas sueltas. Nadie las toca. |
| **Plan** | Escribes la spec en la tarjeta, en markdown. Claude no hace nada aquí. |
| **Preparation** | Un agente de solo lectura lee la spec y el repo. Si le falta algo importante, te deja preguntas con opciones (la tarjeta se marca en morado: *Te necesita*). Si lo tiene claro, escribe un plan técnico y **mueve la tarjeta sola a Doing**. |
| **Doing** | Cada tarjeta tiene su propio agente en su propio **git worktree y rama** (`trellai/<slug>`), todos **en paralelo y sin límite**. Al terminar se commitea, se hace rebase sobre la rama base y la tarjeta **pasa sola a To Review**. Si el rebase da conflictos, el agente los resuelve. |
| **To Review** | Ves el diff. Puedes **pedir cambios** escribiendo en Actividad (vuelve a Doing con tu comentario) o pulsar **Mergear** / arrastrarla a Merged. |
| **Merged** | `git merge --no-ff` a la rama base y se borran el worktree y la rama. Si hay conflicto, la tarjeta vuelve a Doing para que el agente rebase y resuelva, y luego vuelve a To Review. |

**Coordinación entre agentes.** Comparten un *canal* (botón "Canal de agentes"):
- `post_note`: un agente avisa de cambios que afectan a otros (schema, APIs, ficheros compartidos…).
- Las notas nuevas de los demás **se inyectan automáticamente** en el contexto de cada agente después de cada herramienta que usa.
- Al entrar en Doing, Trellai compara los ficheros previstos y los ya tocados por cada agente, y avisa en el canal si dos tarjetas se pisan.
- Tú también puedes escribir en el canal para avisar a todos.

**En cualquier momento** puedes escribir al agente desde Actividad. Si está en mitad de un paso, recibe el mensaje en cuanto lo termina. También puedes **pararlo** o **reintentar**.

## Requisitos para Merged

El repo principal tiene que estar en la rama base (la que pusiste al crear el proyecto) y sin cambios sin commitear en ficheros trackeados. Si no, la tarjeta se queda en To Review y te dice por qué.

Los worktrees viven en `<repo>/.trellai/worktrees/` y se excluyen de git vía `.git/info/exclude`; no se modifica ningún fichero de tu repo.

## Configuración (variables de entorno)

| Variable | Por defecto | |
|---|---|---|
| `PORT` | `4317` | |
| `HOST` | `127.0.0.1` | Ponlo a `0.0.0.0` para abrirlo desde el móvil en tu red. **Ojo:** los agentes tienen permisos completos. |
| `TRELLAI_MODEL` | el de tu Claude Code | p. ej. `opus` o `sonnet` |
| `TRELLAI_DB` | `data/trellai.db` | |
| `TRELLAI_FAKE_AGENT` | — | `1` = agente simulado, sin gastar tokens (para probar el flujo) |

## Tests

```bash
npm test   # flujo completo contra un repo git real, con el agente simulado
```

## Estructura

```
server/
  index.ts       API HTTP + SSE
  workflow.ts    qué pasa al entrar en cada columna y al terminar cada agente
  agents.ts      Claude Agent SDK, herramientas MCP (preguntas, notas…), hook de notas
  git.ts         worktrees, commit, rebase, merge
  db.ts          SQLite
  fake-agent.ts  agente simulado para tests
web/src/         React: tablero, panel de tarjeta, canal
shared/types.ts
```
