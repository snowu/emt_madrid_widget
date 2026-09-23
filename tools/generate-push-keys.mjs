// Write once to an ignored file; never print private key material.
import { writeFile } from "node:fs/promises";
const path = process.argv[2];
if (!path) throw new Error("Usage: node tools/generate-push-keys.mjs <private-output.json>");
const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateKey = await crypto.subtle.exportKey("jwk", key.privateKey);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey)).toString("base64url");
await writeFile(path, JSON.stringify({
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: privateKey.d,
  VAPID_SUBJECT: "https://snowu.github.io/emt_madrid_widget/",
}), { mode: 0o600, flag: "wx" });
console.log("Push keys created. Keep the private file secret and preserve the keys across deployments.");
