import type { Page } from "@cloudflare/puppeteer";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type FileChild,
  type ILevelsOptions,
} from "docx";

const MAX_DOCX_BLOCKS = 20_000;
const MAX_DOCX_CHARACTERS = 2_000_000;
const PAGE_WIDTH = 11_906;
const PAGE_HEIGHT = 16_838;
const PAGE_MARGIN = 1_440;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;

type DocxRunData = {
  text: string;
  break?: boolean;
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
};

type DocxParagraphData = {
  type: "paragraph";
  runs: DocxRunData[];
  heading?: number;
  quote?: boolean;
  alignment?: string;
  list?: { kind: "bullet" | "number"; id: number; level: number };
};

type DocxTableData = {
  type: "table";
  rows: Array<Array<{ runs: DocxRunData[]; header: boolean }>>;
};

type DocxBlockData = DocxParagraphData | DocxTableData;

async function extractDocumentBlocks(page: Page): Promise<DocxBlockData[]> {
  return page.evaluate((maxBlocks: number, maxCharacters: number) => {
    type PageNode = {
      nodeType: number;
      textContent: string | null;
      parentElement: PageElement | null;
    };
    type PageElement = PageNode & {
      tagName: string;
      innerText: string;
      childNodes: Iterable<PageNode>;
      children: Iterable<PageElement>;
      closest(selector: string): PageElement | null;
      getAttribute(name: string): string | null;
      querySelectorAll(selector: string): Iterable<PageElement>;
    };
    type PageStyle = {
      display: string;
      visibility: string;
      fontWeight: string;
      fontStyle: string;
      textDecorationLine: string;
      textAlign: string;
    };
    const pageWindow = globalThis as unknown as {
      document: {
        body: PageElement;
        querySelectorAll(selector: string): Iterable<PageElement>;
      };
      getComputedStyle(element: PageElement): PageStyle;
    };

    let blocks: DocxBlockData[] = [];
    let characterCount = 0;
    let nextListId = 1;
    let listIds = new Map<PageElement, number>();

    function isVisible(element: PageElement): boolean {
      for (let current: PageElement | null = element; current; current = current.parentElement) {
        let style = pageWindow.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    }

    // Must stay inside the callback because Puppeteer serializes this function into the browser.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function sameFormatting(left: DocxRunData, right: DocxRunData): boolean {
      return left.bold === right.bold && left.italics === right.italics &&
        left.underline === right.underline && left.strike === right.strike &&
        left.code === right.code && !left.break && !right.break;
    }

    function extractRuns(root: PageElement): DocxRunData[] {
      let runs: DocxRunData[] = [];
      function append(run: DocxRunData): void {
        let previous = runs.at(-1);
        if (previous && sameFormatting(previous, run)) {
          previous.text += run.text;
        } else {
          runs.push(run);
        }
      }
      function visit(node: PageNode): void {
        if (node.nodeType === 3) {
          let text = (node.textContent ?? "").replace(/\s+/g, " ");
          if (!text) return;
          let parent = node.parentElement;
          if (!parent) return;
          let style = pageWindow.getComputedStyle(parent);
          let weight = Number.parseInt(style.fontWeight, 10);
          append({
            text,
            bold: style.fontWeight === "bold" || weight >= 600 || undefined,
            italics: style.fontStyle === "italic" || undefined,
            underline: style.textDecorationLine.includes("underline") || undefined,
            strike: style.textDecorationLine.includes("line-through") || undefined,
            code: parent.closest("code,pre") !== null || undefined,
          });
          return;
        }
        if (node.nodeType !== 1) return;
        let element = node as PageElement;
        let tag = element.tagName.toUpperCase();
        if (tag === "BR") {
          runs.push({ text: "", break: true });
          return;
        }
        if (tag === "IMG") {
          let alt = element.getAttribute("alt")?.trim();
          if (alt) append({ text: `[${alt}]` });
          return;
        }
        if (element !== root && (tag === "UL" || tag === "OL" || tag === "TABLE")) return;
        for (let child of element.childNodes) visit(child);
      }
      visit(root);
      let firstText = runs.find(run => !run.break && run.text.length > 0);
      let lastText = runs.findLast(run => !run.break && run.text.length > 0);
      if (firstText) firstText.text = firstText.text.trimStart();
      if (lastText) lastText.text = lastText.text.trimEnd();
      return runs.filter(run => run.break || run.text.length > 0);
    }

    // Must stay inside the callback because Puppeteer serializes this function into the browser.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function countCharacters(block: DocxBlockData): number {
      if (block.type === "paragraph") {
        return block.runs.reduce((total, run) => total + run.text.length, 0);
      }
      return block.rows.flat(2).reduce(
        (total, cell) => total + cell.runs.reduce((sum, run) => sum + run.text.length, 0),
        0,
      );
    }

    function addBlock(block: DocxBlockData): void {
      characterCount += countCharacters(block);
      if (blocks.length >= maxBlocks || characterCount > maxCharacters) {
        throw new Error("This Gadget is too large to export as a Word document.");
      }
      blocks.push(block);
    }

    const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table";
    for (let element of pageWindow.document.querySelectorAll(blockSelector)) {
      if (!isVisible(element)) continue;
      let tag = element.tagName.toUpperCase();
      if (tag !== "TABLE" && element.parentElement?.closest("table")) continue;
      if ((tag === "P" || /^H[1-6]$/.test(tag) || tag === "PRE") &&
          element.parentElement?.closest("li,blockquote")) continue;

      if (tag === "TABLE") {
        let rows = Array.from(element.querySelectorAll("tr"))
          .filter(row => row.closest("table") === element)
          .map(row => Array.from(row.children)
            .filter(cell => cell.tagName === "TD" || cell.tagName === "TH")
            .filter(isVisible)
            .map(cell => ({
              runs: extractRuns(cell),
              header: cell.tagName === "TH",
            })))
          .filter(row => row.length > 0);
        if (rows.length > 0) addBlock({ type: "table", rows });
        continue;
      }

      let runs = extractRuns(element);
      if (runs.length === 0) continue;
      let style = pageWindow.getComputedStyle(element);
      let block: DocxParagraphData = {
        type: "paragraph",
        runs,
        alignment: style.textAlign,
      };
      if (/^H[1-6]$/.test(tag)) block.heading = Number(tag.slice(1));
      if (tag === "BLOCKQUOTE") block.quote = true;
      if (tag === "LI") {
        let list = element.parentElement?.closest("ul,ol");
        if (list) {
          let id = listIds.get(list);
          if (!id) {
            id = nextListId++;
            listIds.set(list, id);
          }
          let level = 0;
          for (let parent = list.parentElement?.closest("ul,ol"); parent;
               parent = parent.parentElement?.closest("ul,ol")) {
            ++level;
          }
          block.list = { kind: list.tagName === "OL" ? "number" : "bullet", id, level };
        }
      }
      addBlock(block);
    }

    if (blocks.length === 0) {
      for (let line of pageWindow.document.body.innerText.split(/\n+/)) {
        let text = line.trim();
        if (text) addBlock({ type: "paragraph", runs: [{ text }] });
      }
    }
    return blocks;
  }, MAX_DOCX_BLOCKS, MAX_DOCX_CHARACTERS);
}

function textRuns(runs: DocxRunData[], forceBold = false): TextRun[] {
  return runs.map(run => run.break
    ? new TextRun({ break: 1 })
    : new TextRun({
      text: run.text,
      bold: forceBold || run.bold,
      italics: run.italics,
      underline: run.underline ? { type: UnderlineType.SINGLE } : undefined,
      strike: run.strike,
      font: run.code ? "Courier New" : undefined,
    }));
}

function paragraphAlignment(value: string | undefined) {
  if (value === "center") return AlignmentType.CENTER;
  if (value === "right" || value === "end") return AlignmentType.RIGHT;
  if (value === "justify") return AlignmentType.JUSTIFIED;
  return AlignmentType.LEFT;
}

const HEADING_LEVELS = [
  undefined,
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function makeParagraph(block: DocxParagraphData): Paragraph {
  return new Paragraph({
    children: textRuns(block.runs),
    heading: block.heading ? HEADING_LEVELS[block.heading] : undefined,
    alignment: paragraphAlignment(block.alignment),
    numbering: block.list ? {
      reference: `${block.list.kind}-${block.list.id}`,
      level: Math.min(block.list.level, 8),
    } : undefined,
    border: block.quote ? {
      left: { style: BorderStyle.SINGLE, size: 12, color: "D1D5DB", space: 8 },
    } : undefined,
    indent: block.quote ? { left: 360 } : undefined,
  });
}

function makeTable(block: DocxTableData): Table {
  let columnCount = Math.max(...block.rows.map(row => row.length));
  let baseWidth = Math.floor(CONTENT_WIDTH / columnCount);
  let columnWidths = Array.from({ length: columnCount }, () => baseWidth);
  columnWidths[columnCount - 1] += CONTENT_WIDTH - baseWidth * columnCount;
  let border = { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" } as const;
  let borders = { top: border, bottom: border, left: border, right: border };

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths,
    rows: block.rows.map(row => new TableRow({
      tableHeader: row.some(cell => cell.header),
      children: columnWidths.map((width, index) => {
        let cell = row[index] ?? { runs: [], header: false };
        return new TableCell({
          width: { size: width, type: WidthType.DXA },
          borders,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          shading: cell.header ? { fill: "E8EEF5", type: ShadingType.CLEAR } : undefined,
          children: [new Paragraph({ children: textRuns(cell.runs, cell.header) })],
        });
      }),
    })),
  });
}

function numberingLevels(kind: "bullet" | "number"): ILevelsOptions[] {
  const bullets = ["•", "◦", "▪"];
  return Array.from({ length: 9 }, (_value, level) => ({
    level,
    format: kind === "bullet" ? LevelFormat.BULLET : LevelFormat.DECIMAL,
    text: kind === "bullet" ? bullets[level % bullets.length] : `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
  }));
}

/** Converts the visible, print-mode Gadget document into a DOCX stream. */
export async function createGadgetDocxStream(
  page: Page,
  documentTitle: string,
): Promise<ReadableStream<Uint8Array>> {
  let blocks = await extractDocumentBlocks(page);
  let listReferences = new Map<string, "bullet" | "number">();
  for (let block of blocks) {
    if (block.type === "paragraph" && block.list) {
      listReferences.set(`${block.list.kind}-${block.list.id}`, block.list.kind);
    }
  }
  let children: FileChild[] = blocks.map(block =>
    block.type === "paragraph" ? makeParagraph(block) : makeTable(block));
  let document = new Document({
    title: documentTitle,
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22 },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
      },
    },
    numbering: {
      config: Array.from(listReferences, ([reference, kind]) => ({
        reference,
        levels: numberingLevels(kind),
      })),
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
          margin: { top: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN },
        },
      },
      children,
    }],
  });
  return (await Packer.toBlob(document)).stream();
}
