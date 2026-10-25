import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { degrees, drawImage, drawText, rgb, type PDFDocument, type PDFOperator, type PDFPage, type PDFRef } from 'pdf-lib';

// ลายมือชื่อแบบมองเห็น (docs/design/document-signing.md ระยะ D2): ภาพลายเซ็นด้านบน + บรรทัดข้อความใต้ภาพ
// ตำแหน่งมาจากหน้าเว็บเป็นสัดส่วนของหน้า "ตามที่แสดงผล" (หมุนตาม /Rotate แล้ว, จุดเริ่มมุมซ้ายบน) — แปลงเป็นพิกัด PDF ที่นี่

/** ตำแหน่งบนหน้า: page เริ่มที่ 1, x/y/w/h เป็นสัดส่วน 0–1 ของหน้าที่แสดงผล (มุมซ้ายบน) */
export type AppearancePlacement = { page: number; x: number; y: number; w: number; h: number };

export type AppearanceContent = {
  /** ภาพลายเซ็น PNG — null = ข้อความอย่างเดียว */
  image: Buffer | null;
  /** บรรทัดข้อความใต้ภาพ — null = ไม่แสดงข้อความ (ต้องมีภาพหรือข้อความอย่างน้อยหนึ่งอย่าง) */
  lines: string[] | null;
};

/** ฟอนต์ Sarabun (SIL OFL 1.1 — assets/fonts/OFL.txt) — dev: apps/api/assets, image: /app/assets */
const FONT_CANDIDATES = ['../../../assets/fonts/Sarabun-Regular.ttf', '../../../../assets/fonts/Sarabun-Regular.ttf'];
let fontBytes: Buffer | null = null;

function sarabun(): Buffer {
  if (!fontBytes) {
    const found = FONT_CANDIDATES.map((p) => fileURLToPath(new URL(p, import.meta.url))).find((p) => existsSync(p));
    if (!found) throw new Error('ไม่พบไฟล์ฟอนต์ Sarabun-Regular.ttf (assets/fonts)');
    fontBytes = readFileSync(found);
  }
  return fontBytes;
}

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "ลงนามดิจิทัลโดย <ชื่อ>" + "25 ต.ค. 2569 14:30 น." (พ.ศ. เวลาไทย) — สร้างจากฐานข้อมูล ผู้ใช้แก้ไม่ได้ (ตัดสินใจ 2026-10-25) */
export function appearanceLines(signerName: string, signingTime: Date): string[] {
  const parts = Object.fromEntries(dateTimeFormatter.formatToParts(signingTime).map((p) => [p.type, p.value]));
  return [`ลงนามดิจิทัลโดย ${signerName}`, `${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute} น.`];
}

export type PlacedAppearance = {
  /** [x1, y1, x2, y2] ในพิกัดของหน้า PDF (ก่อนหมุน) */
  rect: [number, number, number, number];
  /** ขนาดกล่องตามที่แสดงผล (point) = BBox ของ appearance */
  width: number;
  height: number;
  /** หมุนเนื้อหาให้ตั้งตรงเมื่อหน้าแสดงผลแบบหมุน */
  matrix: [number, number, number, number, number, number];
};

const MATRIX_BY_ROTATION: Record<number, PlacedAppearance['matrix']> = {
  0: [1, 0, 0, 1, 0, 0],
  90: [0, 1, -1, 0, 0, 0],
  180: [-1, 0, 0, -1, 0, 0],
  270: [0, -1, 1, 0, 0, 0],
};

/**
 * แปลงกล่องจากหน้าที่แสดงผล (เหมือน viewport ของ pdf.js: CropBox + /Rotate ตามเข็มนาฬิกา, y ชี้ลง) เป็น Rect ของ PDF
 * แต่ละมุมของกล่อง (u, v) แปลงตามมุมหมุน แล้วใช้กรอบที่ครอบทั้ง 4 มุม
 */
export function placeAppearance(page: PDFPage, placement: AppearancePlacement): PlacedAppearance {
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const matrix = MATRIX_BY_ROTATION[rotation];
  if (!matrix) throw new Error(`มุมหมุนของหน้าไม่รองรับ: ${rotation}`);
  const crop = page.getCropBox();
  const [displayW, displayH] = rotation % 180 === 0 ? [crop.width, crop.height] : [crop.height, crop.width];

  const toPdf = (u: number, v: number): [number, number] => {
    switch (rotation) {
      case 0:
        return [crop.x + u, crop.y + crop.height - v];
      case 90:
        return [crop.x + v, crop.y + u];
      case 180:
        return [crop.x + crop.width - u, crop.y + v];
      case 270:
        return [crop.x + crop.width - v, crop.y + crop.height - u];
    }
  };
  const u0 = placement.x * displayW;
  const v0 = placement.y * displayH;
  const width = placement.w * displayW;
  const height = placement.h * displayH;
  const corners = [toPdf(u0, v0), toPdf(u0 + width, v0 + height)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], width, height, matrix };
}

/** สัดส่วนความสูงของส่วนข้อความเมื่อมีทั้งภาพและข้อความ */
const TEXT_SHARE = 0.32;
const LINE_HEIGHT = 1.25;

/**
 * สร้าง appearance stream (Form XObject) ขนาดเท่ากล่องที่แสดงผล: ภาพแบบ contain อยู่ส่วนบน ข้อความกึ่งกลางอยู่ส่วนล่าง
 * ขนาดตัวอักษรปรับให้ทุกบรรทัดพอดีความกว้างและความสูงของส่วนข้อความ
 * ฝังฟอนต์ทั้งไฟล์ (ไม่ subset — การ subset ของ pdf-lib ทำ glyph ภาษาไทยที่ผ่าน GSUB หายได้) เพิ่มขนาดไฟล์ราว 90 KB
 */
export async function buildAppearanceStream(doc: PDFDocument, placed: PlacedAppearance, content: AppearanceContent): Promise<PDFRef> {
  const { width, height } = placed;
  const operators: PDFOperator[] = [];
  const resources: { XObject?: Record<string, PDFRef>; Font?: Record<string, PDFRef> } = {};
  const textHeight = content.lines ? (content.image ? height * TEXT_SHARE : height) : 0;
  const zero = degrees(0);

  if (content.image) {
    const image = await doc.embedPng(content.image);
    const areaH = height - textHeight;
    const scale = Math.min(width / image.width, areaH / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    operators.push(...drawImage('Img', { x: (width - w) / 2, y: textHeight + (areaH - h) / 2, width: w, height: h, rotate: zero, xSkew: zero, ySkew: zero }));
    resources.XObject = { Img: image.ref };
  }

  if (content.lines) {
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(sarabun(), { subset: false });
    const usableW = width * 0.96;
    const size = Math.min(
      textHeight / (content.lines.length * LINE_HEIGHT),
      ...content.lines.map((line) => usableW / font.widthOfTextAtSize(line, 1)),
    );
    const lineH = size * LINE_HEIGHT;
    // บล็อกข้อความกึ่งกลางแนวตั้งในส่วนข้อความ — baseline ห่างจากขอบล่างของบรรทัดราว 0.3 ของขนาดตัวอักษร
    let y = (textHeight + content.lines.length * lineH) / 2 - lineH + size * 0.3;
    for (const line of content.lines) {
      const x = (width - font.widthOfTextAtSize(line, size)) / 2;
      operators.push(...drawText(font.encodeText(line), { color: rgb(0.12, 0.12, 0.12), font: 'F', size, x, y, rotate: zero, xSkew: zero, ySkew: zero }));
      y -= lineH;
    }
    resources.Font = { F: font.ref };
  }

  const stream = doc.context.formXObject(operators, {
    BBox: [0, 0, width, height],
    Matrix: placed.matrix,
    Resources: resources,
  });
  return doc.context.register(stream);
}
