import { hostname } from "node:os";

/** This computer's name: who owns a card's worktree and running agent. */
export const MACHINE = (process.env.TRELLAI_MACHINE || hostname().replace(/\.local$/, "")).trim() || "este-ordenador";
