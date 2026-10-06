# เชื่อมต่อ ERP-HR มมส. — ดึงข้อมูลบุคลากร

หลังจาก Login สำเร็จและได้ Google Access Token แล้ว สามารถนำ Token นั้นไปเรียก API ระบบ ERP ของมหาวิทยาลัย เพื่อดึงข้อมูลบุคลากรเพิ่มเติม เช่น รหัสพนักงาน, ตำแหน่ง, คณะ, หน่วยงาน ฯลฯ ได้ทันที

---

### ขั้นตอนการทำงาน (Flow: Google Login → ERP StaffInfo)

1. **ผู้ใช้ Login ด้วย Google** → ได้ Access Token
2. **Backend นำ Access Token ไปเรียก ERP API** → ได้ข้อมูลบุคลากร
3. **นำข้อมูลไปแสดงหรือเก็บในฐานข้อมูล** ของระบบหน่วยงาน

```text
[ 🔐 Google Login ] 
       │
       ▼ (ได้ Access Token)
[ ⚙️ Backend ] 
       │
       ▼ (ส่ง Token ไป ERP)
[ 📋 ERP-HR API: erp.msu.ac.th ] 
       │
       ▼ 
[ 📦 ข้อมูลบุคลากร: staffid, ชื่อ, ตำแหน่ง ฯลฯ ]
```

---

### 1 — API Endpoint

| รายละเอียด | ค่า |
| :--- | :--- |
| **URL** | `https://erp.msu.ac.th/service/api/staffinfo` |
| **Method** | `GET` |
| **Auth Type** | `Bearer Token` |
| **Token** | Google Access Token ที่ได้จากขั้นตอน Login |
| **Response** | JSON — ข้อมูลบุคลากร |

---

### 2 — ตัวอย่าง Response จาก ERP

**Request:** `GET https://erp.msu.ac.th/service/api/staffinfo`

```json
{
  "status": true,
  "message": "Success",
  "data": {
    "staffid":           "1234567",
    "prefixid":          "003",
    "prefixfullname":    "นางสาว",
    "namefully":         "สมหญิง ตัวอย่าง",
    "staffname":         "สมหญิง",
    "staffsurname":      "ตัวอย่าง",
    "prefixinitialseng": "Ms.",
    "staffnameeng":      "Somying",
    "staffsurnameeng":   "Tuayang",
    "posnameth":         "นักวิชาการคอมพิวเตอร์",
    "facultyid":         "201092700000",
    "facultyname":       "สำนักงานอธิการบดี",
    "departmentid":      "201092704000",
    "departmentname":    "กองแผนงาน",
    "programid":         "201092704003",
    "programname":       "กลุ่มงานสารสนเทศเพื่อพัฒนาองค์กรสู่ความเป็นเลศ",
    "staffphone1":       "0800000000",
    "staffphone2":       null,
    "staffemail1":       "somying.t@msu.ac.th",
    "staffemail2":       "somying.t@msu.ac.th",
    "posadid":           null,
    "adhisposname":      null
  }
}
```

---

### 3 — ฟิลด์สำคัญที่ได้จาก ERP

| ฟิลด์ | คำอธิบาย | ตัวอย่าง |
| :--- | :--- | :--- |
| `staffid` | รหัสพนักงาน | `1234567` |
| `namefully` | คำนำหน้า + ชื่อ-นามสกุล (ภาษาไทย) | `สมหญิง ตัวอย่าง` |
| `staffnameeng` / `staffsurnameeng` | ชื่อ-นามสกุล (ภาษาอังกฤษ) | `Somying Tuayang` |
| `posnameth` | ตำแหน่ง | `นักวิชาการคอมพิวเตอร์` |
| `facultyname` | คณะ / สำนัก | `สำนักงานอธิการบดี` |
| `departmentname` | กอง / ฝ่าย | `กองแผนงาน` |
| `programname` | กลุ่มงาน / สาขา | `กลุ่มงานสารสนเทศเพื่อพัฒนาองค์กรสู่ความเป็นเลศ` |
| `staffphone1` | เบอร์โทรศัพท์ | `0800000000` |
| `staffemail1` | อีเมล | `somying.t@msu.ac.th` |