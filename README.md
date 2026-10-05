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

Para añadir un proyecto, elige la carpeta en el explorador que sale al crear uno (las carpetas con git salen en verde; en Mac también tienes el botón **Finder…**). Si eliges una carpeta sin git, Trellai puede inicializarla.

O usa la pestaña **Clonar de GitHub**: pega la URL del repo (o `usuario/repo`) y se clona dentro de la carpeta donde tienes la mayoría de tus proyectos (si aún no hay ninguno, `~/code`; el diálogo muestra la ruta completa y con **Cambiar…** eliges otra, que se recuerda) y se abre su tablero. Si tienes el CLI [`gh`](https://cli.github.com) con sesión iniciada (`gh auth login`), ves la lista de tus repos (también los de tus organizaciones) con buscador y eliges uno con un clic; Trellai no guarda tokens, usa los de `gh` y respeta `gh config get git_protocol` (ssh/https). Si la carpeta ya tiene ese repo, se reutiliza.

Usa tu sesión de Claude Code: si `claude` funciona en tu terminal, Trellai también funciona. También puedes usar `ANTHROPIC_API_KEY`.

## Cómo funciona

| Columna | Qué pasa |
|---|---|
| **Backlog** | Ideas sueltas. Nadie las toca. |
| **Plan** | Escribes la spec en la tarjeta, en markdown. Claude no hace nada aquí. |
| **Preparation** | Un agente de solo lectura lee la spec y el repo. Si le falta algo importante, te deja preguntas con opciones (la tarjeta se marca en morado: *Te necesita*). Si lo tiene claro, escribe un plan técnico y la deja *En espera* hasta que la muevas a Doing (o **la mueve sola** si el proyecto tiene activado el paso automático). |
| **Doing** | Cada tarjeta tiene su propio agente en su propio **git worktree y rama** (`trellai/<slug>`), todos **en paralelo y sin límite**. Al terminar se commitea, se hace rebase sobre la rama base y la tarjeta **pasa sola a To Review**. Si el rebase da conflictos, el agente los resuelve. |
| **To Review** | Ves el diff. Puedes **pedir cambios** escribiendo en Actividad (vuelve a Doing con tu comentario) o pulsar **Mergear** / arrastrarla a Merged. |
| **Merged** | `git merge --no-ff` a la rama base y se borran el worktree y la rama. Si hay conflicto, la tarjeta vuelve a Doing para que el agente rebase y resuelva, y luego vuelve a To Review. |

**Asistente** (botón *Asistente* o tecla `t`). Le cuentas ideas como te salgan —escritas o dictadas— y él mira el código y las convierte en tarjetas en Backlog: título, spec (Qué / Por qué / Comportamiento / Notas técnicas con ficheros reales / Fuera de alcance) y checkpoints. Intenta que las tarjetas sean independientes para que los agentes las hagan en paralelo, y si hablas de una tarjeta que ya existe, la actualiza en vez de duplicarla. En Chrome/Safari tiene botón de dictado; en Firefox usa el dictado de macOS.

**Directo** (pestaña *Directo* del Asistente o tecla `d`). Para lo que no merece una tarjeta: cambiar una config, mover ficheros, un arreglo pequeño, una pregunta sobre el código… Claude trabaja directamente en tu repo (rama actual) y al terminar hace **commit solo de los ficheros que ha tocado** (tus cambios sin commitear no se incluyen), con tu petición como mensaje. Si lo que pides es grande, te propone crear una tarjeta. Mientras está trabajando, los merges esperan.

**Checkpoints.** Cada tarjeta tiene una lista de pasos con casillas. Puedes escribir los tuyos en Plan; en Preparation Claude añade los suyos (marcados como *Claude*), y en Doing el agente los va marcando según termina cada uno. **Cada checkpoint que marca el agente se convierte en un commit** en la rama de la tarjeta (con el texto del checkpoint como mensaje), así el historial queda paso a paso. En el tablero ves el progreso de cada tarjeta (3/5).

**Coordinación entre agentes.** Comparten un *canal* (botón "Canal de agentes"):
- **Qué toca cada uno.** Antes de editar, el agente dice con `claim_files` qué fichero toca, en qué zona (función, componente…) y para qué. Trellai rellena las líneas cambiadas a partir de su `git diff` y reserva también los ficheros que cambie sin avisar. Arriba del canal ves "En uso ahora".
- **Cada agente solo oye lo suyo.** `post_note` acepta `files`: esa nota solo llega a los agentes que tienen alguno de esos ficheros reservados. Las notas sin ficheros (schema, dependencias…) y las tuyas llegan a todos. Se **inyectan automáticamente** después de cada herramienta, cada nota una sola vez.
- **Solapamientos.** Si dos tarjetas reservan el mismo fichero, Trellai avisa solo a esas dos, con la zona y las líneas de cada una.
- **Limpieza.** Cuando una tarjeta sale de Doing se borran sus reservas y sus notas pasan al *historial* (plegado en el canal; los agentes ya no las ven). Tus avisos generales se archivan cuando no queda nadie en Doing, o antes si los archivas tú.

**En cualquier momento** puedes escribir al agente desde Actividad. Si está en mitad de un paso, recibe el mensaje en cuanto lo termina. También puedes **pararlo** o **reintentar**.

**Retroceder (↶).** Cada petición que le haces a una tarjeta en Doing o To Review guarda dónde estaba su rama en ese momento. Pasa el ratón por tu mensaje en Actividad y pulsa ↶: te dice cuántos commits se pierden y, si confirmas, para el agente, hace `git reset --hard` del worktree a ese punto (también descarta lo que no esté commiteado), hace push forzado de la rama y devuelve la tarjeta a la columna en la que estaba (normalmente To Review) sin relanzar el agente. Ese mensaje y los posteriores quedan marcados como deshechos, los checkpoints de los commits borrados vuelven a quedar pendientes y el siguiente mensaje arranca un agente nuevo que mira el `git log`. Solo desde el ordenador que tiene el worktree de la tarjeta; si el rebase final reescribió los commits, cuenta hacia atrás los commits que llevaba por delante de la rama base.

## GitHub: pull antes de trabajar, push al mergear

Si el repo tiene remoto (`origin`), Trellai lo usa con tus credenciales de siempre (ssh, credential helper o `gh`); nunca te pide contraseña:

- **Antes de empezar** — preparar una tarjeta, crear su worktree en Doing, el chat Directo, rebasar al terminar y mergear — hace `git fetch` y pone la rama base al día (fast-forward; si tienes commits locales sin subir, rebase). Si no puede (cambios sin commitear, ramas separadas), te lo dice en la actividad y no toca nada.
- **Al mergear** hace push de la rama base. Si alguien subió algo entretanto, se pone al día y vuelve a intentarlo. Sin conexión, mergea en local y te avisa de que falta el push.
- **Directo** también hace push de su commit si estás en la rama base.
- Las ramas `trellai/*` se suben según el agente commitea, para que otro ordenador pueda seguir la tarjeta (se borran del remoto al mergear o eliminar la tarjeta). Desactívalo con `TRELLAI_PUSH_BRANCHES=0`.
- En la cabecera, junto a la rama base, ves `↓3` (commits por bajar) o `↑1` (por subir). Clic para sincronizar.

## Varios ordenadores

Cada ordenador ejecuta su propio Trellai con **sus** modelos y suscripciones, pero el tablero (proyectos, tarjetas, specs, checkpoints, actividad, preguntas, canal y Asistente) se comparte a través de una base de datos Postgres en Supabase. Cada uno sigue teniendo su copia local, así que funciona sin conexión y se pone al día al volver.

**Configurarlo (una vez):**

1. En [supabase.com](https://supabase.com) crea un proyecto (el plan gratis sobra) y apunta la contraseña de la base de datos.
2. En el proyecto: **Connect** → copia la URI del **Session pooler**.
3. En la carpeta de Trellai de **cada ordenador**, crea un fichero `.env` (tienes `.env.example` de modelo):
   ```
   TRELLAI_DATABASE_URL=postgresql://postgres.xxxx:TU-CONTRASEÑA@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
   ```
4. `npm install` y `npm start`. La primera vez sube todo lo que tengas; en el otro ordenador aparece solo.

Trellai crea sus tablas en un esquema propio (`trellai`), no expuesto en la API pública de Supabase.

**Cómo se usa:**

- Un proyecto creado en otro ordenador aparece con un aviso: **Clonar en ~/code/…** o **elegir la carpeta** si ya lo tienes. Si está en la misma ruta, se vincula solo.
- Cada tarjeta tiene un **dueño**: el ordenador donde corre su agente y está su worktree. En los demás ves una etiqueta con su nombre y toda su actividad en directo.
- Desde otro ordenador puedes **escribirle** (le llega al agente cuando termina su paso) o **pararlo**. No puedes moverla de columna mientras trabaja.
- Si la tarjeta está parada (en To Review, esperando respuesta o detenida) y le pides algo desde otro ordenador, **ese ordenador la coge**: baja su rama de GitHub, crea el worktree y un agente nuevo sigue con la spec, los checkpoints, la actividad reciente y el `git log`.
- **Mergear** funciona desde cualquier ordenador (baja la rama de la tarjeta si hace falta). El que la tenía borra su worktree solo.
- Los proyectos sin remoto se ven en todos lados, pero sus tarjetas solo pueden trabajarse en el ordenador que tiene el repo.

En la cabecera, el icono de nube con el nombre de este ordenador indica que está sincronizado (en rojo si no llega a la base de datos; los cambios esperan y se suben al volver).

## Trabajar con otras personas

Puedes compartir **un proyecto concreto** con otra persona: los dos veis el mismo tablero, la actividad y el canal de agentes, y vuestros agentes ven las reservas de ficheros y las notas de los del otro. Tus demás proyectos no le llegan, ni los suyos a ti. No hay permisos: todos pueden hacer todo.

- **Tu nombre:** la primera vez, Trellai te pregunta cómo te llamas y tu color. Se ve en la cabecera, en las tarjetas que creas, en tus mensajes y en el canal. Si ya eres alguien en otro de tus ordenadores, elige «Soy …».
- **Sin hacer nada (repos privados de GitHub):** si tienes una base de datos para compartir (`TRELLAI_DATABASE_URL`), Trellai deja la invitación dentro del propio repo, en una referencia oculta (`refs/trellai/board`) que no se clona ni se ve en GitHub y que solo puede leer quien tenga acceso al repo. Cuando otra persona añade ese repo a su Trellai (o ya lo tenía), su Trellai la encuentra y se une sola: si ya tenía un tablero para ese repo, sus tarjetas pasan al compartido. Se comprueba al añadir un proyecto y cada 10 minutos. En los repos públicos no se publica. Se desactiva por proyecto en **Ajustes de proyecto → Compartir** (o en todo el ordenador con `TRELLAI_AUTOSHARE=0`).
- **Enlace de invitación:** en **Ajustes de proyecto → Compartir** tienes el enlace listo para copiar. Quien lo abra con su Trellai en marcha se une sola; si no, que pegue el código en **Unirse con código** (barra lateral o «Nuevo proyecto»). Si ya tiene clonado el mismo repo se enlaza solo; si no, el aviso del tablero le deja clonarlo o elegir la carpeta. Sin `TRELLAI_DATABASE_URL`, el panel te pide la URL de una base de datos por la que compartir.
- **Ojo:** la invitación (enlace, código o la del repo) lleva la URL de la base de datos **con su contraseña**. Trellai solo le sincroniza ese proyecto, pero con esa URL se podrían leer los demás que tengas en esa base de datos. Hay que configurarla en **cada ordenador** (lo que llega por una invitación no se reenvía a tus otros ordenadores).
- **Quién lo comparte:** en el mismo panel ves a cada persona, sus ordenadores, y puedes **Quitar** a alguien, **Salir** (si entraste con una invitación; no vuelves a entrar sola) o **Dejar de compartir** con todos (también quita la invitación del repo). Quien sale se queda con el tablero tal como estaba. Para cortar el acceso del todo, cambia la contraseña de esa base de datos.
- Las tarjetas siguen teniendo dueño por ordenador; la etiqueta muestra la persona y su ordenador (p. ej. «Ana · portatil-ana»).

Por dentro: cada fila de `trellai.rows` lleva su proyecto (`project`), y las conexiones de invitación (tabla local `sync_shares`) solo suben y bajan las filas de ese proyecto, más el nombre y color de quienes lo comparten (`people`, `members`).

## Ver esta rama

Botón **Ver esta rama** en la tarjeta (o tecla `v` en el tablero): Trellai pone tu repo principal en la rama de esa tarjeta (`git checkout --detach`), así tu servidor de desarrollo (Vite, Next…) recarga solo y ves la feature en el navegador sin reiniciar nada.

- Arriba sale una pastilla *Tu repo muestra: …* con el botón **Volver a main** (o pulsa `v` otra vez). Vuelve exactamente a la rama en la que estabas.
- Mientras la estás viendo, cada commit nuevo del agente se aplica automáticamente: ves los cambios según avanza.
- Necesita que tu repo no tenga cambios sin commitear en ficheros trackeados (si no, te avisa y no toca nada).
- Al mergear, borrar la tarjeta o usar Directo, Trellai vuelve antes a tu rama.
- Si la rama añade dependencias, puede que tengas que hacer `npm install`.

## Modelos: Claude y GPT

Cada agente puede usar **Claude** (con tu sesión de Claude Code) o **GPT** (con tu sesión de ChatGPT, a través de OpenAI Codex CLI).

- **Por proyecto** (botón ⚙ arriba): modelo para Desarrollo, Preparación, Asistente·Tarjetas, Asistente·Directo y **Tarjetas de interfaz** — si el Asistente marca una tarjeta como de interfaz/estética, se le asigna ese modelo automáticamente (p. ej. GPT para UI, Claude para lógica).
- **Por tarjeta**: selector de modelo en la cabecera de la tarjeta. En el tablero se ve una etiqueta (GPT, Opus…) cuando la tarjeta tiene uno propio.
- En las pestañas del Asistente también puedes cambiarlo al vuelo.
- Si cambias el modelo de una tarjeta a mitad, el nuevo agente recibe la spec, los checkpoints y mira el `git log` de la rama para seguir donde lo dejó el anterior.

Para usar GPT, instala Codex una vez:

```bash
npm i -g @openai/codex
codex login          # con tu cuenta de ChatGPT
```

`codex` por defecto usa el modelo de tu `~/.codex/config.toml`; en el selector puedes poner otro con "Otro modelo GPT…".

## Vista de proyectos

Tecla `p` (o "Todos los proyectos" en la barra lateral, o el logo): una tarjeta por proyecto con el reparto de tarjetas por columna, qué agentes están trabajando, qué te está esperando o está por revisar, la última actividad y los modelos que usa. `j`/`k` + `Enter` para entrar; `p` otra vez para volver al tablero.

## Teclado

Pulsa `?` para ver todos los atajos. Los principales:

- `⌘B` abre la barra de proyectos (`j`/`k` + `Enter`, o `1`–`9`); `[` y `]` saltan al proyecto anterior/siguiente.
- En el tablero: `h`/`l` columnas, `j`/`k` tarjetas, `Enter` abrir, `n` nueva tarjeta, `⇧H`/`⇧L` mover de columna, `⇧J`/`⇧K` reordenar, `x` eliminar (con confirmación).
- En los chats (Actividad, Asistente y Canal): `Enter` envía y `Shift+Enter` añade una línea. En **Apariencia y teclado** puedes elegir `Ctrl/⌘+Enter` para enviar y dejar `Enter` para escribir varias líneas.
- Al editar una spec: `Ctrl/⌘+Enter` guarda inmediatamente. Las transiciones de columna esperan a que se guarde la última versión.
- Con una tarjeta abierta: `1`/`2`/`3` pestañas, `e` editar spec, `c` checkpoint, `i` escribir al agente, `Esc` cerrar.

## Comodidad y apariencia

El botón **Apariencia y teclado** de la cabecera permite elegir tema **Claro**, **Oscuro** o **Sistema**, densidad **Cómoda** o **Compacta**, y cómo enviar mensajes. Se recuerda la preferencia en cada navegador.

El tablero tiene búsqueda por título y spec y filtros para tarjetas que te necesitan, pendientes de revisión o con errores. Puedes redimensionar el panel de tarjeta arrastrando su borde izquierdo (o enfocarlo con Tab y usar las flechas) y ampliarlo para leer. Las tarjetas en revisión abren el diff directamente.

**Fondo del tablero** (en los ajustes del proyecto, el botón de deslizadores): ninguno, un **color** (tinte suave) o una **imagen**. Con «Generar imagen», Codex (`codex exec` con tu login de ChatGPT) explora el repo, deduce de qué va el proyecto y dibuja un fondo apaisado y sin texto con su herramienta de imágenes; se guarda en `<repo>/.trellai/background.png`, solo en ese ordenador (en los demás se usa el color, si hay). Se puede cancelar y regenerar; si tu versión de Codex no genera imágenes, lo dice.

Los mensajes sin enviar y las specs pendientes de guardar conservan un borrador local. Al leer mensajes antiguos, los nuevos no desplazan la conversación; aparece un botón para volver al final. Crear una tarjeta requiere Enter o **Añadir**; salir del campo no la crea.

## Requisitos para Merged

El repo principal tiene que estar en la rama base (la que pusiste al crear el proyecto) y sin cambios sin commitear en ficheros trackeados. Si no, la tarjeta se queda en To Review y te dice por qué.

Los worktrees viven en `<repo>/.trellai/worktrees/` y se excluyen de git vía `.git/info/exclude`; no se modifica ningún fichero de tu repo.

## Configuración (variables de entorno)

Puedes ponerlas en un fichero `.env` en la carpeta de Trellai.

| Variable | Por defecto | |
|---|---|---|
| `PORT` | `4317` | |
| `HOST` | `127.0.0.1` | Ponlo a `0.0.0.0` para abrirlo desde el móvil en tu red. **Ojo:** los agentes tienen permisos completos. |
| `TRELLAI_MODEL` | el de tu Claude Code | modelo de Claude cuando el selector dice "Claude (por defecto)" |
| `TRELLAI_CODEX_BIN` | `codex` | ruta al CLI de Codex si no está en el PATH (un `.mjs` se ejecuta con node: Codex simulado en tests) |
| `TRELLAI_DB` | `data/trellai.db` | |
| `TRELLAI_DATABASE_URL` | — | Postgres (Supabase) para compartir el tablero entre ordenadores |
| `TRELLAI_MACHINE` | el hostname | nombre de este ordenador en el tablero |
| `TRELLAI_PUSH_BRANCHES` | `1` | `0` = no subir las ramas `trellai/*` |
| `TRELLAI_FAKE_AGENT` | — | `1` = agente simulado, sin gastar tokens (para probar el flujo) |

## Tests

```bash
npm test   # flujo completo contra un repo git real, con el agente simulado
TRELLAI_TEST_PG=postgres://… npm test   # + dos "ordenadores" compartiendo tablero y remoto
```

## Estructura

```
server/
  index.ts       API HTTP + SSE
  workflow.ts    qué pasa al entrar en cada columna y al terminar cada agente
  agents.ts      Claude Agent SDK, herramientas MCP (preguntas, notas…), hook de notas
  git.ts         worktrees, commit, rebase, merge
  remote.ts      fetch / pull / push con GitHub
  sync.ts        tablero compartido entre ordenadores (Postgres)
  db.ts          SQLite
  fake-agent.ts  agente simulado para tests
web/src/         React: tablero, panel de tarjeta, canal
shared/types.ts
```
