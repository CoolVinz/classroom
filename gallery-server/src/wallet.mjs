export const isRequestId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

export async function withStudentWallet(pool, auth, update) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const account = await tx.query("SELECT id FROM classroom.student_accounts WHERE id=$1 FOR UPDATE", [auth.accountId]);
    if (!account.rowCount) throw new Error("Student account was removed");
    const { rows: [world] } = await tx.query(`SELECT w.wand_price AS wand, w.license_price AS license
      FROM classroom.student_sessions ss
      JOIN classroom.students s ON s.account_id=ss.account_id
      JOIN classroom.classrooms c ON c.id=s.classroom_id
      JOIN classroom.gallery_worlds w ON w.classroom_id=c.id
      JOIN classroom.gallery_student_entry e ON e.classroom_id=c.id AND e.student_id=s.id AND e.account_id=ss.account_id
      WHERE ss.token_hash=$1 AND ss.account_id=$2 AND ss.expires_at>NOW() AND s.id=$3 AND s.classroom_id=$4
        AND s.archived_at IS NULL AND c.archived_at IS NULL AND e.entry_allowed AND w.enabled
      FOR SHARE OF s,c,w,ss`, [auth.sessionHash, auth.accountId, auth.studentId, auth.classroomId]);
    if (!world) throw new Error("Classroom access expired");
    const result = await update(tx, { wand: world.wand, license: world.license });
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { tx.release(); }
}

export async function readWallet(db, auth) {
  const { rows: [wallet] } = await db.query(`SELECT classroom.gallery_point_balance($1) AS balance,
    COALESCE(MAX(remaining) FILTER (WHERE item='wand'),0) AS spells,
    COALESCE(MAX(remaining) FILTER (WHERE item='license'),0)=1 AS license
    FROM classroom.gallery_purchases WHERE account_id=$1 AND classroom_id=$2 AND remaining>0`, [auth.accountId, auth.classroomId]);
  return wallet;
}

export async function readShop(db, classroomId) {
  const { rows: [prices] } = await db.query(`SELECT wand_price AS wand, license_price AS license
    FROM classroom.gallery_worlds WHERE classroom_id=$1`, [classroomId]);
  return prices;
}

export async function buyItem(tx, auth, { item, price, requestId }, prices, eligible) {
  const snapshot = await readWallet(tx, auth);
  const { rows: [prior] } = await tx.query(`SELECT item, classroom_id FROM classroom.gallery_purchases
    WHERE account_id=$1 AND request_id=$2`, [auth.accountId, requestId]);
  if (!eligible()) return { ok: false, message: "โปรดเข้าใกล้ร้านค้าก่อนซื้อ", wallet: snapshot, prices };
  let message;
  if (prior?.item === item && prior.classroom_id === auth.classroomId) return { ok: true, message: "บันทึกการซื้อแล้ว", wallet: snapshot, prices };
  if (prior) message = "รหัสการซื้อซ้ำ กรุณาลองใหม่";
  else if (price !== prices[item]) message = "ราคาเปลี่ยนแล้ว กรุณายืนยันราคาใหม่";
  else if (item === "wand" ? snapshot.spells > 0 : snapshot.license) message = "ใช้อุปกรณ์ที่มีอยู่ก่อนซื้อใหม่";
  else if (snapshot.balance < price) message = "แต้มโลกเสมือนไม่พอ";
  if (message) return { ok: false, message, wallet: snapshot, prices };
  const uses = item === "wand" ? 15 : 1;
  await tx.query(`INSERT INTO classroom.gallery_purchases(account_id,request_id,classroom_id,item,price,remaining)
    VALUES($1,$2,$3,$4,$5,$6)`, [auth.accountId, requestId, auth.classroomId, item, price, uses]);
  if (!eligible()) throw new Error("Shop visitor left");
  return { ok: true, message: "ซื้อสำเร็จ", prices, wallet: {
    balance: snapshot.balance - price, spells: item === "wand" ? uses : snapshot.spells, license: item === "license" || snapshot.license,
  } };
}

export async function useItem(tx, auth, item, requestId, eligible) {
  const { rows } = await tx.query(`UPDATE classroom.gallery_purchases p
    SET remaining=p.remaining-1, use_ids=array_append(p.use_ids,$4::uuid)
    WHERE p.account_id=$1 AND p.classroom_id=$2 AND p.item=$3 AND p.remaining>0
      AND NOT EXISTS (SELECT 1 FROM classroom.gallery_purchases prior
        WHERE prior.account_id=p.account_id AND $4::uuid=ANY(prior.use_ids))
    RETURNING p.remaining`, [auth.accountId, auth.classroomId, item, requestId]);
  if (!eligible()) throw new Error("Avatar is no longer eligible");
  return rows[0]?.remaining ?? null;
}
