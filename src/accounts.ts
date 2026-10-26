import { randomBytes, scrypt, timingSafeEqual, randomUUID } from "node:crypto";
import type { WebAccount } from "./store.ts";
import type { Role } from "./policies.ts";

const derive = (password: string, salt: string) => new Promise<Buffer>((accept,reject) => {
  scrypt(password,salt,64,(error,key) => error ? reject(error) : accept(key));
});
export async function createAccount(username: string, password: string, role: Role): Promise<WebAccount> {
  if (password.length < 10 || password.length > 200) throw new Error("Account passwords must contain 10–200 characters");
  const salt = randomBytes(16).toString("hex");
  return { username, role, salt, hash: (await derive(password,salt)).toString("hex"), version: randomUUID() };
}
export async function verifyAccount(account: WebAccount, password: string): Promise<boolean> {
  const expected = Buffer.from(account.hash,"hex"), actual = await derive(password,account.salt);
  return expected.length === actual.length && timingSafeEqual(expected,actual);
}
