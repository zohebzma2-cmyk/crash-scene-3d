import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("pdf.js for older Safari (iOS 17 and 18)", () => {
  it("loads the legacy page and worker builds, never the modern ones", () => {
    const src = read("../src/services/pdfPreview.ts");
    expect(src).toContain('"pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"');
    expect(src).toContain('import("pdfjs-dist/legacy/build/pdf.mjs")');
    expect(src).not.toMatch(/pdfjs-dist\/build\//);
    expect(src).not.toMatch(/from "pdfjs-dist"|(?<!typeof )import\("pdfjs-dist"\)/);
  });

  it("the legacy builds define the newer built-ins pdf.js calls (the modern build leaves them to the browser)", () => {
    for (const rel of ["../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs", "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"]) {
      const code = read(rel);
      expect(code, rel).toMatch(/getOrInsertComputed\s*:\s*function/);
      expect(code, rel).toMatch(/sumPrecise\s*:\s*function/);
      expect(code, rel).toMatch(/toBase64\s*:\s*function/);
    }
    expect(read("../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs")).not.toMatch(/getOrInsertComputed\s*:\s*function/);
  });
});
