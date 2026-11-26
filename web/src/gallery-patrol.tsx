import { useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { jailCell, type PatrolSettings, type WantedRank } from "../../gallery-server/src/patrol.mjs";
import { vehicleKinds } from "../../gallery-server/src/vehicles.mjs";
import { vehicleNames } from "./gallery-vehicles";

export type WantedEntry = WantedRank & { name: string };
export type OfficerView = { x: number; z: number; rotation: number; walking: boolean; targetId: string; kind?: "foot" | "car" };

export function MostWanted({ entries, targetId }: { entries: WantedEntry[]; targetId: string }) {
  return <section className="gallery-management gallery-wanted" aria-label="Most Wanted">
    <strong>Most Wanted · สายตรวจ</strong>
    {entries.length === 0 ? <p>ยังไม่มีผู้ถูกตามจับ</p> : <ol>{entries.map(({ id, name, count }) =>
      <li key={id}><span>{name} · {count} ครั้ง</span>{id === targetId && <b>กำลังตามจับ</b>}</li>)}</ol>}
  </section>;
}

export function PatrolSettingsForm({ settings, save }: { settings: PatrolSettings; save: (settings: PatrolSettings) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const jailFields = [
    { key: "baseSeconds", label: "เวลาขังครั้งแรก (วินาที)", min: 5, max: 120 },
    { key: "extraSeconds", label: "เพิ่มต่อการชนหรือยิงล้มอีกหนึ่งครั้ง (วินาที)", min: 1, max: 30 },
    { key: "maxSeconds", label: "เวลาขังสูงสุด (วินาที)", min: 5, max: 180 },
  ] as const;
  const fuelFields = [
    { key: "helicopterFuelSeconds", label: "น้ำมันเฮลิคอปเตอร์ (วินาที)", min: 5, max: 180 },
    { key: "broomFuelSeconds", label: "พลังงานไม้กวาดบิน (วินาที)", min: 5, max: 180 },
  ] as const;
  const hitFields = vehicleKinds.map((kind) => ({ key: kind, label: vehicleNames[kind], min: 1, max: 20 }));
  const groups = [["จำนวนครั้งที่ชนได้", hitFields], ["เวลาขัง", jailFields], ["เวลาบินต่อนักเรียนหนึ่งเที่ยว", fuelFields]] as const;
  return <form className="gallery-management" onSubmit={async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = Object.fromEntries([...hitFields, ...jailFields, ...fuelFields].map(({ key }) => [key, Number(form.get(key))])) as PatrolSettings;
    if (next.maxSeconds < next.baseSeconds) { setMessage("เวลาขังสูงสุดต้องไม่น้อยกว่าเวลาเริ่มต้น"); return; }
    setSaving(true); setMessage("");
    try {
      await save(next);
      setMessage("บันทึกแล้ว ใช้กับการขับขี่และการจับครั้งถัดไป");
    } catch (error) { setMessage(error instanceof Error ? error.message : "บันทึกการตั้งค่าไม่สำเร็จ"); }
    finally { setSaving(false); }
  }}>
    <strong>สายตรวจ เรือนจำ และยานพาหนะนักเรียน</strong>
    {groups.map(([title, fields]) => <fieldset key={title} className="gallery-access-mode gallery-shop-prices gallery-settings-group">
      <legend>{title}</legend>
      {fields.map(({ key, label, min, max }) => <label key={key}>{label}<input name={key} type="number" min={min} max={max} step={1} required inputMode="numeric" defaultValue={settings[key]} /></label>)}
    </fieldset>)}
    <button className="button button-quiet" disabled={saving}>บันทึกการตั้งค่าสายตรวจ</button>
    {message && <small role="status">{message}</small>}
  </form>;
}

export function createGalleryJail(label: THREE.Texture) {
  const jail = new THREE.Group();
  jail.position.set(jailCell.x, 0, jailCell.z);
  const steel = new THREE.MeshStandardMaterial({ color: 0x35505a, roughness: 0.8 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x758487, roughness: 0.93 });
  const steelParts: THREE.BufferGeometry[] = [];
  const bars = new THREE.BoxGeometry(0.07, 2.6, 0.07);
  const part = (geometry: THREE.BufferGeometry, x: number, y: number, z: number) => {
    steelParts.push(geometry.translate(x, y, z));
  };
  jail.add(new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.18, 3.8).translate(0, 0.08, 0), stone));
  part(new THREE.BoxGeometry(3.8, 2.7, 0.18), 0, 1.43, -1.6);
  for (const { x, z } of [{ x: -1.9, z: -1.6 }, { x: -1.9, z: 1.6 }, { x: 1.9, z: -1.6 }, { x: 1.9, z: 1.6 }]) {
    part(new THREE.BoxGeometry(0.15, 2.7, 0.15), x, 1.43, z);
  }
  for (let step = 1; step < 8; step++) {
    part(bars.clone(), -1.9 + step * 0.475, 1.43, 1.6);
    if (step < 7) for (const x of [-1.9, 1.9]) part(bars.clone(), x, 1.43, -1.6 + step * (3.2 / 7));
  }
  part(new THREE.BoxGeometry(3.97, 0.14, 3.35), 0, 2.78, 0);
  jail.add(new THREE.Mesh(mergeGeometries(steelParts), steel));
  bars.dispose();
  for (const geometry of steelParts) geometry.dispose();
  const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: label, transparent: true }));
  sign.scale.set(2.9, 0.48, 1);
  sign.position.y = 3.15;
  jail.add(sign);
  return jail;
}
