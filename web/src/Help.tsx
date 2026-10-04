import { MOD, readPreference, useDialogFocus } from "./preferences";
const groups = (): { title: string; keys: [string, string][] }[] => [
  {
    title: "General",
    keys: [
      ["p", "Todos los proyectos (y volver)"],
      [`${MOD}+B`, "Abrir / cerrar la barra de proyectos"],
      ["[  ]", "Proyecto anterior / siguiente"],
      ["t", "Asistente: ideas → tarjetas"],
      ["d", "Directo: cambios pequeños sin tarjeta"],
      ["a", "Canal de agentes"],
      ["?", "Esta ayuda"],
      ["Esc", "Cerrar / salir del campo de texto"],
    ],
  },
  {
    title: "Proyectos (barra o vista de todos)",
    keys: [
      ["j  k", "Bajar / subir"],
      ["Enter  l", "Abrir proyecto"],
      ["1–9", "Ir al proyecto n"],
      ["n", "Nuevo proyecto"],
      ["Esc  h", "Volver al tablero"],
    ],
  },
  {
    title: "Tablero",
    keys: [
      ["h  l", "Columna izquierda / derecha"],
      ["j  k", "Tarjeta abajo / arriba"],
      ["g  G", "Primera / última tarjeta"],
      ["Enter  o", "Abrir tarjeta"],
      ["n", "Nueva tarjeta en la columna (o en Plan)"],
      ["⇧H  ⇧L", "Mover tarjeta a la columna anterior / siguiente"],
      ["⇧J  ⇧K", "Mover tarjeta abajo / arriba"],
      ["v", "Ver la rama de la tarjeta en tu repo / volver"],
      ["x", "Eliminar tarjeta (pide confirmación)"],
    ],
  },
  {
    title: "Tarjeta abierta",
    keys: [
      ["1  2  3", "Spec / Actividad / Diff"],
      ["e", "Editar spec"],
      ["c", "Añadir checkpoint"],
      ["i", "Escribir al agente"],
      [readPreference("send", "enter") === "mod" ? `${MOD}+Enter` : "Enter", "Enviar mensaje / pedir cambios"],
      ["Shift+Enter", "Nueva línea en el mensaje"],
      [`${MOD}+Enter`, "Guardar spec inmediatamente"],
    ],
  },
];

export function Help({ onClose }: { onClose: () => void }) {
  const ref = useDialogFocus();
  return (
    <div data-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Atajos de teclado" onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-zinc-900 p-5 ring-1 ring-ui-ink/[0.08] shadow-[var(--shadow-pop)]">
        <div className="mb-4 flex items-center">
          <h2 className="text-base font-semibold text-zinc-100">Atajos de teclado</h2>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {groups().map((g) => (
            <div key={g.title}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{g.title}</h3>
              <ul className="space-y-1.5">
                {g.keys.map(([k, d]) => (
                  <li key={k} className="flex items-baseline gap-3 text-sm">
                    <kbd className="w-20 shrink-0 font-mono text-xs text-indigo-300">{k}</kbd>
                    <span className="text-zinc-300">{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
