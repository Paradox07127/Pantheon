import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [driverPath, inputPath, resultPath] = process.argv.slice(2);
try {
  const driver = await import(pathToFileURL(driverPath).href);
  if (typeof driver.runCase !== "function") throw new Error("driver must export runCase");
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const result = await driver.runCase(input);
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
} catch (error) {
  console.error(error.stack || String(error));
  process.exitCode = error.code === "NOT_IMPLEMENTED" ? 2 : 1;
}
