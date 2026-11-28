import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import browser from "../apps/desktop/electron/beike/browser.cjs";

const output = fileURLToPath(new URL("../output/", import.meta.url));
export const listingURL = browser.listingURL;
export const launch = (profile, headless = false) =>
  browser.launch(output, profile, headless);
export async function probe(page, city, number) {
  const result = await browser.runPage(page, "detail", { city, number });
  return result.houses[0];
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const [city, number] = process.argv.slice(2);
  listingURL(city, number);
  const context = await launch(path.join(output, "beike-browser-feasibility"));
  try {
    const listing = await probe(
      context.pages()[0] ?? (await context.newPage()),
      city,
      number,
    );
    console.log(JSON.stringify(listing, null, 2));
  } finally {
    await context.close();
  }
}
