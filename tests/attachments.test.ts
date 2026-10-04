/**
 * Images on a card: validation, and the "Imágenes" block the agents get in their prompt.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "trellai-attachments-"));
process.env.TRELLAI_DB = join(dir, "t.db");
const repo = join(dir, "repo");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let db: typeof import("../server/db");
let att: typeof import("../server/attachments");
let projectId: string;

beforeAll(async () => {
  db = await import("../server/db");
  att = await import("../server/attachments");
  mkdirSync(repo, { recursive: true });
  projectId = db.createProject({ name: "p", repo_path: repo, base_branch: "main" }).id;
});

describe("parseImage / cleanAnnotations", () => {
  it("accepts data URLs and plain base64 with a mime", () => {
    expect(att.parseImage(`data:image/png;base64,${PNG}`)).toEqual({ mime: "image/png", data: PNG });
    expect(att.parseImage(PNG, "image/webp")).toEqual({ mime: "image/webp", data: PNG });
    expect(() => att.parseImage("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(/Formato/);
    expect(() => att.parseImage("data:image/png;base64,no es base64!")).toThrow(/base64/);
  });

  it("clamps boxes to the image and drops empty ones", () => {
    const boxes = att.cleanAnnotations([{ x: 0.9, y: -1, w: 0.5, h: 0.3, comment: 7 }, { x: 0.2, y: 0.2, w: 0, h: 1 }, null]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 0.9, y: 0, h: 0.3, comment: "7" });
    expect(boxes[0].w).toBeCloseTo(0.1);
    expect(att.cleanAnnotations("nope")).toEqual([]);
  });
});

describe("attachmentsBlock", () => {
  it("is empty without images", () => {
    const card = db.createCard({ project_id: projectId, title: "Sin imágenes" });
    expect(att.attachmentsBlock(card, repo)).toBe("");
  });

  it("writes each image (and its drawn copy) and lists the regions", () => {
    const card = db.createCard({ project_id: projectId, title: "Con imágenes" });
    db.addAttachment(card.id, {
      name: "Cabecera.webp",
      mime: "image/webp",
      data: PNG,
      annotated: PNG,
      annotations: [
        { x: 0.1, y: 0.25, w: 0.5, h: 0.1, comment: "El título más grande" },
        { x: 0, y: 0, w: 0.2, h: 0.2, comment: "  " },
      ],
    });
    db.addAttachment(card.id, { name: "otra.png", mime: "image/png", data: PNG });

    const block = att.attachmentsBlock(card, repo);
    const folder = att.attachmentsDir(repo, card.id);
    const first = join(folder, "1-cabecera.webp");
    const drawn = join(folder, "1-cabecera.anotada.webp");
    const second = join(folder, "2-otra.png");

    expect(block).toMatch(/^## Imágenes/);
    expect(block).toContain("Read tool");
    expect(block).toContain(`### Imagen 1: Cabecera.webp`);
    expect(block).toContain(first);
    expect(block).toContain(drawn);
    expect(block).toContain("1. x 10%, y 25%, 50% × 10% — El título más grande");
    expect(block).toContain("2. x 0%, y 0%, 20% × 20% — (sin comentario)");
    expect(block).toContain(`### Imagen 2: otra.png`);
    expect(block).not.toContain("2-otra.anotada");
    expect(readFileSync(first).toString("base64")).toBe(PNG);
    expect(existsSync(drawn)).toBe(true);
    expect(existsSync(second)).toBe(true);

    // deleted images disappear from the folder next time
    db.deleteAttachment(db.listAttachments(card.id)[1].id);
    att.attachmentsBlock(card, repo);
    expect(existsSync(second)).toBe(false);
  });

  it("copies and cascades with the card, and travels with the sync", () => {
    const card = db.createCard({ project_id: projectId, title: "Origen" });
    const copy = db.createCard({ project_id: projectId, title: "Copia" });
    db.addAttachment(card.id, { name: "a.png", mime: "image/png", data: PNG, annotations: [{ x: 0, y: 0, w: 1, h: 1, comment: "todo" }] });
    db.copyAttachments(card.id, copy.id);
    const [c] = db.listAttachments(copy.id);
    expect(c).toMatchObject({ name: "a.png", annotations: [{ comment: "todo" }], has_annotated: false });
    expect(c.uid).toBeTruthy();
    expect(db.UID_TABLES).toContain("attachments");
    db.deleteCard(copy.id);
    expect(db.getAttachment(c.id)).toBeUndefined();
  });
});
