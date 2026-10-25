import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", dns, { cert, bucket: site });

export async function f0() {
  return {};
}
export async function f1() {
  return {};
}
export async function f2() {
  return {};
}
export async function f3() {
  return {};
}
export async function f4() {
  return {};
}
export async function f5() {
  return {};
}
export async function f6() {
  return {};
}
export async function f7() {
  return {};
}
export async function f8() {
  return {};
}
export async function f9() {
  return {};
}
export async function f10() {
  return {};
}
export async function f11() {
  return {};
}
export async function f12() {
  return {};
}
export async function f13() {
  return {};
}
export async function f14() {
  return {};
}
export async function f15() {
  return {};
}
export async function f16() {
  return {};
}
export async function f17() {
  return {};
}
export async function f18() {
  return {};
}
export async function f19() {
  return {};
}
export async function f20() {
  return {};
}
export async function f21() {
  return {};
}
export async function f22() {
  return {};
}
export async function f23() {
  return {};
}
export async function f24() {
  return {};
}
export async function f25() {
  return {};
}

new FunctionRouter("aws", { cdn })
  .url("GET", "/r0", f0)
  .url("GET", "/r1", f1)
  .url("GET", "/r2", f2)
  .url("GET", "/r3", f3)
  .url("GET", "/r4", f4)
  .url("GET", "/r5", f5)
  .url("GET", "/r6", f6)
  .url("GET", "/r7", f7)
  .url("GET", "/r8", f8)
  .url("GET", "/r9", f9)
  .url("GET", "/r10", f10)
  .url("GET", "/r11", f11)
  .url("GET", "/r12", f12)
  .url("GET", "/r13", f13)
  .url("GET", "/r14", f14)
  .url("GET", "/r15", f15)
  .url("GET", "/r16", f16)
  .url("GET", "/r17", f17)
  .url("GET", "/r18", f18)
  .url("GET", "/r19", f19)
  .url("GET", "/r20", f20)
  .url("GET", "/r21", f21)
  .url("GET", "/r22", f22)
  .url("GET", "/r23", f23)
  .url("GET", "/r24", f24)
  .url("GET", "/r25", f25);
