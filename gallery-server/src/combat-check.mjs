import test from "node:test";
import assert from "node:assert/strict";
import { advanceBolt, knockPlayer, playerHitFraction, respawnPlayer, segmentHits, validAim } from "./combat.mjs";
test("validates finite normalized teacher aim messages",()=>{
 assert.equal(validAim({shotId:"x",dx:1,dy:0,dz:0}),null);
 assert.equal(validAim({shotId:"123e4567-e89b-12d3-a456-426614174000",dx:1,dy:0,dz:0}).dx,1);
 assert.equal(validAim({shotId:"123e4567-e89b-12d3-a456-426614174000",dx:2,dy:0,dz:0}),null);
 assert.equal(validAim({shotId:"123e4567-e89b-12d3-a456-426614174000",dx:0.6,dy:0.8,dz:0}),null);
 assert.equal(validAim({shotId:"not-a-uuid",dx:1,dy:0,dz:0}),null);
});
test("bolts advance in bounded segments, hit the nearest segment volume and stop at range",()=>{
 const bolt={x:0,y:0,z:0,dx:0,dy:0,dz:1,travelled:0}; const path=advanceBolt(bolt,.1);
 assert.equal(path.to.z,2); assert.equal(segmentHits(path.from,path.to,{x:0,y:0,z:1}),true);
 assert.equal(segmentHits(path.from,path.to,{x:5,y:0,z:1}),false);
 assert.equal(playerHitFraction({x:0,y:2.9,z:-1},{x:0,y:2.9,z:1},{x:0,z:0},0),null);
 assert.notEqual(playerHitFraction({x:0,y:2.9,z:-1},{x:0,y:2.9,z:1},{x:0,z:0},1.125),null);
 bolt.travelled=29.9; const final=advanceBolt(bolt,.1); assert.equal(final.expired,true); assert.ok(Math.abs(Math.hypot(final.to.x-final.from.x,final.to.y-final.from.y,final.to.z-final.from.z)-.1)<1e-9);
});
test("students fall once, recover in ten seconds and receive three seconds of protection",()=>{
 const student={role:"student",knocked:false,respawnAt:0,protectedUntil:0,x:5,z:5,rotation:1,movementEpoch:0};
 assert.equal(knockPlayer({...student,role:"teacher"},0),false);
 assert.equal(knockPlayer(student,100),true); assert.equal(knockPlayer(student,200),false);
 assert.equal(respawnPlayer(student,10099),false); assert.equal(respawnPlayer(student,10100),true);
 assert.equal(student.x,0); assert.equal(student.z,0); assert.equal(student.movementEpoch,2);
 assert.equal(knockPlayer(student,12000),false); assert.equal(knockPlayer(student,14101),true);
});
