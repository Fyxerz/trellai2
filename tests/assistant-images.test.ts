/**
 * Images on messages to the project assistant: the block the agent gets, Codex, and attaching them to cards.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "trellai-assistant-images-"));
process.env.TRELLAI_DB = join(dir, "t.db");
const repo = join(dir, "repo");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let db: typeof import("../server/db");
let att: typeof import("../server/attachments");
let assistant: typeof import("../server/assistant");
let projectId: string;
let otherId: string;

beforeAll(async () => {
  db = await import("../server/db");
  att = await import("../server/attachments");
  assistant = await import("../server/assistant");
  mkdirSync(repo, { recursive: true });
  projectId = db.createProject({ name: "p", repo_path: repo, base_branch: "main" }).id;
  otherId = db.createProject({ name: "otro", repo_path: repo, base_branch: "main" }).id;
});

describe("withAssistantImages", () => {
  it("leaves messages without images alone", () => {
    expect(att.withAssistantImages(projectId, "plan", repo, "hola")).toBe("hola");
  });

  it("writes the images and lists their files and uids for the agent", () => {
    const img = db.addAssistantImage(projectId, "plan", { name: "Cabecera.png", mime: "image/png", data: PNG });
    const shown = `Mira esto\n\n${att.assistantImageMarkdown(img)}`;
    const text = att.withAssistantImages(projectId, "plan", repo, shown);
    const file = join(att.assistantImagesDir(repo, "plan"), `${img.uid}-cabecera.png`);

    expect(text.startsWith(shown)).toBe(true);
    expect(text).toContain("Read tool");
    expect(text).toContain(`\`${file}\``);
    expect(text).toContain(`uid: \`${img.uid}\``);
    expect(readFileSync(file).toString("base64")).toBe(PNG);
    expect(att.withoutAssistantImages(text)).toBe("Mira esto");

    const codex = att.assistantForCodex(`Pedro says:\n${text}`, repo, "plan");
    expect(codex.images).toEqual([file]);
    expect(codex.prompt).not.toContain("Read tool");
  });

  it("ignores images from another project", () => {
    const img = db.addAssistantImage(otherId, "do", { name: "x.png", mime: "image/png", data: PNG });
    const shown = att.assistantImageMarkdown(img);
    expect(att.withAssistantImages(projectId, "do", repo, shown)).toBe(shown);
    expect(existsSync(join(att.assistantImagesDir(repo, "do"), `${img.uid}-x.png`))).toBe(false);
  });
});

describe("assistant toolkit", () => {
  it("attaches the message's images to the cards it creates or updates", () => {
    const a = db.addAssistantImage(projectId, "plan", { name: "uno.png", mime: "image/png", data: PNG });
    const b = db.addAssistantImage(projectId, "plan", { name: "dos.webp", mime: "image/webp", data: PNG });
    const foreign = db.addAssistantImage(otherId, "plan", { name: "ajena.png", mime: "image/png", data: PNG });
    const kit = assistant.makeAssistantToolkit(projectId, "plan");

    kit.createCards([{ title: "Con imagen", spec: "", images: [a.uid, foreign.uid, "nope"] }]);
    const card = db.listCards(projectId).find((c) => c.title === "Con imagen")!;
    const list = db.listAttachments(card.id);
    expect(list.map((x) => x.name)).toEqual(["uno.png"]);
    expect(db.attachmentData(list[0].id)).toBe(PNG);

    kit.updateCard(card.id, { images: [b.uid] });
    expect(db.listAttachments(card.id).map((x) => [x.name, x.mime])).toEqual([
      ["uno.png", "image/png"],
      ["dos.webp", "image/webp"],
    ]);
  });
});
