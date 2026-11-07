import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
await mkdir(".secrets", { recursive: true, mode: 0o700 });
try {
  await access(".secrets/bindings.json");
  throw new Error(
    "Secrets already exist; use Wrangler secrets to rotate them explicitly.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const password = randomBytes(30).toString("base64url");
const secrets = {
  AUTH_PASSWORD_HASH: createHash("sha256").update(password).digest("hex"),
  AUTH_SIGNING_KEY: randomBytes(48).toString("base64url"),
};
await writeFile(".secrets/bindings.json", JSON.stringify(secrets), {
  mode: 0o600,
  flag: "wx",
});
await writeFile(
  ".secrets/access.txt",
  `网页浏览器访问密码\n\n${password}\n\n入口：https://zxabinbina.cc.cd/tools/web-browser\n有效期：每次解锁一小时。\n此文件包含私密信息，请勿提交或分享。\n`,
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  ".dev.vars",
  Object.entries(secrets)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Generated secret files with owner-only permissions. Password was not printed.",
);
