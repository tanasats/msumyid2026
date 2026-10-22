/**
 * ลายนิรภัย (guilloché) แบบที่พิมพ์บนธนบัตร ประกาศนียบัตร และเอกสารสำคัญ — ตกแต่งเท่านั้น (aria-hidden)
 * ลายนี้คือองค์ประกอบเด่นเพียงหนึ่งเดียวของระบบ ใช้เฉพาะหน้าสาธารณะ (login, /verify) อย่าใส่ทุกหน้า
 * สีตามข้อความของตัวที่ครอบ (stroke = currentColor) — ใช้กับ text-ornament
 */

type Band = {
  /** รัศมีกลางของวง */
  radius: number;
  /** ความสูงของคลื่น */
  amplitude: number;
  /** จำนวนลูกคลื่นต่อรอบ */
  waves: number;
  /** จำนวนเส้นที่เหลื่อมเฟสกัน — ยิ่งมากยิ่งเป็นตาข่ายถี่ */
  strands: number;
};

const BANDS: Band[] = [
  { radius: 86, amplitude: 6, waves: 36, strands: 8 },
  { radius: 60, amplitude: 8, waves: 24, strands: 8 },
  { radius: 34, amplitude: 9, waves: 12, strands: 6 },
];

const STEPS = 720;

/** เส้นคลื่นรอบวง: รัศมี = radius + amplitude·sin(waves·t + phase) */
function wavyRing({ radius, amplitude, waves }: Band, phase: number) {
  let d = '';
  for (let i = 0; i <= STEPS; i += 1) {
    const t = (i / STEPS) * Math.PI * 2;
    const r = radius + amplitude * Math.sin(waves * t + phase);
    d += `${i === 0 ? 'M' : 'L'}${(r * Math.cos(t)).toFixed(2)} ${(r * Math.sin(t)).toFixed(2)}`;
  }
  return `${d}Z`;
}

// คำนวณครั้งเดียวตอนโหลด module (ลายคงที่)
const PATHS = BANDS.flatMap((band) =>
  Array.from({ length: band.strands }, (_, k) => wavyRing(band, (k / band.strands) * Math.PI)),
);

export function SecurityPattern({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="-100 -100 200 200"
      aria-hidden
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={0.35}
      className={className}
    >
      {PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
      <circle r={97} strokeWidth={0.6} />
      <circle r={22} strokeWidth={0.6} />
    </svg>
  );
}
