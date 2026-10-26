/**
 * ทำพื้นหลังของภาพลายเซ็นให้โปร่งใส (ภาพสแกน/ถ่ายจากกระดาษมีพื้นขาวทึบ บังเนื้อหาเอกสารเมื่อวางบน PDF)
 * แก้ข้อมูล RGBA ในที่ (ImageData.data) — แยกจาก canvas เพื่อให้ทดสอบได้
 *
 * - ภาพที่มีส่วนโปร่งใสอยู่แล้ว (ทำพื้นใสมาเอง) → ไม่แตะ
 * - สีพื้น = ค่ามัธยฐานความสว่างของ pixel รอบขอบภาพ (กระดาษถ่ายรูปมักเป็นเทา ไม่ขาวสนิท)
 * - pixel ที่สว่างใกล้สีพื้น → โปร่งใส, เข้มกว่าพื้นมาก → ทึบเหมือนเดิม, ช่วงกลาง → ไล่ความโปร่งใส (ขอบเส้นไม่แตก)
 * คืน true ถ้าแก้ภาพ
 */
export function makeBackgroundTransparent(data: Uint8ClampedArray, width: number, height: number): boolean {
  const pixels = width * height;
  let translucent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 250) translucent++;
  // มีส่วนโปร่งใสเกิน 1% = ผู้ใช้ทำพื้นใสมาแล้ว
  if (translucent > pixels * 0.01) return false;

  const luminance = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(luminance(x * 4), luminance(((height - 1) * width + x) * 4));
  for (let y = 0; y < height; y++) border.push(luminance(y * width * 4), luminance((y * width + width - 1) * 4));
  border.sort((a, b) => a - b);
  const background = border[Math.floor(border.length / 2)]!;
  // พื้นมืด (ลายเซ็นสีขาวบนพื้นดำ ฯลฯ) — แยกไม่ได้แน่ชัด ไม่แตะ
  if (background < 128) return false;

  // สว่างกว่า opaqueBelow + ช่วงไล่ = โปร่งใสทั้งหมด
  const transparentAbove = background - 12;
  const opaqueBelow = background - 72;
  for (let i = 0; i < data.length; i += 4) {
    const l = luminance(i);
    if (l >= transparentAbove) data[i + 3] = 0;
    else if (l > opaqueBelow) data[i + 3] = Math.round((data[i + 3]! * (transparentAbove - l)) / (transparentAbove - opaqueBelow));
  }
  return true;
}
