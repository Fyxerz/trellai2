import { useSyncExternalStore } from "react";
import type { Tag } from "../../shared/types";

/**
 * Dragging a tag from the tag manager onto a board card.
 *   hover:  the card under the pointer shows the tag as if it were already on it
 *   landed: the card that just got it plays a short "placed" animation
 */
interface TagDragState {
  hover: { tag: Tag; cardId: string } | null;
  landed: { tag: Tag; cardId: string; key: number } | null;
}

let state: TagDragState = { hover: null, landed: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<TagDragState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function setTagHover(hover: TagDragState["hover"]) {
  if (hover?.cardId === state.hover?.cardId && hover?.tag.id === state.hover?.tag.id) return;
  set({ hover });
}

let landedTimer: ReturnType<typeof setTimeout> | undefined;
export function tagLanded(tag: Tag, cardId: string) {
  clearTimeout(landedTimer);
  set({ hover: null, landed: { tag, cardId, key: Date.now() } });
  landedTimer = setTimeout(() => set({ landed: null }), 1200);
}

export function useTagDrag(): TagDragState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
